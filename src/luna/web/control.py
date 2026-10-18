"""
Control Center API — settings, connectors, sign-ins, permissions, stats and
routines for the browser's Control Center (web/src/components/control/).

BEGINNER MAP
------------
Plain JSON over HTTP under /api/control/ (the chat itself stays on /ws):

  GET   settings                    every setting, grouped (secrets masked)
  PATCH settings                    {"values": {field: value}, "remove_unknown": [KEY]} → .env
  GET   mcp                         servers in mcp_servers.json + load status
  PUT   mcp/{name}                  add / replace one server
  DELETE mcp/{name}                 remove one server
  GET   connections                 Google sign-in, mail, API keys
  POST  connections/google          start the Google consent flow (opens a browser tab)
  DELETE connections/google         sign out (delete the token)
  GET   providers                   providers, current and default model
  GET   providers/{id}/models       models the provider offers
  POST  providers/default           {"provider", "model", "apply"} → .env (+ switch now)
  GET   permissions                 every tool, who owns it, ask / auto / free
  GET   stats                       live numbers for the Overview
  GET   insights                    latest mail / agenda / to-do results (HUD widgets)
  GET   dashboard  · PUT dashboard  HUD widget preferences (data/dashboard.json)
  GET   routines   · POST routines  list / create
  PATCH routines/{id} · DELETE routines/{id}
  POST  routines/{id}/run           run now
  GET   routines/{id}/runs          run history
  GET   cron?expr=...               check a schedule: English + next runs

What happens after a settings save depends on the field (config/schema.py):
"live" fields are read fresh by the MCP servers, "rebuild" fields rebuild
the agent at once (AgentHost.reconfigure), "restart" fields are listed in
"restart_required" until luna-web restarts. Every tab gets
{"type": "settings_changed"} so open Control Centers refresh.

SECURITY: same Origin check as /ws and /api/tts (these routes can change
API keys and what runs without approval). Secrets are never sent back.

Read next: luna/config/schema.py, luna/routines/scheduler.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import resource
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from luna.agent.providers import PROVIDERS, describe_providers, get_provider, list_models
from luna.agent.sessions import list_sessions
from luna.agent.subagents import get_subagent_specs
from luna.cli.chat import agent_tool_names
from luna.config.schema import SettingsRejected, env_name, save_settings, settings_schema
from luna.config.settings import get_settings
from luna.integrations import google as google_auth
from luna.mcp.loader import is_risky_tool_name
from luna.routines.builtin import BUILTINS
from luna.routines.cron import CronError, describe, next_run, parse
from luna.routines.store import RoutineRefused

Handler = Callable[[Request], Awaitable[JSONResponse]]

_SERVER_NAME = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
HELPER_TAGS = ("assistant", "researcher", "files", "coder")
# Expensive numbers (scanning every checkpoint) are reused for this long.
SLOW_STATS_SECONDS = 30.0

DEFAULT_DASHBOARD: dict[str, Any] = {
    # Which HUD insight widgets show (they need their routine enabled).
    "widgets": {"mail": True, "agenda": True, "todos": True, "stats": False},
    "position": "bottom-left",  # bottom-left | bottom-right
    "style": "compact",  # compact (title + detail) | minimal (one line)
    "opacity": 0.75,  # 0.3 – 1
    "show_hints": True,  # the keyboard hint line under the dock
}
_POSITIONS = {"bottom-left", "bottom-right"}
_STYLES = {"compact", "minimal"}


# --- helpers -----------------------------------------------------------------

def _error(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def guarded(handler: Handler) -> Handler:
    """Refuse requests from browser origins that may not use this server."""

    async def wrapper(request: Request) -> JSONResponse:
        from luna.web.server import origin_allowed  # server imports this module

        settings = request.app.state.settings
        if not origin_allowed(request.headers.get("origin"), request.headers.get("host"), settings.web_allowed_origins):
            return _error("origin not allowed", 403)
        return await handler(request)

    wrapper.__name__ = handler.__name__
    wrapper.__doc__ = handler.__doc__
    return wrapper


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _host(request: Request) -> Any:
    return request.app.state.host


def _json_text(value: Any, indent: int = 0) -> str:
    """json.dumps(indent=2), but lists of plain values stay on one line,
    like the hand-written mcp_servers.json."""
    pad = "  " * (indent + 1)
    if isinstance(value, dict) and value:
        items = [f"{pad}{json.dumps(k)}: {_json_text(v, indent + 1)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + "  " * indent + "}"
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        items = [pad + _json_text(v, indent + 1) for v in value]
        return "[\n" + ",\n".join(items) + "\n" + "  " * indent + "]"
    return json.dumps(value, separators=(", ", ": "))


def _atomic_json(path: Path, data: Any) -> None:
    """Write JSON via a temp file + rename (never half a file)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(_json_text(data) + "\n", encoding="utf-8")
    tmp.replace(path)


def _merged(current: Any, saved: Any, fields: Any) -> Any:
    """``current`` with only ``fields`` taken from the freshly saved settings.

    The rest stays as luna-web started with it (e.g. values passed in code
    or by a test), instead of everything being re-read from .env."""
    return current.model_copy(update={f: getattr(saved, f) for f in fields})


def _restart_list(request: Request) -> list[str]:
    return sorted(request.app.state.pending_restart)


# --- settings ----------------------------------------------------------------

@guarded
async def get_settings_route(request: Request) -> JSONResponse:
    """Every setting with its current value (secrets masked)."""
    schema = settings_schema(_host(request).settings, request.app.state.env_path)
    return JSONResponse({**schema, "restart_required": _restart_list(request)})


async def _apply(request: Request, values: dict[str, Any], remove_unknown: list[str] | None = None) -> JSONResponse:
    """Save to .env, then rebuild / flag a restart as each field needs."""
    host = _host(request)
    try:
        saved, effects = save_settings(request.app.state.env_path, values, remove_unknown)
    except SettingsRejected as exc:
        return _error(str(exc))
    get_settings.cache_clear()
    new_settings = _merged(host.settings, saved, effects)
    rebuilt = False
    if "rebuild" in effects.values():
        try:
            rebuilt = await host.reconfigure(new_settings)
        except Exception as exc:  # noqa: BLE001 — e.g. the current provider lost its key
            host.settings = new_settings
            return JSONResponse(
                {"error": f"Saved, but the agent couldn't be rebuilt: {exc}", "saved": True}, status_code=409
            )
    else:
        host.settings = new_settings
    restart = {name for name, when in effects.items() if when == "restart"}
    request.app.state.pending_restart |= restart
    event = {"type": "settings_changed", "keys": sorted(effects), "restart_required": _restart_list(request)}
    host.broadcast(event)
    return JSONResponse({
        "ok": True,
        "effects": effects,
        "rebuilt": rebuilt,
        "restart_required": _restart_list(request),
        **settings_schema(host.settings, request.app.state.env_path),
    })


@guarded
async def patch_settings(request: Request) -> JSONResponse:
    """Save {"values": {field: value}} to .env (null = back to the default)."""
    body = await _body(request)
    values = body.get("values") or {}
    remove = body.get("remove_unknown") or []
    if not isinstance(values, dict) or not isinstance(remove, list):
        return _error("Expected {\"values\": {...}, \"remove_unknown\": [...]}")
    if not values and not remove:
        return _error("Nothing to save.")
    return await _apply(request, values, [str(k) for k in remove])


# --- MCP connectors ----------------------------------------------------------

def _mcp_path(request: Request) -> Path:
    return Path(_host(request).settings.mcp_config_path)


def _read_mcp(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"mcpServers": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("mcp_servers.json must hold an object")
    data.setdefault("mcpServers", {})
    return data


@guarded
async def get_mcp(request: Request) -> JSONResponse:
    """Servers in mcp_servers.json, each with whether it loaded at startup."""
    host = _host(request)
    path = _mcp_path(request)
    try:
        data = _read_mcp(path)
    except ValueError as exc:
        return JSONResponse({"path": str(path), "servers": [], "error": f"Invalid JSON: {exc}"})
    loaded = request.app.state.mcp_loaded
    servers = []
    for name, server in data["mcpServers"].items():
        tag = server.get("agent")
        if server.get("disabled"):
            status = "off"
        elif tag in host.mcp_errors:
            status = "error"
        elif name in loaded:
            status = "ok"
        else:
            status = "restart"  # added or re-enabled since startup
        servers.append({
            "name": name,
            "agent": tag,
            "command": server.get("command"),
            "args": server.get("args", []),
            "url": server.get("url"),
            "transport": server.get("transport"),
            "env_keys": sorted((server.get("env") or {}).keys()),  # values may be secrets
            "disabled": bool(server.get("disabled")),
            "status": status,
            "error": host.mcp_errors.get(tag) if status == "error" else None,
            "tools": len(host.mcp_groups.get(tag, [])),
        })
    return JSONResponse({
        "path": str(path),
        "enabled": host.settings.enable_mcp_tools,
        "servers": servers,
        "helpers": list(HELPER_TAGS),
    })


def _clean_server(body: dict[str, Any], old: dict[str, Any]) -> dict[str, Any]:
    """Validate one server entry from the browser; keep fields it doesn't edit."""
    server = {k: v for k, v in old.items() if k not in {"command", "args", "url", "agent", "disabled"}}
    command = str(body.get("command") or "").strip()
    url = str(body.get("url") or "").strip()
    if bool(command) == bool(url):
        raise ValueError("Give either a command (stdio server) or a url (HTTP server).")
    if command:
        args = body.get("args") or []
        if isinstance(args, str):
            args = args.split()
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            raise ValueError("args must be a list of strings")
        server.update(command=command, args=args)
        server.pop("url", None)
        server.pop("transport", None)
    else:
        if not re.match(r"^https?://", url):
            raise ValueError("url must start with http:// or https://")
        server["url"] = url
        server.pop("cwd", None)
    agent = body.get("agent")
    if agent:
        if agent not in HELPER_TAGS:
            raise ValueError(f"agent must be one of {', '.join(HELPER_TAGS)} (or empty for the main agent)")
        server["agent"] = agent
    if body.get("disabled"):
        server["disabled"] = True
    env = body.get("env")
    if isinstance(env, dict):  # only the keys sent are changed; null removes one
        merged = dict(server.get("env") or {})
        for key, value in env.items():
            if value is None:
                merged.pop(key, None)
            else:
                merged[str(key)] = str(value)
        if merged:
            server["env"] = merged
        else:
            server.pop("env", None)
    return server


def _mcp_changed(request: Request) -> None:
    request.app.state.pending_restart.add("mcp_servers")
    _host(request).broadcast({
        "type": "settings_changed", "keys": ["mcp_servers"], "restart_required": _restart_list(request),
    })


@guarded
async def put_mcp(request: Request) -> JSONResponse:
    """Add or replace one MCP server. Takes effect after a restart."""
    name = request.path_params["name"]
    if not _SERVER_NAME.match(name):
        return _error("Server names may use letters, digits, - and _ (max 40).")
    path = _mcp_path(request)
    try:
        data = _read_mcp(path)
        data["mcpServers"][name] = _clean_server(await _body(request), data["mcpServers"].get(name, {}))
    except ValueError as exc:
        return _error(str(exc))
    _atomic_json(path, data)
    _mcp_changed(request)
    return await get_mcp(request)


@guarded
async def delete_mcp(request: Request) -> JSONResponse:
    """Remove one MCP server from mcp_servers.json."""
    name = request.path_params["name"]
    path = _mcp_path(request)
    try:
        data = _read_mcp(path)
    except ValueError as exc:
        return _error(str(exc))
    if data["mcpServers"].pop(name, None) is None:
        return _error(f"No server named {name}.", 404)
    _atomic_json(path, data)
    _mcp_changed(request)
    return await get_mcp(request)


# --- connections (sign-ins and keys) ------------------------------------------

def _google_status(settings: Any) -> dict[str, Any]:
    status: dict[str, Any] = {
        "client_file": settings.google_credentials_path.exists(),
        "client_path": str(settings.google_credentials_path),
        "token": google_auth.is_connected(settings),
        "ok": False,
        "error": None,
        "scopes": list(google_auth.SCOPES),
    }
    if status["token"]:
        try:
            google_auth.credentials(settings)  # refreshes if expired, checks scopes
            status["ok"] = True
        except Exception as exc:  # noqa: BLE001 — shown in the UI
            status["error"] = str(exc)
    return status


@guarded
async def get_connections(request: Request) -> JSONResponse:
    """Google sign-in, mail backend and which API keys are set."""
    settings = _host(request).settings
    try:
        google = await asyncio.wait_for(asyncio.to_thread(_google_status, settings), timeout=15)
    except TimeoutError:
        google = {"token": google_auth.is_connected(settings), "ok": False, "error": "Google didn't answer in time."}
    google["signing_in"] = request.app.state.google_signing_in
    imap_ready = bool(settings.mail_address and settings.mail_password)
    mail = {
        "backend": settings.mail_backend,
        "address": settings.mail_address,
        "password_set": bool(settings.mail_password),
        "imap_host": settings.mail_imap_host,
        "smtp_host": settings.mail_smtp_host,
        "ready": google.get("ok", False) if settings.mail_backend == "gmail" else imap_ready,
    }
    keys = {
        "openrouter": bool(settings.openrouter_api_key),
        "groq": bool(settings.groq_api_key),
        "tavily": bool(settings.tavily_api_key),
    }
    return JSONResponse({"google": google, "mail": mail, "keys": keys})


@guarded
async def connect_google(request: Request) -> JSONResponse:
    """Run the Google consent flow (luna-google-auth) on this machine.

    A browser tab opens on the computer running luna-web; this request
    finishes when you approve there (or after 5 minutes)."""
    state = request.app.state
    if state.google_signing_in:
        return _error("A Google sign-in is already waiting in another browser tab.", 409)
    settings = _host(request).settings
    if not settings.google_credentials_path.exists():
        return _error(
            f"No OAuth client file at {settings.google_credentials_path}. Download a 'Desktop app' "
            "OAuth client from Google Cloud Console there (see docs/google.md)."
        )
    state.google_signing_in = True
    try:
        await asyncio.wait_for(asyncio.to_thread(google_auth.authorize, settings), timeout=300)
    except TimeoutError:
        return _error("Sign-in timed out. Try again.", 504)
    except (Exception, SystemExit) as exc:  # noqa: BLE001 — authorize() exits on setup errors
        return _error(f"Sign-in failed: {exc}")
    finally:
        state.google_signing_in = False
    return await get_connections(request)


@guarded
async def disconnect_google(request: Request) -> JSONResponse:
    """Sign out of Google: delete the saved token."""
    _host(request).settings.google_token_path.unlink(missing_ok=True)
    return await get_connections(request)


# --- model providers ---------------------------------------------------------

@guarded
async def get_providers(request: Request) -> JSONResponse:
    """Every provider, the model in use now and the saved default."""
    host = _host(request)
    settings = host.settings
    return JSONResponse({
        "providers": [
            {**p, "model_env": env_name(PROVIDERS[p["id"]].model_field),
             "key_env": env_name(PROVIDERS[p["id"]].key_field) if PROVIDERS[p["id"]].key_field else None}
            for p in describe_providers(settings)
        ],
        "current": {"provider": host.provider, "model": host.model},
        "default": {"provider": settings.provider, "model": get_provider(settings.provider).default_model(settings)},
        "can_switch": host.can_switch,
    })


@guarded
async def get_provider_models(request: Request) -> JSONResponse:
    """The models one provider offers (live from its API)."""
    provider = request.path_params["provider"]
    try:
        models = await list_models(_host(request).settings, provider)
    except Exception as exc:  # noqa: BLE001 — offline, bad key, Ollama not running…
        return JSONResponse({"provider": provider, "models": [], "error": str(exc)})
    return JSONResponse({"provider": provider, "models": models})


@guarded
async def set_default_provider(request: Request) -> JSONResponse:
    """Save the startup provider + model to .env; "apply": true also switches now."""
    body = await _body(request)
    provider = str(body.get("provider", "")).strip().lower()
    if provider not in PROVIDERS:
        return _error(f"provider must be one of {', '.join(PROVIDERS)}")
    model = str(body.get("model", "")).strip()
    values: dict[str, Any] = {"provider": provider}
    if model:
        values[PROVIDERS[provider].model_field] = model
    host = _host(request)
    try:
        saved, _ = save_settings(request.app.state.env_path, values)
    except SettingsRejected as exc:
        return _error(str(exc))
    get_settings.cache_clear()
    host.settings = _merged(host.settings, saved, values)
    if body.get("apply"):
        try:
            await host.switch(provider, model)
        except Exception as exc:  # noqa: BLE001 — e.g. missing API key
            return _error(f"Saved as default, but couldn't switch now: {exc}", 409)
    return await get_providers(request)


# --- permissions -------------------------------------------------------------

def _tool_row(name: str, owner: str, asks: bool, auto: set[str]) -> dict[str, Any]:
    risky = is_risky_tool_name(name)
    if name in auto:
        mode = "auto"
    elif asks:
        mode = "ask"
    else:
        mode = "free"
    return {"name": name, "owner": owner, "risky": risky, "mode": mode, "can_toggle": asks or risky or name in auto}


@guarded
async def get_permissions(request: Request) -> JSONResponse:
    """Every tool of the main agent and each helper: does it ask first?

    mode "ask" = pauses for your approval, "auto" = listed in
    LUNA_AUTO_APPROVE (runs without asking), "free" = never changes anything.
    """
    host = _host(request)
    settings = host.settings
    auto = set(settings.auto_approve)
    main_mcp = {t.name for t in host.mcp_groups.get(None, [])}
    tools = [
        _tool_row(name, "main", name in main_mcp and is_risky_tool_name(name), auto)
        for name in agent_tool_names(host.agent)
        if not name.startswith("ask_") or name == "ask_user"
    ]
    try:
        specs = get_subagent_specs(settings, host.mcp_groups)
    except Exception:  # noqa: BLE001 — permissions view must still load
        specs = []
    helpers = []
    for spec in specs:
        helper = spec.name.removeprefix("ask_")
        names = [t.name for t in spec.tools]
        helpers.append({"name": helper, "tools": len(names)})
        tools += [_tool_row(n, helper, n in spec.interrupt_on, auto) for n in names]
    return JSONResponse({
        "tools": tools,
        "helpers": helpers,
        "auto_approve": settings.auto_approve,
        "workspace_dirs": [str(p) for p in settings.workspace_dirs],
    })


# --- stats -------------------------------------------------------------------

class ProcessSampler:
    """CPU % of this process between two calls (100 = one full core)."""

    def __init__(self) -> None:
        self._last = (time.monotonic(), time.process_time())

    def cpu_percent(self) -> float:
        now = (time.monotonic(), time.process_time())
        wall, cpu = now[0] - self._last[0], now[1] - self._last[1]
        self._last = now
        return round(100 * cpu / wall, 1) if wall > 0 else 0.0


def _rss_bytes() -> int:
    try:
        pages = int(Path("/proc/self/statm").read_text().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak * 1024 if os.uname().sysname != "Darwin" else peak  # Linux reports KiB


def _system() -> dict[str, Any]:
    info: dict[str, Any] = {"cpus": os.cpu_count() or 1}
    try:
        info["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        info["load"] = None
    try:
        meminfo = dict(
            line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines() if ":" in line
        )
        info["mem_total"] = int(meminfo["MemTotal"].split()[0]) * 1024
        info["mem_available"] = int(meminfo["MemAvailable"].split()[0]) * 1024
    except (OSError, KeyError, ValueError):
        info["mem_total"] = info["mem_available"] = None
    return info


def _size(path: Any) -> int | None:
    try:
        return Path(path).stat().st_size
    except (OSError, TypeError):
        return None


async def _slow_stats(request: Request) -> dict[str, Any]:
    """Session count (scans every checkpoint), cached for SLOW_STATS_SECONDS."""
    state = request.app.state
    cached = state.slow_stats
    if cached and time.monotonic() - cached[0] < SLOW_STATS_SECONDS:
        return cached[1]
    host = _host(request)
    checkpointer = getattr(host.agent, "checkpointer", None)
    sessions = None
    if checkpointer is not None:
        try:
            items = await list_sessions(checkpointer)
            sessions = {
                "count": sum(1 for s in items if not s["id"].startswith("routine-")),
                "routine_threads": sum(1 for s in items if s["id"].startswith("routine-")),
                "turns": sum(s["turns"] for s in items),
                "last": items[0]["updated_at"] if items else None,
            }
        except Exception:  # noqa: BLE001 — stats are cosmetic
            sessions = None
    try:
        helpers = {s.name.removeprefix("ask_"): len(s.tools) for s in get_subagent_specs(host.settings, host.mcp_groups)}
    except Exception:  # noqa: BLE001
        helpers = {}
    data = {"sessions": sessions, "helper_tools": helpers}
    state.slow_stats = (time.monotonic(), data)
    return data


@guarded
async def get_stats(request: Request) -> JSONResponse:
    """Live numbers for the Overview (cheap; polled every few seconds)."""
    host = _host(request)
    settings = host.settings
    tools = agent_tool_names(host.agent)
    store = host.routines
    routines = store.list() if store else []
    return JSONResponse({
        "now": time.time(),
        "uptime": round(time.time() - host.started_at),
        "pid": os.getpid(),
        "process": {"cpu_percent": request.app.state.sampler.cpu_percent(), "rss": _rss_bytes(),
                    "threads": len(os.listdir("/proc/self/task")) if Path("/proc/self/task").exists() else None},
        "system": _system(),
        "model": {"provider": host.provider, "model": host.model},
        "tabs": len(host.listeners),
        "memory": host.memory.stats() if host.memory is not None else None,
        "storage": {
            "checkpoints": _size(settings.checkpoint_path) if settings.memory_backend == "sqlite" else None,
            "longterm": _size(settings.longterm_memory_path) if host.memory is not None else None,
            "routines": _size(settings.routines_path) if store else None,
        },
        **(await _slow_stats(request)),
        "tools": {
            "main": len(tools),
            "mcp_tools": sum(len(v) for v in host.mcp_groups.values()),
            "mcp_errors": {str(k or "main"): v for k, v in host.mcp_errors.items()},
        },
        "usage": {
            "since_start": host.usage,
            **(store.usage(14) if store else {"days": [], "models": []}),
        },
        "routines": {
            "total": len(routines),
            "enabled": sum(r["enabled"] for r in routines),
            "running": sorted(host.scheduler.running) if host.scheduler else [],
            "scheduler": bool(host.scheduler and host.scheduler.active),
            "recent": store.recent_runs(8) if store else [],
        },
        "restart_required": _restart_list(request),
    })


@guarded
async def get_insights(request: Request) -> JSONResponse:
    """Latest results of the mail / agenda / to-do routines (HUD widgets)."""
    store = _host(request).routines
    return JSONResponse({
        "insights": store.insights() if store else {},
        "dashboard": _read_dashboard(request.app.state.dashboard_path),
    })


# --- dashboard preferences ---------------------------------------------------

def _read_dashboard(path: Path) -> dict[str, Any]:
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    return _clean_dashboard(saved if isinstance(saved, dict) else {})


def _clean_dashboard(data: dict[str, Any]) -> dict[str, Any]:
    out = json.loads(json.dumps(DEFAULT_DASHBOARD))  # deep copy
    widgets = data.get("widgets")
    if isinstance(widgets, dict):
        for key in out["widgets"]:
            if key in widgets:
                out["widgets"][key] = bool(widgets[key])
    if data.get("position") in _POSITIONS:
        out["position"] = data["position"]
    if data.get("style") in _STYLES:
        out["style"] = data["style"]
    if isinstance(data.get("opacity"), (int, float)):
        out["opacity"] = min(1.0, max(0.3, float(data["opacity"])))
    if "show_hints" in data:
        out["show_hints"] = bool(data["show_hints"])
    return out


@guarded
async def get_dashboard(request: Request) -> JSONResponse:
    """HUD widget preferences."""
    return JSONResponse(_read_dashboard(request.app.state.dashboard_path))


@guarded
async def put_dashboard(request: Request) -> JSONResponse:
    """Save HUD widget preferences (unknown keys are dropped)."""
    prefs = _clean_dashboard({**_read_dashboard(request.app.state.dashboard_path), **(await _body(request))})
    _atomic_json(request.app.state.dashboard_path, prefs)
    _host(request).broadcast({"type": "dashboard", "prefs": prefs})
    return JSONResponse(prefs)


# --- routines ----------------------------------------------------------------

def _store(request: Request) -> Any:
    store = _host(request).routines
    if store is None:
        raise RoutineRefused("Routines are off (LUNA_ROUTINES_ENABLED=false).")
    return store


def _routines_payload(request: Request) -> dict[str, Any]:
    host = _host(request)
    store = _store(request)
    running = host.scheduler.running if host.scheduler else set()
    return {
        "routines": [{**r, "running": r["id"] in running} for r in store.list()],
        "builtins": {k: {"name": s.name, "tool": s.tool, "description": s.description, "cron": s.cron}
                     for k, s in BUILTINS.items()},
        "scheduler": bool(host.scheduler and host.scheduler.active),
        "timezone": str(store.local_now().tzinfo),
    }


def _routine_errors(handler: Handler) -> Handler:
    async def wrapper(request: Request) -> JSONResponse:
        try:
            return await handler(request)
        except RoutineRefused as exc:
            return _error(str(exc), 404 if str(exc).startswith("No routine") else 400)

    wrapper.__name__ = handler.__name__
    wrapper.__doc__ = handler.__doc__
    return wrapper


@guarded
@_routine_errors
async def list_routines(request: Request) -> JSONResponse:
    """Every routine with its schedule, last run and next run."""
    return JSONResponse(_routines_payload(request))


@guarded
@_routine_errors
async def create_routine(request: Request) -> JSONResponse:
    """Create an agent routine: {"name", "prompt", "cron", "enabled"?, "notify"?}."""
    body = await _body(request)
    _store(request).add(
        str(body.get("name", "")),
        "agent",
        str(body.get("cron", "")),
        prompt=str(body.get("prompt", "")),
        enabled=bool(body.get("enabled", True)),
        notify=bool(body.get("notify", True)),
    )
    return JSONResponse(_routines_payload(request), status_code=201)


@guarded
@_routine_errors
async def update_routine(request: Request) -> JSONResponse:
    """Change a routine: any of name / prompt / cron / enabled / notify."""
    body = await _body(request)
    changes = {k: body[k] for k in ("name", "prompt", "cron", "enabled", "notify") if k in body}
    _store(request).update(int(request.path_params["id"]), **changes)
    return JSONResponse(_routines_payload(request))


@guarded
@_routine_errors
async def delete_routine(request: Request) -> JSONResponse:
    """Delete an agent routine (built-ins can only be turned off)."""
    _store(request).delete(int(request.path_params["id"]))
    return JSONResponse(_routines_payload(request))


@guarded
@_routine_errors
async def run_routine(request: Request) -> JSONResponse:
    """Run one routine now and return its run record."""
    host = _host(request)
    _store(request)
    if host.scheduler is None:
        return _error("The routine scheduler isn't running.", 409)
    try:
        run = await host.scheduler.run_now(int(request.path_params["id"]))
    except ValueError as exc:
        if isinstance(exc, RoutineRefused):
            raise
        return _error(str(exc), 409)
    return JSONResponse({"run": run, **_routines_payload(request)})


@guarded
@_routine_errors
async def routine_runs(request: Request) -> JSONResponse:
    """A routine's newest runs."""
    store = _store(request)
    routine_id = int(request.path_params["id"])
    store.get(routine_id)
    return JSONResponse({"runs": store.runs(routine_id, limit=30)})


@guarded
async def check_cron(request: Request) -> JSONResponse:
    """Explain a schedule: {"valid", "text", "next": [3 upcoming UTC times]}."""
    expr = request.query_params.get("expr", "")
    try:
        cron = parse(expr)
    except CronError as exc:
        return JSONResponse({"valid": False, "error": str(exc)})
    store = _host(request).routines
    when = store.local_now() if store else datetime.now().astimezone()
    upcoming = []
    for _ in range(3):
        when = next_run(cron, when)
        upcoming.append(when.isoformat(timespec="minutes"))
    return JSONResponse({"valid": True, "expr": cron.expr, "text": describe(cron.expr), "next": upcoming})


# --- routes ------------------------------------------------------------------

def control_routes() -> list[Route]:
    """Every /api/control route, for create_app()."""
    p = "/api/control"
    return [
        Route(f"{p}/settings", get_settings_route, methods=["GET"]),
        Route(f"{p}/settings", patch_settings, methods=["PATCH"]),
        Route(f"{p}/mcp", get_mcp, methods=["GET"]),
        Route(f"{p}/mcp/{{name}}", put_mcp, methods=["PUT"]),
        Route(f"{p}/mcp/{{name}}", delete_mcp, methods=["DELETE"]),
        Route(f"{p}/connections", get_connections, methods=["GET"]),
        Route(f"{p}/connections/google", connect_google, methods=["POST"]),
        Route(f"{p}/connections/google", disconnect_google, methods=["DELETE"]),
        Route(f"{p}/providers", get_providers, methods=["GET"]),
        Route(f"{p}/providers/default", set_default_provider, methods=["POST"]),
        Route(f"{p}/providers/{{provider}}/models", get_provider_models, methods=["GET"]),
        Route(f"{p}/permissions", get_permissions, methods=["GET"]),
        Route(f"{p}/stats", get_stats, methods=["GET"]),
        Route(f"{p}/insights", get_insights, methods=["GET"]),
        Route(f"{p}/dashboard", get_dashboard, methods=["GET"]),
        Route(f"{p}/dashboard", put_dashboard, methods=["PUT"]),
        Route(f"{p}/routines", list_routines, methods=["GET"]),
        Route(f"{p}/routines", create_routine, methods=["POST"]),
        Route(f"{p}/routines/{{id:int}}", update_routine, methods=["PATCH"]),
        Route(f"{p}/routines/{{id:int}}", delete_routine, methods=["DELETE"]),
        Route(f"{p}/routines/{{id:int}}/run", run_routine, methods=["POST"]),
        Route(f"{p}/routines/{{id:int}}/runs", routine_runs, methods=["GET"]),
        Route(f"{p}/cron", check_cron, methods=["GET"]),
    ]


def init_control_state(state: Any, env_path: Path, dashboard_path: Path) -> None:
    """The app.state fields these routes use (called from create_app's lifespan)."""
    state.env_path = Path(env_path)
    state.dashboard_path = Path(dashboard_path)
    state.pending_restart = set()
    state.google_signing_in = False
    state.sampler = ProcessSampler()
    state.slow_stats = None
    host = state.host
    # Server names that loaded at startup (for the connector status lights).
    loaded: set[str] = set()
    try:
        data = _read_mcp(Path(host.settings.mcp_config_path))
        for name, server in data["mcpServers"].items():
            if not server.get("disabled") and server.get("agent") not in host.mcp_errors and host.settings.enable_mcp_tools:
                loaded.add(name)
    except (OSError, ValueError):
        pass
    state.mcp_loaded = loaded


__all__ = ["DEFAULT_DASHBOARD", "ProcessSampler", "control_routes", "init_control_state"]

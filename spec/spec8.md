# Spec 8 — Control Center: settings, connectors, permissions, routines and live stats

**Date:** 2026-10-18  
**Status:** Implemented.  
**Scope:** One OS-style page in the web UI that covers:
- configuring Luna: settings (written to `.env`), MCP connectors, logins,
  model providers, the web server ("gateway"), permissions, and the HUD
  dashboard;
- running scheduled routines;
- showing live stats and the routines' insights (mail, agenda, to-dos),
  both there and subtly on the HUD.

Builds on [spec4](spec4.md) (web UI), [spec5](spec5.md) (long-term memory) and [spec7](spec7.md) (Google).
Decisions: [`DECISIONS.md`](../DECISIONS.md) D34–D36. User guide: [`docs/control-center.md`](../docs/control-center.md).

---

## 1. Goal

- Change any setting without opening `.env`, and know whether it applies
  now or after a restart.
- Add, switch off or remove an MCP server; connect Google; set API keys.
- See and change which tools ask first.
- "Check my mail every 15 minutes" and "every weekday at 8, brief me",
  with the results visible at a glance on the HUD.
- One screen with Luna's vital signs: CPU/RAM, model calls, memory,
  sessions, tools, routines.

## 2. Shape

```
browser ── #/control (ControlCenter.tsx: status bar · app dock · window)
   │  fetch /api/control/*                 ▲ /ws: routine_result, settings_changed, dashboard
   ▼                                       │
web/control.py ─ settings ⇄ config/schema.py ⇄ config/envfile.py ⇄ .env
               ─ mcp ⇄ config/mcp_servers.json ("disabled" skipped by mcp/loader.py)
               ─ connections → integrations/google.py (authorize in a thread)
               ─ providers / permissions / stats → AgentHost (usage, mcp_groups, mcp_errors)
               ─ routines → RoutineStore ⇄ data/luna_routines.sqlite
                                ▲
RoutineScheduler (routines/scheduler.py, started in server lifespan, 30 s tick)
   builtin → builtin.run_builtin → MCP tool.ainvoke (list_inbox / get_agenda / list_tasks)
   agent   → agent.run_agent_routine → run_task on thread routine-<id> (approvals auto-rejected)
   → store.finish_run → host.broadcast(routine_result) → InsightWidgets.tsx
```

## 3. Settings

| Piece | Rule |
| --- | --- |
| Schema | Generated from `Settings.model_fields`. Every field is in exactly one group (tested). Enums come from `CHOICES`. Kinds: bool, int, float, path, list, str |
| Secrets | `openrouter_api_key`, `groq_api_key`, `tavily_api_key`, `mail_password`: never sent to the browser, only `is_set` |
| Write | `update_env`: rewrite only the changed keys' lines, keep comments (also after a value), add new keys at the end. Temp file + rename; new file 0600 |
| Validate | `Settings(_env_file=…)` after the write. On error the original bytes are restored and the route returns 400 |
| Apply | `live` (mail/google: servers read `.env` per call) · `rebuild` (`AgentHost.reconfigure`, same memory + MCP) · `restart` (listed in `restart_required` until restart) |
| Running settings | The host takes only the saved fields from the re-read (`model_copy(update=…)`) |
| Stale keys | `LUNA_*` keys in `.env` that `Settings` doesn't know are listed and can be removed |

## 4. Routines

| | Built-in | Agent |
| --- | --- | --- |
| What | `mail_check`, `agenda`, `todos`: one read-only MCP tool each | a prompt |
| LLM | none | normal run, `TaskBudget` |
| Default | seeded, switched off | created by the user, on |
| Approvals | n/a (risky tool names refused) | every pause rejected; `ask_user` → "the user is away" |
| Output | summary + data for the widgets | the final reply, plus the tools it couldn't run |

- Schedules are 5-field cron (`*`, `a-b`, `a,b`, `*/n`; day-of-month OR
  day-of-week like cron; `@daily` and the other aliases), read in `LUNA_TIMEZONE`.
- One routine at a time; never the same one twice at once. The next run
  is scheduled before running, so a failing run isn't retried every tick.
- Runs left `running` by a crash are marked as errors when the store opens.
- The newest 50 runs per routine are kept.

## 5. Stats

- **Process:** CPU % (`process_time` delta), RSS (`/proc/self/statm`),
  thread count. **System:** load and memory (`/proc/meminfo`). No psutil.
- **Usage:** each `Session` run counts model calls (`"model"` updates, any
  agent), tool calls (`tool_call` events) and errors. Agent routines count
  the same way. Totals since start are in memory; per-day and
  per-provider/model totals are in the routines DB.
- **Memory:** `LongTermStore.stats()` (by kind, pinned, deleted, pending, history).
- **Sessions:** from `list_sessions` (routine threads counted apart),
  cached for 30 s because it scans every checkpoint.

## 6. UI

- **Shell:** `#/control/<app>`, the SYSTEM dock button, or `S`. Esc
  closes it. The HUD keys are off while it's open.
- **Apps:** Overview, Models, Connectors, Logins, Permissions, Routines,
  Dashboard, Gateway, General, All settings.
- **`SettingsForm`:** renders any field list from the schema, with a
  badge for when the change applies, reset/clear, dirty marks, and
  Save/Revert.
- **HUD widgets:** in a bottom corner (left or right), compact or minimal,
  with an opacity setting. Hidden under 1100 px and while a drawer is
  open. They update from `routine_result`.
- **Layout:** works at phone width (the dock becomes a top strip).

## 7. Security

- Every `/api/control/*` route uses the WebSocket's Origin check, because
  they can change keys and what runs without approval.
- MCP `env` values and secrets never go to the browser.
- Making a tool run without asking needs a confirmation. Routines can't
  approve anything.
- The Gateway app warns when `LUNA_WEB_HOST` isn't a loopback address.

## 8. Tests

- `tests/test_envfile.py`:
  - parsing and quoting;
  - comments, order, duplicates, inline comments;
  - newline injection is refused;
  - file mode;
  - schema coverage, masking and kinds;
  - save, validate and roll back.
- `tests/test_cron.py`: parse, invalid input, next_run (weekdays, months,
  leap days, timezone, dom/dow OR), describe.
- `tests/test_routines.py`:
  - store: seed, validate, reschedule, due, trim, crash recovery,
    insights, usage;
  - built-ins with fake tools: decode, skipped and error cases;
  - agent routine on its own thread; a risky tool is rejected;
  - scheduler: tick, notify, failure recording, no double run,
    start/stop.
- `tests/test_control_api.py`: Origin 403, settings round trip with
  rebuild and restart flags, MCP CRUD (env kept, compact JSON, disabled
  servers not loaded), connections, providers default + switch,
  permissions toggle, usage stats from a chat, dashboard cleaning,
  routines CRUD + run + insights, cron check.
- `tests/test_longterm.py`: `stats()`.
- `web/src/lib/control.test.ts`: formatting, field parsing, search,
  sparkline, insight lines.

## 9. Later

- Restart luna-web from the UI.
- Per-routine notifications (voice or a desktop notification).
- Routines while luna-web is closed (a system service).
- Reload MCP servers without a restart.
- Charts per helper.
- Editing `config/persona.md` in the UI.

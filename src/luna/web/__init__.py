"""
Web UI backend — a WebSocket bridge between the browser and the agent.

BEGINNER MAP
------------
  - events.py   turns agent stream events / pauses into small JSON messages
  - server.py   Starlette app: /ws (the chat socket), /api/health, and the
                built frontend from web/dist (run `npm run build` in web/)
  - window.py   opens the UI in its own app window (Chromium app mode)
  - control.py  /api/control/*: the Control Center (settings → .env, MCP
                connectors, logins, permissions, stats, routines)

Run it with ``uv run luna-web``. Protocol: docs/web-ui.md.
"""

from luna.web.server import create_app, main

__all__ = ["create_app", "main"]

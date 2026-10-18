# Spec 9 — Luna as a desktop app window

**Date:** 2026-10-18  
**Status:** Implemented.  
**Scope:** `luna-web` opens the UI by itself in its own window that feels like a native desktop application, and quits when that window closes.

Builds on [spec4](spec4.md) (web UI) and [spec8](spec8.md) (Control Center).
Decision: [`DECISIONS.md`](../DECISIONS.md) D37. User guide: [`docs/web-ui.md`](../docs/web-ui.md#the-app-window).

---

## 1. Goal

- Start Luna and get a Luna window. Don't open a browser tab, type a URL
  or click ENGAGE.
- The window has its own taskbar icon and no tabs or address bar, and
  closing it quits Luna.
- Luna can be started from the applications menu.

## 2. Shape

```
luna-web ── health check: already running? ── yes → open a window, exit
   │ no
   ├─ uvicorn.Server.run()                       (main thread)
   └─ thread: wait_for_server(/api/health)
              → find_browser (LUNA_WEB_BROWSER | chrome, chromium, edge, brave)
              → chrome --app=http://127.0.0.1:8765/?window=app
                       --user-data-dir=data/app-window --class=Luna
                       --autoplay-policy=no-user-gesture-required
              → watch_window: process exit after > 4 s → server.should_exit
                (no browser found → webbrowser.open, server keeps running)

page ?window=app ── auto-ENGAGE after the boot lines (2.6 s, once connected)
                 ── .app-window: no context menu / drag / text selection
                    outside inputs, transcript and code; app scrollbars
                 ── document.title "Luna" / "Luna · Control Center", "● " while busy
```

## 3. Rules

1. Only Chromium-family browsers are used for the app window. Their
   WebGL, microphone and AudioWorklet support is what the HUD needs.
2. The window uses its own profile (`data/app-window/`, git-ignored), so
   the window size and the microphone permission persist. The microphone
   is never auto-granted.
3. A browser process that exits within 4 s handed the URL to an existing
   window. That is not a close.
4. `--no-window` and `LUNA_WEB_OPEN_WINDOW=false` restore the old
   server-only behaviour. `LUNA_WEB_CLOSE_WITH_WINDOW=false` keeps the
   server running after the window closes.
5. `--install-desktop` writes `~/.local/share/applications/luna.desktop`
   (`StartupWMClass=Luna`, icon `web/public/luna.svg`). It runs
   `uv run --directory <project> luna-web`.

## 4. Tests

- `tests/test_window.py`:
  - URL host mapping;
  - browser discovery order, preferred browser and path;
  - app-mode flags;
  - default-browser fallback;
  - starting a stand-in browser;
  - close vs. handoff;
  - the desktop entry;
  - `main()`: already running → only a window; `--no-window`; `--install-desktop`.
- `web/src/lib/appWindow.test.ts`: `?window=app` detection, window titles.

## 5. Later

- A tray icon.
- Start at login.
- A macOS `.app` / Windows shortcut installer.
- Offline fonts (they come from Google Fonts today).

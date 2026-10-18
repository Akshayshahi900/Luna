"""
Open Luna in its own app window, like a desktop application.

BEGINNER MAP
------------
``luna-web`` starts the server and then opens the UI in a Chromium-family
browser (Chrome, Chromium, Edge, Brave) in **app mode**:

  chrome --app=http://127.0.0.1:8765/?window=app --user-data-dir=data/app-window ...

App mode means no tabs, no address bar, its own taskbar entry and icon.
The separate profile (data/app-window/) remembers the window size and the
microphone permission, and never mixes with your normal browsing.
``?window=app`` tells the page it is the app window: it skips the ENGAGE
click (audio autoplay is allowed for this window) and blocks browser-only
things such as the right-click menu.

Closing the window stops luna-web (LUNA_WEB_CLOSE_WITH_WINDOW), so it
behaves like quitting an app. Without a Chromium browser the page opens in
your default browser instead, and the server keeps running.

Running ``luna-web`` while it already runs just opens another window, so
the launcher entry from ``luna-web --install-desktop`` works like an app icon.

Why not pywebview / Electron: the HUD needs WebGL, the microphone and an
AudioWorklet. The system web views (WebKitGTK on Linux) handle these
poorly, and Electron would add a large Node runtime (DECISIONS.md D37).

Read next: luna/web/server.py (main)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from collections.abc import Callable
from pathlib import Path

from luna.config.settings import PROJECT_ROOT

# Tried in order when LUNA_WEB_BROWSER is not set.
BROWSER_NAMES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
    "brave",
    "chrome",
    "msedge",
)
# Common install paths that are not on PATH (macOS app bundles, Windows).
BROWSER_PATHS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)
DEFAULT_PROFILE = PROJECT_ROOT / "data" / "app-window"
ICON_PATH = PROJECT_ROOT / "web" / "public" / "luna.svg"
WINDOW_CLASS = "Luna"  # Linux WM_CLASS: groups the window with the launcher entry
WINDOW_SIZE = (1440, 900)
# A browser that exits this fast handed the URL to a window it already had
# open; that is not the user closing Luna.
HANDOFF_SECONDS = 4.0


def base_url(host: str, port: int) -> str:
    """Where this machine reaches the server (0.0.0.0 / :: → 127.0.0.1)."""
    if host in {"0.0.0.0", "::", ""}:
        host = "127.0.0.1"
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{port}"


def app_url(host: str, port: int) -> str:
    """The page address for the app window."""
    return f"{base_url(host, port)}/?window=app"


def find_browser(preferred: str | None = None, which: Callable[[str], str | None] = shutil.which) -> str | None:
    """A Chromium-family browser to run in app mode, or None.

    ``preferred`` (LUNA_WEB_BROWSER) may be a command name or a full path.
    """
    if preferred:
        found = which(preferred)
        if found:
            return found
        return preferred if Path(preferred).is_file() else None
    for name in BROWSER_NAMES:
        found = which(name)
        if found:
            return found
    for path in BROWSER_PATHS:
        if Path(path).is_file():
            return path
    return None


def app_command(browser: str, url: str, profile: Path, size: tuple[int, int] = WINDOW_SIZE) -> list[str]:
    """The command line that opens ``url`` as an app window."""
    return [
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--class={WINDOW_CLASS}",
        f"--window-size={size[0]},{size[1]}",
        # Luna speaks as soon as she is ready, without an ENGAGE click.
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
    ]


def server_running(url: str, timeout: float = 0.5) -> bool:
    """True if a Luna server answers /api/health at the given base URL."""
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/api/health", timeout=timeout) as res:
            return res.status == 200
    except OSError:
        return False


def wait_for_server(url: str, timeout: float = 120.0, interval: float = 0.25) -> bool:
    """Poll /api/health until the server is up (the agent takes a while to build)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_running(url):
            return True
        time.sleep(interval)
    return False


def open_window(url: str, browser: str | None, profile: Path = DEFAULT_PROFILE) -> subprocess.Popen | None:
    """Open the app window. Returns the browser process, or None if the page
    went to the default browser instead (no Chromium-family browser found)."""
    if browser is None:
        print("No Chrome / Chromium / Edge / Brave found: opening your default browser.", file=sys.stderr)
        webbrowser.open(url, new=1)
        return None
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen(
        app_command(browser, url, profile),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,  # Ctrl+C in the terminal stops the server, which then closes nothing else
    )


def watch_window(proc: subprocess.Popen, on_closed: Callable[[], None], handoff: float = HANDOFF_SECONDS) -> None:
    """Call ``on_closed`` when the app window's process exits (blocks; run in a thread).

    An exit within ``handoff`` seconds means the browser handed the page to
    an already-open Luna window; then nothing is closed.
    """
    started = time.monotonic()
    proc.wait()
    if time.monotonic() - started < handoff:
        return
    on_closed()


def desktop_entry(command: str, icon: Path = ICON_PATH) -> str:
    """A freedesktop .desktop file that starts Luna from the app launcher."""
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Luna\n"
        "GenericName=Voice assistant\n"
        "Comment=Luna, your local AI assistant\n"
        f"Exec={command}\n"
        f"Icon={icon}\n"
        "Terminal=false\n"
        "Categories=Utility;\n"
        f"StartupWMClass={WINDOW_CLASS}\n"
        "Keywords=assistant;voice;ai;\n"
    )


def install_desktop_entry(applications_dir: Path | None = None) -> Path:
    """Write ~/.local/share/applications/luna.desktop (Linux) and return its path.

    The entry runs ``uv run --directory <project> luna-web``, so it always
    uses this checkout and its .env.
    """
    uv = shutil.which("uv") or "uv"
    target_dir = applications_dir or Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "applications"
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "luna.desktop"
    path.write_text(desktop_entry(f'"{uv}" run --directory "{PROJECT_ROOT}" luna-web'), encoding="utf-8")
    path.chmod(0o755)
    return path


__all__ = [
    "BROWSER_NAMES",
    "DEFAULT_PROFILE",
    "app_command",
    "app_url",
    "base_url",
    "desktop_entry",
    "find_browser",
    "install_desktop_entry",
    "open_window",
    "server_running",
    "wait_for_server",
    "watch_window",
]

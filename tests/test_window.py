"""The desktop app window (luna/web/window.py) and luna-web's start-up:
browser discovery, the app-mode command, close-with-window, the launcher
entry, and "already running → just open a window". No real browser runs."""

import subprocess
import sys

import pytest

from luna.config import Settings
from luna.web import window


def test_urls_use_a_reachable_host():
    assert window.base_url("127.0.0.1", 8765) == "http://127.0.0.1:8765"
    assert window.base_url("0.0.0.0", 8765) == "http://127.0.0.1:8765"
    assert window.base_url("::1", 9000) == "http://[::1]:9000"
    assert window.app_url("localhost", 8765) == "http://localhost:8765/?window=app"


def test_find_browser_prefers_the_setting_then_the_known_list(tmp_path):
    installed = {"chromium": "/usr/bin/chromium", "brave-browser": "/usr/bin/brave"}
    assert window.find_browser(None, installed.get) == "/usr/bin/chromium"
    assert window.find_browser("brave-browser", installed.get) == "/usr/bin/brave"
    custom = tmp_path / "my-chrome"
    custom.write_text("")
    assert window.find_browser(str(custom), lambda name: None) == str(custom)
    assert window.find_browser("missing", lambda name: None) is None


def test_app_command_opens_an_app_window_with_its_own_profile(tmp_path):
    cmd = window.app_command("/usr/bin/chromium", "http://127.0.0.1:8765/?window=app", tmp_path / "profile")
    assert cmd[0] == "/usr/bin/chromium"
    assert "--app=http://127.0.0.1:8765/?window=app" in cmd
    assert f"--user-data-dir={tmp_path / 'profile'}" in cmd
    assert "--class=Luna" in cmd
    assert "--autoplay-policy=no-user-gesture-required" in cmd


def test_open_window_falls_back_to_the_default_browser(monkeypatch):
    opened = []
    monkeypatch.setattr(window.webbrowser, "open", lambda url, new=0: opened.append(url))
    assert window.open_window("http://x/?window=app", None) is None
    assert opened == ["http://x/?window=app"]


def test_open_window_starts_the_browser(tmp_path):
    # A stand-in "browser" that exits at once.
    proc = window.open_window("http://x/", sys.executable, tmp_path / "profile")
    assert isinstance(proc, subprocess.Popen)
    proc.wait(timeout=10)
    assert (tmp_path / "profile").is_dir()


def _proc(code: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", code])


def test_closing_the_window_calls_back():
    closed = []
    window.watch_window(_proc("import time; time.sleep(0.3)"), lambda: closed.append(True), handoff=0.1)
    assert closed == [True]


def test_a_quick_handoff_is_not_a_close():
    # The browser passed the URL to a Luna window that was already open.
    closed = []
    window.watch_window(_proc("pass"), lambda: closed.append(True), handoff=5)
    assert closed == []


def test_desktop_entry(tmp_path):
    path = window.install_desktop_entry(tmp_path / "applications")
    text = path.read_text()
    assert path.name == "luna.desktop"
    assert "Name=Luna" in text and "StartupWMClass=Luna" in text and "Terminal=false" in text
    assert "luna-web" in text and str(window.ICON_PATH) in text


@pytest.fixture
def no_server(monkeypatch):
    """Stub out everything main() touches outside this process."""
    calls = {"opened": [], "served": 0}
    monkeypatch.setattr(window, "find_browser", lambda preferred=None: "/usr/bin/chromium")
    monkeypatch.setattr(window, "open_window", lambda url, browser, *a: calls["opened"].append((url, browser)))

    class FakeServer:
        def __init__(self, config):
            self.should_exit = False

        def run(self):
            calls["served"] += 1

    import uvicorn

    monkeypatch.setattr(uvicorn, "Server", FakeServer)
    monkeypatch.setattr(uvicorn, "Config", lambda *a, **k: None)
    monkeypatch.setattr("luna.web.server.create_app", lambda **k: None)
    # Fixed values, whatever the real .env says.
    settings = Settings(openrouter_api_key="t", web_host="127.0.0.1", web_port=8765, web_open_window=True)
    monkeypatch.setattr("luna.web.server.get_settings", lambda: settings)
    return calls


def test_already_running_just_opens_a_window(monkeypatch, no_server):
    from luna.web.server import main

    monkeypatch.setattr(window, "server_running", lambda url, timeout=0.5: True)
    main([])
    assert no_server["served"] == 0
    assert no_server["opened"] == [("http://127.0.0.1:8765/?window=app", "/usr/bin/chromium")]


def test_no_window_only_serves(monkeypatch, no_server):
    from luna.web.server import main

    monkeypatch.setattr(window, "server_running", lambda url, timeout=0.5: False)
    main(["--no-window"])
    assert no_server["served"] == 1 and no_server["opened"] == []


def test_install_desktop_flag(monkeypatch, tmp_path, capsys):
    from luna.web.server import main

    monkeypatch.setattr(window, "install_desktop_entry", lambda: tmp_path / "luna.desktop")
    main(["--install-desktop"])
    assert "luna.desktop" in capsys.readouterr().out

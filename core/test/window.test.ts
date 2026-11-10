// The desktop app window (web/window.ts) and luna-web's start-up: browser
// discovery, the app-mode command, close-with-window, the launcher entry, and
// "already running → just open a window". No real browser runs.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { loadSettings } from "../src/config/settings.ts";
import { main, mainHooks } from "../src/web/server.ts";
import * as window from "../src/web/window.ts";
import { tmpDir } from "./helpers.ts";

test("urls use a reachable host", () => {
  expect(window.baseUrl("127.0.0.1", 8765)).toBe("http://127.0.0.1:8765");
  expect(window.baseUrl("0.0.0.0", 8765)).toBe("http://127.0.0.1:8765");
  expect(window.baseUrl("::1", 9000)).toBe("http://[::1]:9000");
  expect(window.appUrl("localhost", 8765)).toBe("http://localhost:8765/?window=app");
});

test("findBrowser prefers the setting, then the known list", () => {
  const installed: Record<string, string> = { chromium: "/usr/bin/chromium", "brave-browser": "/usr/bin/brave" };
  const lookup = (name: string) => installed[name] ?? null;
  expect(window.findBrowser(null, lookup)).toBe("/usr/bin/chromium");
  expect(window.findBrowser("brave-browser", lookup)).toBe("/usr/bin/brave");
  const custom = path.join(tmpDir(), "my-chrome");
  writeFileSync(custom, "");
  expect(window.findBrowser(custom, () => null)).toBe(custom);
  expect(window.findBrowser("missing", () => null)).toBeNull();
});

test("the app command opens an app window with its own profile", () => {
  const profile = path.join(tmpDir(), "profile");
  const cmd = window.appCommand("/usr/bin/chromium", "http://127.0.0.1:8765/?window=app", profile);
  expect(cmd[0]).toBe("/usr/bin/chromium");
  expect(cmd).toContain("--app=http://127.0.0.1:8765/?window=app");
  expect(cmd).toContain(`--user-data-dir=${profile}`);
  expect(cmd).toContain("--class=Luna");
  expect(cmd).toContain("--autoplay-policy=no-user-gesture-required");
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("openWindow falls back to the default browser", () => {
  const opened: string[] = [];
  const real = window.hooks.openDefault;
  window.hooks.openDefault = (url) => opened.push(url);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(window.openWindow("http://x/?window=app", null)).toBeNull();
  expect(opened).toEqual(["http://x/?window=app"]);
  window.hooks.openDefault = real;
});

test("openWindow starts the browser", async () => {
  // A stand-in "browser" that exits at once.
  const profile = path.join(tmpDir(), "profile");
  const proc = window.openWindow("http://x/", process.execPath, profile)!;
  await new Promise((r) => proc.once("exit", r));
  expect(statSync(profile).isDirectory()).toBe(true);
});

const child = (code: string) => spawn(process.execPath, ["-e", code]);

test("closing the window calls back", async () => {
  const closed: boolean[] = [];
  await window.watchWindow(child("setTimeout(() => {}, 300)"), () => closed.push(true), 0.1);
  expect(closed).toEqual([true]);
});

test("a quick handoff is not a close", async () => {
  // The browser passed the URL to a Luna window that was already open.
  const closed: boolean[] = [];
  await window.watchWindow(child(""), () => closed.push(true), 5);
  expect(closed).toEqual([]);
});

test("the desktop entry", () => {
  const file = window.installDesktopEntry(path.join(tmpDir(), "applications"));
  const text = readFileSync(file, "utf8");
  expect(path.basename(file)).toBe("luna.desktop");
  for (const part of ["Name=Luna", "StartupWMClass=Luna", "Terminal=false", "luna-web", window.ICON_PATH]) expect(text).toContain(part);
});

// --- main() -----------------------------------------------------------------------

function stubbed(running: boolean) {
  const calls = { opened: [] as [string, string | null][], served: 0 };
  const settings = loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "t", web_host: "127.0.0.1", web_port: 8765, web_open_window: true } });
  const real = { ...mainHooks };
  mainHooks.getSettings = () => settings;
  mainHooks.window = {
    ...window,
    findBrowser: () => "/usr/bin/chromium",
    openWindow: (url: string, browser: string | null) => {
      calls.opened.push([url, browser]);
      return null;
    },
    serverRunning: async () => running,
    waitForServer: async () => false,
  } as typeof window;
  mainHooks.startServer = (async () => {
    calls.served += 1;
    return { close: async () => undefined } as never;
  }) as never;
  return { calls, restore: () => Object.assign(mainHooks, real) };
}

test("already running: just open a window", async () => {
  const { calls, restore } = stubbed(true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await main([]);
  restore();
  expect(calls.served).toBe(0);
  expect(calls.opened).toEqual([["http://127.0.0.1:8765/?window=app", "/usr/bin/chromium"]]);
});

test("--no-window only serves", async () => {
  const { calls, restore } = stubbed(false);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await main(["--no-window"]);
  restore();
  expect(calls.served).toBe(1);
  expect(calls.opened).toEqual([]);
});

test("--install-desktop", async () => {
  const real = { ...mainHooks };
  const target = path.join(tmpDir(), "luna.desktop");
  mainHooks.window = { ...window, installDesktopEntry: () => target } as typeof window;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await main(["--install-desktop"]);
  Object.assign(mainHooks, real);
  expect(log.mock.calls.flat().join(" ")).toContain("luna.desktop");
  expect(existsSync(target)).toBe(false); // the stub didn't write anything
});

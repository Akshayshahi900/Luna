/**
 * Open Luna in its own app window, like a desktop application.
 *
 * BEGINNER MAP
 * ------------
 * `luna-web` starts the server and then opens the UI in a Chromium-family
 * browser (Chrome, Chromium, Edge, Brave) in **app mode**:
 *
 *   chrome --app=http://127.0.0.1:8765/?window=app --user-data-dir=data/app-window ...
 *
 * App mode means no tabs, no address bar, its own taskbar entry and icon.
 * The separate profile (data/app-window/) remembers the window size and the
 * microphone permission, and never mixes with your normal browsing.
 * `?window=app` tells the page it is the app window: it skips the ENGAGE
 * click (audio autoplay is allowed for this window) and blocks browser-only
 * things such as the right-click menu.
 *
 * Closing the window stops luna-web (LUNA_WEB_CLOSE_WITH_WINDOW), so it
 * behaves like quitting an app. Without a Chromium browser the page opens in
 * your default browser instead, and the server keeps running.
 *
 * Running `luna-web` while it already runs just opens another window, so
 * the launcher entry from `luna-web --install-desktop` works like an app icon.
 *
 * Why not Electron / a system web view: the HUD needs WebGL, the microphone
 * and an AudioWorklet. The system web views (WebKitGTK on Linux) handle
 * these poorly, and Electron would bundle a second browser (DECISIONS.md D37).
 *
 * Read next: web/server.ts (main)
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { PROJECT_ROOT } from "../config/settings.ts";

// Tried in order when LUNA_WEB_BROWSER is not set.
export const BROWSER_NAMES = [
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge",
  "microsoft-edge-stable", "brave-browser", "brave", "chrome", "msedge",
];
// Common install paths that are not on PATH (macOS app bundles, Windows).
export const BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
export const DEFAULT_PROFILE = path.join(PROJECT_ROOT, "data", "app-window");
export const ICON_PATH = path.join(PROJECT_ROOT, "web", "public", "luna.svg");
export const WINDOW_CLASS = "Luna"; // Linux WM_CLASS: groups the window with the launcher entry
export const WINDOW_SIZE: [number, number] = [1440, 900];
// A browser that exits this fast handed the URL to a window it already had
// open; that is not the user closing Luna.
export const HANDOFF_SECONDS = 4;

/** Where this machine reaches the server (0.0.0.0 / :: → 127.0.0.1). */
export function baseUrl(host: string, port: number): string {
  if (["0.0.0.0", "::", ""].includes(host)) host = "127.0.0.1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${port}`;
}

/** The page address for the app window. */
export function appUrl(host: string, port: number): string {
  return `${baseUrl(host, port)}/?window=app`;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Like shutil.which: the full path of a command on PATH, or null. */
export function which(name: string): string | null {
  if (name.includes(path.sep)) return isFile(name) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) {
      try {
        execFileSync("test", ["-x", candidate]);
        return candidate;
      } catch {
        if (process.platform === "win32") return candidate;
      }
    }
  }
  return null;
}

/**
 * A Chromium-family browser to run in app mode, or null.
 * `preferred` (LUNA_WEB_BROWSER) may be a command name or a full path.
 */
export function findBrowser(preferred: string | null = null, lookup: (name: string) => string | null = which): string | null {
  if (preferred) return lookup(preferred) ?? (isFile(preferred) ? preferred : null);
  for (const name of BROWSER_NAMES) {
    const found = lookup(name);
    if (found) return found;
  }
  return BROWSER_PATHS.find(isFile) ?? null;
}

/** The command line that opens `url` as an app window. */
export function appCommand(browser: string, url: string, profile: string, size: [number, number] = WINDOW_SIZE): string[] {
  return [
    browser,
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    `--class=${WINDOW_CLASS}`,
    `--window-size=${size[0]},${size[1]}`,
    // Luna speaks as soon as she is ready, without an ENGAGE click.
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
  ];
}

/** True if a Luna server answers /api/health at the given base URL. */
export async function serverRunning(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Poll /api/health until the server is up (the agent takes a while to build). */
export async function waitForServer(url: string, timeoutMs = 120_000, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverRunning(url)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Open `url` in the default browser (xdg-open / open / start). */
export function openDefaultBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

/** Replaceable in tests. */
export const hooks = { openDefault: openDefaultBrowser };

/**
 * Open the app window. Returns the browser process, or null if the page went
 * to the default browser instead (no Chromium-family browser found).
 */
export function openWindow(url: string, browser: string | null, profile: string = DEFAULT_PROFILE): ChildProcess | null {
  if (!browser) {
    console.error("No Chrome / Chromium / Edge / Brave found: opening your default browser.");
    hooks.openDefault(url);
    return null;
  }
  mkdirSync(profile, { recursive: true });
  const [command, ...args] = appCommand(browser, url, profile);
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true, // Ctrl+C in the terminal stops the server, which then closes nothing else
  });
  child.on("error", (error) => console.error(`Could not open the app window: ${error.message}`));
  return child;
}

/**
 * Call `onClosed` when the app window's process exits.
 *
 * An exit within `handoff` seconds means the browser handed the page to an
 * already-open Luna window; then nothing is closed.
 */
export function watchWindow(proc: ChildProcess, onClosed: () => void, handoff = HANDOFF_SECONDS): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const done = () => {
      if (Date.now() - started >= handoff * 1000) onClosed();
      resolve();
    };
    if (proc.exitCode !== null || proc.signalCode !== null) done();
    else proc.once("exit", done);
  });
}

/** A freedesktop .desktop file that starts Luna from the app launcher. */
export function desktopEntry(command: string, icon: string = ICON_PATH): string {
  return (
    "[Desktop Entry]\n" +
    "Type=Application\n" +
    "Name=Luna\n" +
    "GenericName=Voice assistant\n" +
    "Comment=Luna, your local AI assistant\n" +
    `Exec=${command}\n` +
    `Icon=${icon}\n` +
    "Terminal=false\n" +
    "Categories=Utility;\n" +
    `StartupWMClass=${WINDOW_CLASS}\n` +
    "Keywords=assistant;voice;ai;\n"
  );
}

/**
 * Write ~/.local/share/applications/luna.desktop (Linux) and return its path.
 * The entry runs this checkout's core/bin/luna-web.ts with this Node, so it
 * always uses this checkout and its .env.
 */
export function installDesktopEntry(applicationsDir?: string): string {
  const dir = applicationsDir ?? path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "applications");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "luna.desktop");
  const script = path.join(PROJECT_ROOT, "core", "bin", "luna-web.ts");
  writeFileSync(file, desktopEntry(`"${process.execPath}" "${script}"`), "utf8");
  chmodSync(file, 0o755);
  return file;
}

export { existsSync as _exists };

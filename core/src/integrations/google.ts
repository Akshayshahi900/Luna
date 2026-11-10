/**
 * Google sign-in shared by the MCP servers (Gmail, Calendar, Tasks).
 *
 * BEGINNER MAP
 * ------------
 * servers/mail.ts (Gmail API), servers/google.ts (Calendar) and
 * servers/tasks.ts (Google Tasks sync) all talk to Google with ONE OAuth
 * sign-in, kept in data/google/token.json.
 *
 * Once (docs/google.md):
 *
 *   1. Google Cloud Console → enable Gmail, Google Calendar and Google Tasks
 *      APIs → OAuth client of type "Desktop app" → download the JSON to
 *      data/google/credentials.json (or set LUNA_GOOGLE_CREDENTIALS_PATH).
 *   2. pnpm google-auth  (the luna-google-auth command)
 *      (opens the browser, saves the token; it is refreshed automatically)
 *
 * The servers never open a browser themselves: they run as stdio
 * subprocesses, so a missing or too-narrow sign-in is reported as an error
 * message that tells the user to run luna-google-auth.
 *
 * token.json keeps the format the Python version wrote (google-auth's
 * "authorized user" JSON: token, refresh_token, client_id, client_secret,
 * scopes, expiry), so an existing sign-in keeps working.
 *
 * Tests replace `hooks.service` with a fake API client.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { loadSettings, type Settings } from "../config/settings.ts";

export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/gmail.readonly", // reading never marks mail as read
  "https://www.googleapis.com/auth/gmail.send",
];
const HOW = "run `pnpm google-auth` (luna-google-auth, see docs/google.md)";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
// Refresh a little before the real expiry, like google-auth does.
const EXPIRY_MARGIN_MS = 4 * 60 * 1000;

/** No usable sign-in. Tools show the message; task sync just stays local. */
export class GoogleNotConnected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleNotConnected";
  }
}

/** The saved sign-in (google-auth's authorized-user JSON). */
export interface SavedToken {
  token?: string | null;
  refresh_token?: string | null;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  expiry?: string | null;
  universe_domain?: string;
  account?: string;
}

function saveToken(file: string, token: SavedToken): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file.replace(/\.json$/, "") + ".tmp";
  writeFileSync(tmp, JSON.stringify(token), "utf8");
  chmodSync(tmp, 0o600); // the token is a key to the account
  renameSync(tmp, file);
}

function readToken(file: string): SavedToken {
  return JSON.parse(readFileSync(file, "utf8")) as SavedToken;
}

/** "2026-11-09T10:00:00.123456Z" (Python, maybe without Z) → milliseconds. */
function expiryMs(expiry: string | null | undefined): number | null {
  if (!expiry) return null;
  const text = /[zZ]|[+-]\d\d:?\d\d$/.test(expiry) ? expiry : expiry + "Z";
  const ms = Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? null : ms;
}

function isoExpiry(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/** A token file exists (cheap check; it may still be expired). */
export function isConnected(settings: Settings): boolean {
  return existsSync(settings.google_token_path);
}

type OAuth2Client = InstanceType<(typeof import("googleapis"))["google"]["auth"]["OAuth2"]>;

async function googleLib() {
  // Loaded on first use: googleapis is large and most tool calls never need it.
  return (await import("googleapis")).google;
}

/** Saved credentials as an OAuth client, refreshed (and re-saved) when expired. */
export async function credentials(settings: Settings): Promise<OAuth2Client> {
  const file = settings.google_token_path;
  if (!existsSync(file)) throw new GoogleNotConnected(`Google is not connected: ${HOW}.`);
  const saved = readToken(file);
  // Keep the scopes the token was granted, so an old token from before Gmail
  // was added is noticed.
  const granted = new Set(saved.scopes ?? []);
  if (!SCOPES.every((s) => granted.has(s))) {
    throw new GoogleNotConnected(`The Google sign-in is missing access Luna needs: ${HOW} again.`);
  }
  const google = await googleLib();
  const client = new google.auth.OAuth2(saved.client_id, saved.client_secret);
  const expires = expiryMs(saved.expiry);
  const valid = Boolean(saved.token) && (expires === null || expires - EXPIRY_MARGIN_MS > Date.now());
  client.setCredentials({
    access_token: saved.token ?? undefined,
    refresh_token: saved.refresh_token ?? undefined,
    expiry_date: expires ?? undefined,
    scope: [...granted].join(" "),
  });
  // Any later automatic refresh (long calls) is saved too.
  client.on("tokens", (tokens) => {
    saveToken(file, {
      ...readToken(file),
      token: tokens.access_token ?? saved.token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expiry: isoExpiry(tokens.expiry_date) ?? saved.expiry ?? null,
    });
  });
  if (valid) return client;
  if (saved.refresh_token) {
    await client.refreshAccessToken(); // fires "tokens" → saved
    return client;
  }
  throw new GoogleNotConnected(`The Google sign-in has expired: ${HOW} again.`);
}

export type GoogleApi = "gmail" | "calendar" | "tasks";

async function defaultService(api: GoogleApi, version: string, settings?: Settings): Promise<any> {
  const auth = await credentials(settings ?? loadSettings());
  const google = await googleLib();
  return (google as any)[api]({ version, auth });
}

/** Replaceable in tests (like monkeypatching google_api.service in Python). */
export const hooks = { service: defaultService };

/** A Google API client: ("gmail", "v1"), ("calendar", "v3") or ("tasks", "v1"). */
export function service(api: GoogleApi, version: string, settings?: Settings): Promise<any> {
  return hooks.service(api, version, settings);
}

/** Await a Google API request; turn HTTP errors into a short message for the model. */
export async function execute<T = any>(request: Promise<{ data: T }> | { data: T }): Promise<T> {
  try {
    return (await request).data;
  } catch (error) {
    const e = error as { response?: { status?: number }; status?: number; code?: unknown; errors?: { reason?: string; message?: string }[]; message?: string };
    const status = e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
    if (status === undefined) throw error;
    const reason = e.errors?.[0]?.message ?? e.message ?? String(error);
    throw new Error(`Google API error ${status}: ${reason}`);
  }
}

/** Browser sign-in on a local loopback port; saves the token. */
export async function authorize(settings: Settings = loadSettings(), openUrl?: (url: string) => void): Promise<string> {
  const clientFile = settings.google_credentials_path;
  if (!existsSync(clientFile)) {
    throw new Error(
      `No OAuth client file at ${clientFile}. Download a 'Desktop app' OAuth client ` +
        "from Google Cloud Console there (see docs/google.md).",
    );
  }
  const raw = JSON.parse(readFileSync(clientFile, "utf8"));
  const info = raw.installed ?? raw.web ?? raw;
  const google = await googleLib();

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const got = url.searchParams.get("code");
      const failed = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(got ? "Signed in to Google. You can close this tab." : `Sign-in failed: ${failed ?? "no code"}`);
      server.close();
      const port = (server.address() as { port: number } | null)?.port;
      if (got) resolve({ code: got, redirect: `http://127.0.0.1:${port}` });
      else reject(new Error(`Google sign-in failed: ${failed ?? "no code"}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const client = new google.auth.OAuth2(info.client_id, info.client_secret, `http://127.0.0.1:${port}`);
      const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
      console.log(`Opening your browser to sign in to Google. If it doesn't open, visit:\n${url}`);
      (openUrl ?? openInBrowser)(url);
    });
  });

  const client = new google.auth.OAuth2(info.client_id, info.client_secret, code.redirect);
  const { tokens } = await client.getToken(code.code);
  saveToken(settings.google_token_path, {
    token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? null,
    token_uri: info.token_uri ?? TOKEN_URI,
    client_id: info.client_id,
    client_secret: info.client_secret,
    scopes: (tokens.scope ?? SCOPES.join(" ")).split(" ").filter(Boolean),
    universe_domain: "googleapis.com",
    account: "",
    expiry: isoExpiry(tokens.expiry_date),
  });
  return settings.google_token_path;
}

function openInBrowser(url: string): void {
  void import("node:child_process").then(({ spawn }) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  });
}

/** Entry point of `luna-google-auth`. */
export async function main(): Promise<void> {
  try {
    console.log(`Signed in to Google. Token saved to ${await authorize()}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

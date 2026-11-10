/**
 * Runs before every test file (vitest setupFiles).
 *
 * Never use a real Google sign-in in tests (Gmail, Calendar, Tasks sync):
 * each test gets a token path that doesn't exist. Tests that need Google
 * replace the Google services with fakes.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach } from "vitest";

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "luna-google-"));
  process.env.LUNA_GOOGLE_TOKEN_PATH = path.join(dir, "no-google-token.json");
});

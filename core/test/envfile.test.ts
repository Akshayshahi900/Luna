// Editing .env from the Control Center: envfile (read / update in place) and
// schema (field descriptions, validation, rollback). No network, no LLM.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { EnvFileError, formatValue, parseValue, readEnv, updateEnv } from "../src/config/envfile.ts";
import { applies, GROUPS, saveSettings, SECRETS, SettingsRejected, settingsSchema, toEnv } from "../src/config/schema.ts";
import { FIELD_NAMES, loadSettings } from "../src/config/settings.ts";
import { tmpDir } from "./helpers.ts";

const mode = (f: string) => statSync(f).mode & 0o777;

describe("envfile", () => {
  test("parseValue handles quotes and comments", () => {
    expect(parseValue(" plain ")).toBe("plain");
    expect(parseValue('"two words"')).toBe("two words");
    expect(parseValue("'single'")).toBe("single");
    expect(parseValue('"say \\"hi\\""')).toBe('say "hi"');
    expect(parseValue("value # a comment")).toBe("value");
    expect(parseValue('"a # not a comment" # but this is')).toBe("a # not a comment");
  });

  test("formatValue quotes only when needed", () => {
    expect(formatValue("metric")).toBe("metric");
    expect(formatValue("a,b,c")).toBe("a,b,c");
    expect(formatValue("http://localhost:5173")).toBe("http://localhost:5173");
    expect(formatValue("two words")).toBe('"two words"');
    expect(formatValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(parseValue(formatValue('back\\slash "q" #x'))).toBe('back\\slash "q" #x');
  });

  test("update keeps comments, order and unrelated lines", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, "# Luna\nLUNA_UNITS=metric\n\n# keys\nexport LUNA_GROQ_MODEL=old\nOTHER=keep # untouched\n");
    updateEnv(env, { LUNA_UNITS: "imperial", LUNA_GROQ_MODEL: null, LUNA_USER_NAME: "Ada Lovelace" });
    expect(readFileSync(env, "utf8")).toBe(
      '# Luna\nLUNA_UNITS=imperial\n\n# keys\nOTHER=keep # untouched\nLUNA_USER_NAME="Ada Lovelace"\n',
    );
    expect(readEnv(env)).toEqual({ LUNA_UNITS: "imperial", OTHER: "keep", LUNA_USER_NAME: "Ada Lovelace" });
  });

  test("comments after a value are kept", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, 'LUNA_STT_MODEL=base.en        # tiny.en | base.en\nLUNA_USER_NAME="Al" # me\n');
    updateEnv(env, { LUNA_STT_MODEL: "small.en", LUNA_USER_NAME: "Ada L" });
    expect(readFileSync(env, "utf8")).toBe('LUNA_STT_MODEL=small.en        # tiny.en | base.en\nLUNA_USER_NAME="Ada L"  # me\n');
    expect(readEnv(env)).toEqual({ LUNA_STT_MODEL: "small.en", LUNA_USER_NAME: "Ada L" });
  });

  test("update drops later duplicates", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, "A=1\nB=2\nA=3\n");
    updateEnv(env, { A: "9" });
    expect(readFileSync(env, "utf8")).toBe("A=9\nB=2\n");
  });

  test("commented-out keys are left alone", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, "# LUNA_UNITS=imperial\n");
    updateEnv(env, { LUNA_UNITS: "metric" });
    expect(readFileSync(env, "utf8")).toBe("# LUNA_UNITS=imperial\nLUNA_UNITS=metric\n");
  });

  test("update refuses newlines and bad keys", () => {
    const env = path.join(tmpDir(), ".env");
    expect(() => updateEnv(env, { LUNA_X: "a\nLUNA_AUTO_APPROVE=run_command" })).toThrow(EnvFileError);
    expect(() => updateEnv(env, { "BAD KEY": "x" })).toThrow(EnvFileError);
    expect(existsSync(env)).toBe(false);
  });

  test("a new file is private and an existing mode is kept", () => {
    const dir = tmpDir();
    const env = path.join(dir, ".env");
    updateEnv(env, { A: "1" });
    expect(mode(env)).toBe(0o600);
    chmodSync(env, 0o640);
    updateEnv(env, { A: "2" });
    expect(mode(env)).toBe(0o640);
    expect(existsSync(path.join(dir, ".env.tmp"))).toBe(false);
  });
});

describe("schema", () => {
  test("every setting is in exactly one group", () => {
    const grouped = GROUPS.flatMap(([, , fields]) => fields);
    expect([...grouped].sort()).toEqual([...FIELD_NAMES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("when changes apply", () => {
    expect(applies("mail_address")).toBe("live"); // MCP servers read .env per call
    expect(applies("response_style")).toBe("rebuild");
    expect(applies("auto_approve")).toBe("rebuild");
    expect(applies("web_port")).toBe("restart");
  });

  test("schema masks secrets and lists unknown keys", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, "LUNA_GROQ_API_KEY=gsk_secret\nLUNA_DEFAULT_THREAD_ID=old\nLUNA_UNITS=imperial\n");
    const schema = settingsSchema(loadSettings({ envFile: env, env: {} }), env);
    const fields = Object.fromEntries(schema.groups.flatMap((g) => g.fields).map((f) => [f.name, f]));
    expect(fields.groq_api_key.value).toBeNull();
    expect(fields.groq_api_key.is_set).toBe(true);
    expect(fields.groq_api_key.default).toBeNull();
    expect(JSON.stringify(schema)).not.toContain("gsk_secret");
    expect(fields.units).toMatchObject({ value: "imperial", in_file: true, choices: ["metric", "imperial"] });
    expect(fields.auto_approve.kind).toBe("list");
    expect(fields.web_port.kind).toBe("int");
    expect(fields.enable_mcp_tools.kind).toBe("bool");
    expect(schema.unknown).toEqual(["LUNA_DEFAULT_THREAD_ID"]);
    for (const secret of SECRETS) expect(fields).toHaveProperty(secret);
  });

  test("toEnv formats by kind", () => {
    expect(toEnv("bool", true)).toBe("true");
    expect(toEnv("bool", false)).toBe("false");
    expect(toEnv("list", ["a", " b ", ""])).toBe("a,b");
    expect(toEnv("list", [])).toBeNull();
    expect(toEnv("int", 5)).toBe("5");
    expect(toEnv("str", "  ")).toBeNull();
    expect(toEnv("str", null)).toBeNull();
  });

  test("saveSettings writes and validates", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, "# mine\nLUNA_UNITS=metric\nLUNA_DEFAULT_THREAD_ID=old\n");
    const { settings, effects } = saveSettings(
      env, { units: "imperial", auto_approve: ["write_file"], web_port: 9000 }, ["LUNA_DEFAULT_THREAD_ID"], {},
    );
    expect(settings.units).toBe("imperial");
    expect(settings.auto_approve).toEqual(["write_file"]);
    expect(effects).toEqual({ units: "rebuild", auto_approve: "rebuild", web_port: "restart" });
    expect(readFileSync(env, "utf8")).toBe("# mine\nLUNA_UNITS=imperial\nLUNA_AUTO_APPROVE=write_file\nLUNA_WEB_PORT=9000\n");
  });

  test("an invalid value restores the file exactly", () => {
    const env = path.join(tmpDir(), ".env");
    const original = "# keep   me\nLUNA_UNITS = metric\n";
    writeFileSync(env, original);
    expect(() => saveSettings(env, { units: "furlongs" }, [], {})).toThrow(/LUNA_UNITS/);
    expect(readFileSync(env, "utf8")).toBe(original);
    expect(() => saveSettings(env, { not_a_setting: 1 }, [], {})).toThrow(/Unknown setting/);
    expect(() => saveSettings(env, {}, ["LUNA_UNITS"], {})).toThrow(SettingsRejected); // known keys aren't "unknown"
    expect(readFileSync(env, "utf8")).toBe(original);
  });
});

describe("settings", () => {
  test("defaults keep API calls low", () => {
    const s = loadSettings({ envFile: null, env: {} });
    expect([s.max_model_calls, s.max_tool_calls, s.task_budget]).toEqual([10, 20, 30]);
    expect(s.model_max_retries).toBe(1);
  });

  test("env beats .env, overrides beat env; lists and choices are parsed", () => {
    const env = path.join(tmpDir(), ".env");
    writeFileSync(env, "LUNA_UNITS=imperial\nLUNA_WEB_PORT=1\nLUNA_TELEGRAM_ALLOWED_USERS=1, 2\n");
    const s = loadSettings({ envFile: env, env: { LUNA_WEB_PORT: "2", LUNA_PROVIDER: " Groq " }, overrides: { units: "metric" } });
    expect(s.units).toBe("metric");
    expect(s.web_port).toBe(2);
    expect(s.provider).toBe("groq");
    expect(s.telegram_allowed_users).toEqual([1, 2]);
    expect(() => loadSettings({ envFile: null, env: { LUNA_WEB_PORT: "x" } })).toThrow(/LUNA_WEB_PORT/);
  });
});

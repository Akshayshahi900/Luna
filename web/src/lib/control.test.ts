import { describe, expect, it } from "vitest";
import {
  fieldText,
  formatBytes,
  formatDuration,
  insightLine,
  isLoopback,
  parseField,
  searchFields,
  sparkPath,
  until,
  type RoutineRun,
  type SettingGroup,
} from "./control";

const run = (data: unknown, status: RoutineRun["status"] = "ok"): RoutineRun => ({
  id: 1,
  routine_id: 1,
  started_at: "2026-10-18T10:00:00+00:00",
  finished_at: "2026-10-18T10:00:01+00:00",
  status,
  summary: "",
  data,
  error: null,
});

describe("formatting", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(13 * 1024 * 1024)).toBe("13 MB");
    expect(formatBytes(null)).toBe("—");
  });
  it("formats durations", () => {
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3725)).toBe("1h 2m");
    expect(formatDuration(90061)).toBe("1d 1h");
  });
  it("says how long until a run", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(until("2026-10-18T12:05:00Z", now)).toBe("in 5 min");
    expect(until("2026-10-18T15:00:00Z", now)).toBe("in 3 h");
    expect(until("2026-10-21T12:00:00Z", now)).toBe("in 3 d");
    expect(until("2026-10-18T11:00:00Z", now)).toBe("now");
    expect(until(null, now)).toBe("");
  });
});

describe("settings fields", () => {
  it("round-trips values through text inputs", () => {
    expect(fieldText(["a", "b"])).toBe("a, b");
    expect(fieldText(null)).toBe("");
    expect(parseField("list", "a, b ,, c")).toEqual(["a", "b", "c"]);
    expect(parseField("int", "42")).toBe(42);
    expect(parseField("float", "0.95")).toBe(0.95);
    expect(parseField("str", "  ")).toBeNull();
    expect(() => parseField("int", "4.5")).toThrow("whole number");
  });

  it("searches names, env keys, descriptions and group titles", () => {
    const groups = [
      {
        id: "voice",
        title: "Voice",
        fields: [
          { name: "tts_engine", env: "LUNA_TTS_ENGINE", description: "piper or browser" },
          { name: "stt_model", env: "LUNA_STT_MODEL", description: "Whisper model" },
        ],
      },
    ] as unknown as SettingGroup[];
    expect(searchFields(groups, "whisper")[0].fields.map((f) => f.name)).toEqual(["stt_model"]);
    expect(searchFields(groups, "luna_tts")[0].fields).toHaveLength(1);
    expect(searchFields(groups, "voice")[0].fields).toHaveLength(2);
    expect(searchFields(groups, "nothing")).toEqual([]);
    expect(searchFields(groups, " ")).toBe(groups);
  });

  it("knows which hosts are local", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.4")).toBe(false);
  });
});

describe("sparkPath", () => {
  it("draws from the bottom up and fits the box", () => {
    expect(sparkPath([], 100, 20)).toBe("");
    expect(sparkPath([0, 10], 100, 20, 0)).toBe("M0.0 20.0 L100.0 0.0");
    expect(sparkPath([5], 100, 20, 0)).toBe("M0.0 0.0");
  });
});

describe("insightLine", () => {
  it("summarizes mail", () => {
    expect(insightLine("mail_check", run({ unread: 2, items: [{ from: "Ann", subject: "Lunch?" }] }))).toEqual({
      title: "2 unread",
      detail: "Ann: Lunch?",
    });
    expect(insightLine("mail_check", run({ unread: 0, items: [] }))?.title).toBe("Inbox zero");
  });
  it("summarizes the agenda", () => {
    const line = insightLine("agenda", run({ events: [{}, {}], next: { title: "Dentist", start: "2026-10-18T15:00:00+00:00" } }));
    expect(line).toEqual({ title: "2 events today", detail: "Next · 15:00 Dentist" });
    expect(insightLine("agenda", run({ events: [], next: null }))?.title).toBe("Clear calendar");
  });
  it("summarizes to-dos", () => {
    expect(insightLine("todos", run({ open: 3, due_today: 1, overdue: 1, items: [] }))).toEqual({
      title: "3 to-dos",
      detail: "1 due today · 1 overdue",
    });
  });
  it("hides failed or missing runs", () => {
    expect(insightLine("todos", undefined)).toBeNull();
    expect(insightLine("todos", run(null, "error"))).toBeNull();
  });
});

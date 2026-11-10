import { expect, test } from "vitest";

import { calculator, getBuiltinTools, getCurrentTime, pyFloat } from "../src/tools/builtin/index.ts";

test.each([
  ["(3 + 5) * 12", "96"], ["2 ** 10", "1024"], ["7 // 2", "3"], ["-4 + 1", "-3"], ["2 ** -1", "0.5"],
  ["-7 // 2", "-4"], ["-7 % 3", "2"], ["4 / 2", "2.0"], ["-2 ** 2", "-4"], ["2 ** 3 ** 2", "512"],
  ["2 ** 100", "1267650600228229401496703205376"], ["1e16 + 0", "1e+16"], ["0.1 + 0.2", "0.30000000000000004"],
])("arithmetic %s", async (expression, expected) => {
  expect(await calculator.invoke({ expression })).toBe(expected);
});

test.each(["__import__('os')", "x + 1", "abs(-1)", "'a' * 3"])("rejects non-arithmetic %s", async (expression) => {
  expect(await calculator.invoke({ expression })).toMatch(/^Could not evaluate/);
});

test.each(["9**9**9**9", "10**999 * 10**999", "2**100000"])("huge numbers fail fast %s", async (expression) => {
  const start = performance.now();
  expect(await calculator.invoke({ expression })).toMatch(/^Could not evaluate/);
  expect(performance.now() - start).toBeLessThan(1000);
});

test("floats print like Python", () => {
  expect(pyFloat(0.00001)).toBe("1e-05");
  expect(pyFloat(0.0001)).toBe("0.0001");
  expect(pyFloat(1.5e200)).toBe("1.5e+200");
  expect(pyFloat(123.0)).toBe("123.0");
});

test("current time", async () => {
  expect(await getCurrentTime.invoke({ timezone_name: "UTC" })).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(UTC\+0000\)$/);
  expect(await getCurrentTime.invoke({ timezone_name: "Asia/Kolkata" })).toMatch(/\(UTC\+0530\)$/);
  expect(await getCurrentTime.invoke({ timezone_name: "Mars/Base" })).toMatch(/^Unknown timezone/);
});

test("builtin tool names", () => {
  expect(new Set(getBuiltinTools().map((t) => t.name))).toEqual(new Set(["get_current_time", "calculator", "ask_user"]));
});

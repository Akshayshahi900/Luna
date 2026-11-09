/**
 * Built-in tools — normal TypeScript functions Luna can call without MCP.
 *
 * BEGINNER MAP
 * ------------
 * A "tool" is just a function the language model is allowed to use.
 *
 * tool() (from LangChain) takes the function plus a name, a description and
 * a zod schema of its arguments, and turns that into something the model
 * understands ("there is a tool called calculator that takes an expression
 * string").
 *
 * The description matters! The model uses it to decide WHEN to call the tool.
 *
 * To add your own tool:
 *   1. Write a tool() below (or in its own file).
 *   2. Add it to the list in getBuiltinTools() at the bottom.
 *   3. Restart `luna` and check with /tools.
 */

import { tool } from "@langchain/core/tools";
import * as z from "zod";

import type { AnyTool } from "../registry.ts";
import { askUser } from "./ask_user.ts";

// Limits so a request like 9**9**9**9 can't freeze the process.
const MAX_EXPONENT = 1000;
const MAX_INT_DIGITS = 1000;

// --- A tiny Python-style arithmetic evaluator ---------------------------------
// Why not eval(expression)? Because eval can run arbitrary code (files,
// network, ...). Parsing the text ourselves lets us allow only math, and
// keeps Python's number rules: exact big integers, // and % that round
// toward minus infinity, and "/" that always gives a float.

type Num = { int: bigint } | { float: number };

const isInt = (n: Num): n is { int: bigint } => "int" in n;
const toFloat = (n: Num): number => (isInt(n) ? Number(n.int) : n.float);

function bitLength(value: bigint): number {
  return value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length;
}

/** Reject integers so big they would be slow to compute or print. */
function checkSize(value: Num): Num {
  if (isInt(value) && bitLength(value.int) > MAX_INT_DIGITS * 4) throw new Error("Result too large");
  return value;
}

function floorDivInt(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function binary(op: string, a: Num, b: Num): Num {
  if (op === "**") {
    const exponent = toFloat(b);
    if (Math.abs(exponent) > MAX_EXPONENT) throw new Error(`Exponent too large (max ${MAX_EXPONENT})`);
    if (isInt(a) && isInt(b)) {
      if (b.int >= 0n) return { int: a.int ** b.int };
      if (a.int === 0n) throw new Error("0.0 cannot be raised to a negative power");
      return { float: Number(a.int) ** Number(b.int) };
    }
    const result = toFloat(a) ** toFloat(b);
    if (Number.isNaN(result)) throw new Error("math domain error");
    if (!Number.isFinite(result)) throw new Error("Numerical result out of range");
    return { float: result };
  }
  if (isInt(a) && isInt(b)) {
    switch (op) {
      case "+": return { int: a.int + b.int };
      case "-": return { int: a.int - b.int };
      case "*": return { int: a.int * b.int };
      case "//":
        if (b.int === 0n) throw new Error("integer division or modulo by zero");
        return { int: floorDivInt(a.int, b.int) };
      case "%":
        if (b.int === 0n) throw new Error("integer modulo by zero");
        return { int: a.int - b.int * floorDivInt(a.int, b.int) };
    }
  }
  const x = toFloat(a);
  const y = toFloat(b);
  switch (op) {
    case "+": return { float: x + y };
    case "-": return { float: x - y };
    case "*": return { float: x * y };
    case "/":
      if (y === 0) throw new Error("division by zero");
      return { float: x / y };
    case "//":
      if (y === 0) throw new Error("float floor division by zero");
      return { float: Math.floor(x / y) };
    case "%": {
      if (y === 0) throw new Error("float modulo by zero");
      const m = x % y;
      return { float: m !== 0 && (m < 0) !== (y < 0) ? m + y : m };
    }
  }
  throw new Error("Only basic arithmetic is allowed");
}

const TOKEN = /\s*(?:(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)|((?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*\.)|(\*\*|\/\/|[-+*/%()])|(\S))/y;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (TOKEN.lastIndex < text.length && (match = TOKEN.exec(text))) {
    if (match[4] !== undefined) {
      // Letters, quotes, brackets, ...: names, strings and calls are not math.
      if (/[\w'"[\]{},.:=<>!&|^~@]/.test(match[4])) throw new Error("Only basic arithmetic is allowed");
      throw new Error("invalid syntax");
    }
    tokens.push(match[1] ?? match[2] ?? match[3]);
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
  }
  return tokens;
}

function parseNumber(token: string): Num {
  const clean = token.replaceAll("_", "");
  if (/^0[xXoObB]/.test(clean)) return { int: BigInt(clean.toLowerCase()) };
  if (/^\d+$/.test(clean)) return { int: BigInt(clean) };
  return { float: Number(clean) };
}

/** Evaluate `text` with Python's arithmetic rules. Throws on anything else. */
export function evaluate(text: string): Num {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const isNumber = (t: string | undefined) => t !== undefined && /^[\d.]/.test(t);

  // expr := term (('+'|'-') term)*
  const expr = (): Num => {
    let left = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++];
      left = checkSize(binary(op, left, term()));
    }
    return left;
  };
  // term := factor (('*'|'/'|'//'|'%') factor)*
  const term = (): Num => {
    let left = factor();
    while (["*", "/", "//", "%"].includes(peek() ?? "")) {
      const op = tokens[pos++];
      left = checkSize(binary(op, left, factor()));
    }
    return left;
  };
  // factor := ('+'|'-') factor | power   (so -2**2 is -(2**2), like Python)
  const factor = (): Num => {
    if (peek() === "-" || peek() === "+") {
      const op = tokens[pos++];
      const value = factor();
      if (op === "+") return value;
      return checkSize(isInt(value) ? { int: -value.int } : { float: -value.float });
    }
    return power();
  };
  // power := atom ['**' factor]   (right-associative)
  const power = (): Num => {
    const base = atom();
    if (peek() === "**") {
      pos++;
      return checkSize(binary("**", base, factor()));
    }
    return base;
  };
  const atom = (): Num => {
    const token = tokens[pos++];
    if (token === "(") {
      const value = expr();
      if (tokens[pos++] !== ")") throw new Error("invalid syntax");
      return value;
    }
    if (isNumber(token)) return parseNumber(token!);
    throw new Error("invalid syntax");
  };

  if (!tokens.length) throw new Error("invalid syntax");
  const result = expr();
  if (pos !== tokens.length) throw new Error("invalid syntax");
  return result;
}

/** A float the way Python's repr() writes it (2.0, 0.5, 1e+16, 1e-05). */
export function pyFloat(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mantissa, expText] = Math.abs(x).toExponential().split("e");
  const exp = Number(expText);
  const digits = mantissa.replace(".", "");
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

export const calculator = tool(
  async ({ expression }) => {
    try {
      const result = evaluate(expression);
      return isInt(result) ? result.int.toString() : pyFloat(result.float);
    } catch (error) {
      return `Could not evaluate expression: ${(error as Error).message}`;
    }
  },
  {
    name: "calculator",
    description:
      "Evaluate a simple arithmetic expression.\n\n" +
      "Supports +, -, *, /, //, %, **, and parentheses. No variables or function calls.",
    schema: z.object({ expression: z.string().describe("Math expression, e.g. '(3 + 5) * 12'.") }),
  },
);

/** "2026-11-09 14:30:00 IST (UTC+0530)" for an IANA timezone. */
export function formatNow(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", timeZoneName: "short",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const offsetName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetName);
  const offset = m ? `${m[1]}${m[2]}${m[3]}` : "+0000";
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName} (UTC${offset})`;
}

export const getCurrentTime = tool(
  async ({ timezone_name = "UTC" }) => {
    try {
      return formatNow(timezone_name);
    } catch {
      return `Unknown timezone '${timezone_name}'. Use an IANA name like 'Asia/Kolkata'.`;
    }
  },
  {
    name: "get_current_time",
    description: "Return the current date and time for a given IANA timezone.",
    schema: z.object({
      timezone_name: z
        .string()
        .default("UTC")
        .describe("IANA timezone string such as 'UTC', 'Asia/Kolkata', or 'America/New_York'. Defaults to UTC."),
    }),
  },
);

export { askUser };

/** The tools that ship with Luna (add new ones to this list). */
export function getBuiltinTools(): AnyTool[] {
  return [getCurrentTime, calculator, askUser] as unknown as AnyTool[];
}

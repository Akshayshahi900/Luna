/**
 * A small cron parser: when does a routine run next?
 *
 * BEGINNER MAP
 * ------------
 * A schedule is the classic 5-field cron line:
 *
 *   minute  hour  day-of-month  month  day-of-week
 *   * /15   *     *             *      *          every 15 minutes
 *   0       8     *             *      1-5        08:00 on weekdays
 *   30      18    *             *      0          18:30 on Sundays
 *
 * (written without the space: "*" + "/15").
 *
 * Each field takes `*`, a number, a range `a-b`, a list `a,b,c` and a step
 * `* /n` or `a-b/n`. Day-of-week is 0-6 from Sunday (7 is Sunday too).
 * Shortcuts: @hourly, @daily, @weekly, @monthly.
 *
 * As in standard cron, when both day-of-month and day-of-week are set, a
 * day matching EITHER counts.
 *
 * nextRun() works on the wall clock of a timezone and walks forward
 * month → day → hour → minute, skipping whole months / days / hours that
 * can't match, so it never loops minute by minute through a year.
 * describe() gives a short English version for the UI.
 *
 * Read next: routines/scheduler.ts
 */

import { fromWall, toWall } from "../util/zoned.ts";

export const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Search at most this far ahead (covers Feb 29 schedules).
const HORIZON_DAYS = 366 * 5;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The schedule isn't a valid cron line. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

/** A parsed cron line: the allowed values of each field. */
export interface Cron {
  expr: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean; // day-of-month was *
  anyWeekday: boolean; // day-of-week was *
}

const isDigits = (s: string) => /^\d+$/.test(s);

function field(text: string, index: number): Set<number> {
  const [low, high] = RANGES[index];
  const values = new Set<number>();
  for (let part of text.split(",")) {
    let step = 1;
    if (part.includes("/")) {
      const [p, stepText] = [part.slice(0, part.indexOf("/")), part.slice(part.indexOf("/") + 1)];
      if (!isDigits(stepText) || Number(stepText) < 1) throw new CronError(`Bad step in ${NAMES[index]}: '${text}'`);
      step = Number(stepText);
      part = p;
    }
    let start: number;
    let end: number;
    if (part === "*") [start, end] = [low, high];
    else if (part.includes("-")) {
      const [a, b] = [part.slice(0, part.indexOf("-")), part.slice(part.indexOf("-") + 1)];
      if (!(isDigits(a) && isDigits(b))) throw new CronError(`Bad range in ${NAMES[index]}: '${text}'`);
      [start, end] = [Number(a), Number(b)];
    } else if (isDigits(part)) {
      start = end = Number(part);
      if (step > 1) end = high; // "5/15" = from 5, every 15
    } else {
      throw new CronError(`Bad ${NAMES[index]}: '${text}'`);
    }
    if (start < low || end > high || start > end) {
      const name = NAMES[index][0].toUpperCase() + NAMES[index].slice(1);
      throw new CronError(`${name} must be ${low}-${high}: '${text}'`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  if (index === 4 && values.has(7)) {
    // 7 = Sunday too
    values.delete(7);
    values.add(0);
  }
  return values;
}

/** Parse a cron line (or an @alias); CronError if it isn't valid. */
export function parse(expr: string): Cron {
  let text = expr.split(/\s+/).filter(Boolean).join(" ");
  text = ALIASES[text.toLowerCase()] ?? text;
  const parts = text.split(" ");
  if (parts.length !== 5 || !text) throw new CronError("A schedule needs 5 fields: minute hour day month weekday");
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, i));
  return { expr: text, minutes, hours, days, months, weekdays, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function dayMatches(cron: Cron, day: number, weekday: number): boolean {
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return cron.weekdays.has(weekday);
  if (cron.anyWeekday) return cron.days.has(day);
  return cron.days.has(day) || cron.weekdays.has(weekday);
}

/**
 * The first matching minute strictly after the instant `after` (ms), read
 * on the wall clock of `zone`. Returns an instant (ms).
 */
export function nextRun(expr: string | Cron, after: number, zone: string): number {
  const cron = typeof expr === "string" ? parse(expr) : expr;
  const start = toWall(after, zone);
  // A "naive" wall clock: a Date whose UTC fields are the zone's wall time.
  let when = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute) + MINUTE;
  const limit = when + HORIZON_DAYS * DAY;
  while (when <= limit) {
    const d = new Date(when);
    const [year, month, day, hour, minute] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
    if (!cron.months.has(month)) {
      when = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);
      continue;
    }
    if (!dayMatches(cron, day, d.getUTCDay())) {
      when = Date.UTC(year, month - 1, day + 1);
      continue;
    }
    if (!cron.hours.has(hour)) {
      when = Date.UTC(year, month - 1, day, hour + 1);
      continue;
    }
    if (!cron.minutes.has(minute)) {
      when += MINUTE;
      continue;
    }
    return fromWall({ year, month, day, hour, minute, second: 0 }, zone);
  }
  throw new CronError(`'${cron.expr}' never runs`);
}

const two = (n: number) => String(n).padStart(2, "0");
const same = (a: Set<number>, b: number[]) => a.size === b.length && b.every((x) => a.has(x));

/** Short English for the common shapes; the raw line otherwise. */
export function describe(expr: string): string {
  const cron = parse(expr);
  const [minute, hour, day, month, weekday] = cron.expr.split(" ");
  const everyDay = day === "*" && month === "*";
  if (everyDay && weekday === "*" && hour === "*") {
    if (minute === "*") return "every minute";
    if (minute.startsWith("*/")) return `every ${minute.slice(2)} minutes`;
    if (isDigits(minute)) return `every hour at :${two(Number(minute))}`;
  }
  if (everyDay && hour.startsWith("*/") && isDigits(minute)) return `every ${hour.slice(2)} hours at :${two(Number(minute))}`;
  if (isDigits(minute) && isDigits(hour)) {
    const at = `${two(Number(hour))}:${two(Number(minute))}`;
    if (everyDay && weekday === "*") return `daily at ${at}`;
    if (everyDay && same(cron.weekdays, [1, 2, 3, 4, 5])) return `weekdays at ${at}`;
    if (everyDay && same(cron.weekdays, [0, 6])) return `weekends at ${at}`;
    if (everyDay) return `${[...cron.weekdays].sort((a, b) => a - b).map((d) => DAYS[d]).join(", ")} at ${at}`;
    if (isDigits(day) && month === "*" && weekday === "*") return `monthly on day ${day} at ${at}`;
  }
  return `cron ${cron.expr}`;
}

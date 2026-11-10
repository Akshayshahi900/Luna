/**
 * Wall-clock time in an IANA timezone, with nothing but Intl.
 *
 * BEGINNER MAP
 * ------------
 * JavaScript's Date is one instant (milliseconds since 1970, UTC). Python's
 * routines and calendar code work with *wall-clock* times in a zone ("08:00
 * in Asia/Kolkata"). These helpers convert between the two:
 *
 *   zoneOffset(zone, utc)        → minutes east of UTC at that instant (+330)
 *   toWall(utc, zone)            → {year, month, day, hour, minute, second, weekday}
 *   fromWall(wall, zone)         → the instant (settles DST changes)
 *   isoInZone(utc, zone)         → "2026-10-20T09:30:00+05:30" (Python isoformat)
 *   localZone()                  → the computer's zone
 *
 * Used by routines/cron.ts, routines/store.ts and servers/google.ts.
 */

export interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC in `zone` at the instant `utc` (ms). */
export function zoneOffset(zone: string, utc: number): number {
  let format = offsetFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    offsetFormats.set(zone, format);
  }
  const name = format.formatToParts(new Date(utc)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** The computer's IANA zone (e.g. "Asia/Kolkata"). */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True for a zone Intl knows. */
export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time of instant `utc` in `zone`. */
export function toWall(utc: number, zone: string): Wall & { weekday: number } {
  const d = new Date(utc + zoneOffset(zone, utc) * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(), // 0 = Sunday, like cron
  };
}

/** The instant of a wall-clock time in `zone` (settled across a DST change). */
export function fromWall(wall: Wall, zone: string): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const first = guess - zoneOffset(zone, guess) * 60_000;
  return guess - zoneOffset(zone, first) * 60_000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "+05:30" for an offset in minutes. */
export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "2026-10-20T09:30:00+05:30" (seconds) or "2026-10-20T09:30+05:30" (minutes). */
export function isoInZone(utc: number, zone: string, timespec: "seconds" | "minutes" = "seconds"): string {
  const offset = zoneOffset(zone, utc);
  const wall = new Date(utc + offset * 60_000).toISOString().slice(0, timespec === "seconds" ? 19 : 16);
  return wall + offsetText(offset);
}

/** UTC ISO text like Python's isoformat(timespec="seconds"): 2026-11-09T10:00:00+00:00 */
export function isoUtc(utc: number = Date.now()): string {
  return new Date(utc).toISOString().slice(0, 19) + "+00:00";
}

/** "YYYY-MM-DD" of a wall time. */
export function dayText(wall: Pick<Wall, "year" | "month" | "day">): string {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

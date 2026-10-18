"""
A small cron parser: when does a routine run next?

BEGINNER MAP
------------
A schedule is the classic 5-field cron line:

  minute  hour  day-of-month  month  day-of-week
  */15    *     *             *      *          every 15 minutes
  0       8     *             *      1-5        08:00 on weekdays
  30      18    *             *      0          18:30 on Sundays

Each field takes ``*``, a number, a range ``a-b``, a list ``a,b,c`` and a
step ``*/n`` or ``a-b/n``. Day-of-week is 0-6 from Sunday (7 is Sunday
too). Shortcuts: @hourly, @daily, @weekly, @monthly.

As in standard cron, when both day-of-month and day-of-week are set, a
day matching EITHER counts.

next_run() walks forward month → day → hour → minute, skipping whole
months / days / hours that can't match, so it never loops minute by
minute through a year. describe() gives a short English version for the UI.

Read next: luna/routines/scheduler.py
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

ALIASES = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
}
_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
_NAMES = ["minute", "hour", "day of month", "month", "day of week"]
_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
# Search at most this far ahead (covers Feb 29 schedules).
_HORIZON_DAYS = 366 * 5


class CronError(ValueError):
    """The schedule isn't a valid cron line."""


@dataclass(frozen=True)
class Cron:
    """A parsed cron line: the allowed values of each field."""

    expr: str
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]
    any_day: bool  # day-of-month was *
    any_weekday: bool  # day-of-week was *

    def day_matches(self, when: datetime) -> bool:
        weekday = (when.weekday() + 1) % 7  # Python: Monday=0 → cron: Sunday=0
        if self.any_day and self.any_weekday:
            return True
        if self.any_day:
            return weekday in self.weekdays
        if self.any_weekday:
            return when.day in self.days
        return when.day in self.days or weekday in self.weekdays


def _field(text: str, index: int) -> frozenset[int]:
    low, high = _RANGES[index]
    values: set[int] = set()
    for part in text.split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            if not step_text.isdigit() or int(step_text) < 1:
                raise CronError(f"Bad step in {_NAMES[index]}: {text!r}")
            step = int(step_text)
        if part == "*":
            start, end = low, high
        elif "-" in part:
            a, b = part.split("-", 1)
            if not (a.isdigit() and b.isdigit()):
                raise CronError(f"Bad range in {_NAMES[index]}: {text!r}")
            start, end = int(a), int(b)
        elif part.isdigit():
            start = end = int(part)
            if step > 1:
                end = high  # "5/15" = from 5, every 15
        else:
            raise CronError(f"Bad {_NAMES[index]}: {text!r}")
        if start < low or end > high or start > end:
            raise CronError(f"{_NAMES[index].capitalize()} must be {low}-{high}: {text!r}")
        values.update(range(start, end + 1, step))
    if index == 4 and 7 in values:  # 7 = Sunday too
        values.discard(7)
        values.add(0)
    return frozenset(values)


def parse(expr: str) -> Cron:
    """Parse a cron line (or an @alias); CronError if it isn't valid."""
    text = " ".join(expr.split())
    text = ALIASES.get(text.lower(), text)
    parts = text.split(" ")
    if len(parts) != 5:
        raise CronError("A schedule needs 5 fields: minute hour day month weekday")
    minutes, hours, days, months, weekdays = (_field(p, i) for i, p in enumerate(parts))
    return Cron(
        expr=text,
        minutes=minutes,
        hours=hours,
        days=days,
        months=months,
        weekdays=weekdays,
        any_day=parts[2] == "*",
        any_weekday=parts[4] == "*",
    )


def next_run(expr: str | Cron, after: datetime) -> datetime:
    """The first matching minute strictly after ``after`` (same timezone)."""
    cron = parse(expr) if isinstance(expr, str) else expr
    when = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = after + timedelta(days=_HORIZON_DAYS)
    while when <= limit:
        if when.month not in cron.months:
            year, month = (when.year + 1, 1) if when.month == 12 else (when.year, when.month + 1)
            when = when.replace(year=year, month=month, day=1, hour=0, minute=0)
            continue
        if not cron.day_matches(when):
            when = (when + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if when.hour not in cron.hours:
            when = (when + timedelta(hours=1)).replace(minute=0)
            continue
        if when.minute not in cron.minutes:
            when += timedelta(minutes=1)
            continue
        return when
    raise CronError(f"{cron.expr!r} never runs")


def _two(n: int) -> str:
    return f"{n:02d}"


def describe(expr: str) -> str:
    """Short English for the common shapes; the raw line otherwise."""
    cron = parse(expr)
    minute, hour, day, month, weekday = cron.expr.split(" ")
    every_day = day == "*" and month == "*"
    if every_day and weekday == "*" and hour == "*":
        if minute == "*":
            return "every minute"
        if minute.startswith("*/"):
            return f"every {minute[2:]} minutes"
        if minute.isdigit():
            return f"every hour at :{_two(int(minute))}"
    if every_day and hour.startswith("*/") and minute.isdigit():
        return f"every {hour[2:]} hours at :{_two(int(minute))}"
    if minute.isdigit() and hour.isdigit():
        at = f"{_two(int(hour))}:{_two(int(minute))}"
        if every_day and weekday == "*":
            return f"daily at {at}"
        if every_day and cron.weekdays == frozenset({1, 2, 3, 4, 5}):
            return f"weekdays at {at}"
        if every_day and cron.weekdays == frozenset({0, 6}):
            return f"weekends at {at}"
        if every_day:
            names = ", ".join(_DAYS[d] for d in sorted(cron.weekdays))
            return f"{names} at {at}"
        if day.isdigit() and month == "*" and weekday == "*":
            return f"monthly on day {day} at {at}"
    return f"cron {cron.expr}"


__all__ = ["ALIASES", "Cron", "CronError", "describe", "next_run", "parse"]

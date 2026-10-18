"""Routine schedules: the small cron parser in luna/routines/cron.py."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from luna.routines.cron import CronError, describe, next_run, parse

UTC = ZoneInfo("UTC")


def at(text, tz=UTC):
    return datetime.fromisoformat(text).replace(tzinfo=tz)


def test_parse_fields_lists_ranges_and_steps():
    cron = parse("*/15 8-10 1,15 * 1-5")
    assert cron.minutes == {0, 15, 30, 45}
    assert cron.hours == {8, 9, 10}
    assert cron.days == {1, 15}
    assert cron.weekdays == {1, 2, 3, 4, 5}
    assert parse("0 0 * * 7").weekdays == {0}  # 7 is Sunday too
    assert parse("5/20 * * * *").minutes == {5, 25, 45}
    assert parse("@daily").expr == "0 0 * * *"


@pytest.mark.parametrize("bad", ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"])
def test_invalid_schedules_are_refused(bad):
    with pytest.raises(CronError):
        parse(bad)


def test_next_run_is_strictly_after():
    assert next_run("*/15 * * * *", at("2026-10-18T10:15:00")) == at("2026-10-18T10:30:00")
    assert next_run("*/15 * * * *", at("2026-10-18T10:16:59")) == at("2026-10-18T10:30:00")
    assert next_run("0 8 * * *", at("2026-10-18T08:00:00")) == at("2026-10-19T08:00:00")


def test_next_run_weekdays_months_and_leap_days():
    # 2026-10-17 is a Saturday → next weekday 09:00 is Monday the 19th.
    assert next_run("0 9 * * 1-5", at("2026-10-17T12:00:00")) == at("2026-10-19T09:00:00")
    assert next_run("30 6 1 * *", at("2026-12-15T00:00:00")) == at("2027-01-01T06:30:00")
    assert next_run("0 0 29 2 *", at("2026-03-01T00:00:00")) == at("2028-02-29T00:00:00")


def test_day_of_month_or_day_of_week_like_cron():
    # Both set: either one matches (the 1st, or any Monday).
    assert next_run("0 0 1 * 1", at("2026-10-02T00:00:00")) == at("2026-10-05T00:00:00")


def test_next_run_in_a_timezone():
    kolkata = ZoneInfo("Asia/Kolkata")
    result = next_run("0 8 * * *", datetime(2026, 10, 18, 9, 0, tzinfo=kolkata))
    assert result == datetime(2026, 10, 19, 8, 0, tzinfo=kolkata)


def test_describe_reads_like_english():
    assert describe("*/15 * * * *") == "every 15 minutes"
    assert describe("5 * * * *") == "every hour at :05"
    assert describe("0 */2 * * *") == "every 2 hours at :00"
    assert describe("0 8 * * *") == "daily at 08:00"
    assert describe("30 9 * * 1-5") == "weekdays at 09:30"
    assert describe("0 10 * * 0,6") == "weekends at 10:00"
    assert describe("0 18 * * 0") == "Sunday at 18:00"
    assert describe("0 7 1 * *") == "monthly on day 1 at 07:00"
    assert describe("0 7 1 1 *") == "cron 0 7 1 1 *"

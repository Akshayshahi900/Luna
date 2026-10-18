"""Editing .env from the Control Center: envfile (read / update in place) and
schema (field descriptions, validation, rollback). No network, no LLM."""

import os
import stat

import pytest

from luna.config import Settings
from luna.config.envfile import EnvFileError, format_value, parse_value, read_env, update_env
from luna.config.schema import (
    GROUPS,
    SECRETS,
    SettingsRejected,
    applies,
    save_settings,
    settings_schema,
    to_env,
)


# --- envfile -------------------------------------------------------------------

def test_parse_value_handles_quotes_and_comments():
    assert parse_value(" plain ") == "plain"
    assert parse_value('"two words"') == "two words"
    assert parse_value("'single'") == "single"
    assert parse_value('"say \\"hi\\""') == 'say "hi"'
    assert parse_value("value # a comment") == "value"
    assert parse_value('"a # not a comment" # but this is') == "a # not a comment"


def test_format_value_quotes_only_when_needed():
    assert format_value("metric") == "metric"
    assert format_value("a,b,c") == "a,b,c"
    assert format_value("http://localhost:5173") == "http://localhost:5173"
    assert format_value("two words") == '"two words"'
    assert format_value('say "hi"') == '"say \\"hi\\""'
    assert parse_value(format_value('back\\slash "q" #x')) == 'back\\slash "q" #x'


def test_update_keeps_comments_order_and_unrelated_lines(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# Luna\n"
        "LUNA_UNITS=metric\n"
        "\n"
        "# keys\n"
        "export LUNA_GROQ_MODEL=old\n"
        "OTHER=keep # untouched\n"
    )
    update_env(env, {"LUNA_UNITS": "imperial", "LUNA_GROQ_MODEL": None, "LUNA_USER_NAME": "Ada Lovelace"})
    assert env.read_text() == (
        "# Luna\n"
        "LUNA_UNITS=imperial\n"
        "\n"
        "# keys\n"
        "OTHER=keep # untouched\n"
        'LUNA_USER_NAME="Ada Lovelace"\n'
    )
    assert read_env(env) == {"LUNA_UNITS": "imperial", "OTHER": "keep", "LUNA_USER_NAME": "Ada Lovelace"}


def test_comments_after_a_value_are_kept(tmp_path):
    env = tmp_path / ".env"
    env.write_text('LUNA_STT_MODEL=base.en        # tiny.en | base.en\nLUNA_USER_NAME="Al" # me\n')
    update_env(env, {"LUNA_STT_MODEL": "small.en", "LUNA_USER_NAME": "Ada L"})
    assert env.read_text() == 'LUNA_STT_MODEL=small.en        # tiny.en | base.en\nLUNA_USER_NAME="Ada L"  # me\n'
    assert read_env(env) == {"LUNA_STT_MODEL": "small.en", "LUNA_USER_NAME": "Ada L"}


def test_update_drops_later_duplicates(tmp_path):
    env = tmp_path / ".env"
    env.write_text("A=1\nB=2\nA=3\n")
    update_env(env, {"A": "9"})
    assert env.read_text() == "A=9\nB=2\n"


def test_commented_out_keys_are_left_alone(tmp_path):
    env = tmp_path / ".env"
    env.write_text("# LUNA_UNITS=imperial\n")
    update_env(env, {"LUNA_UNITS": "metric"})
    assert env.read_text() == "# LUNA_UNITS=imperial\nLUNA_UNITS=metric\n"


def test_update_refuses_newlines_and_bad_keys(tmp_path):
    env = tmp_path / ".env"
    with pytest.raises(EnvFileError):
        update_env(env, {"LUNA_X": "a\nLUNA_AUTO_APPROVE=run_command"})
    with pytest.raises(EnvFileError):
        update_env(env, {"BAD KEY": "x"})
    assert not env.exists()


def test_new_file_is_private_and_existing_mode_is_kept(tmp_path):
    env = tmp_path / ".env"
    update_env(env, {"A": "1"})
    assert stat.S_IMODE(os.stat(env).st_mode) == 0o600
    os.chmod(env, 0o640)
    update_env(env, {"A": "2"})
    assert stat.S_IMODE(os.stat(env).st_mode) == 0o640
    assert not (tmp_path / ".env.tmp").exists()


# --- schema --------------------------------------------------------------------

def test_every_setting_is_in_exactly_one_group():
    grouped = [f for _, _, fields in GROUPS for f in fields]
    assert sorted(grouped) == sorted(Settings.model_fields)
    assert len(grouped) == len(set(grouped))


def test_when_changes_apply():
    assert applies("mail_address") == "live"  # MCP servers read .env per call
    assert applies("response_style") == "rebuild"
    assert applies("auto_approve") == "rebuild"
    assert applies("web_port") == "restart"


def test_schema_masks_secrets_and_lists_unknown_keys(tmp_path):
    env = tmp_path / ".env"
    env.write_text("LUNA_GROQ_API_KEY=gsk_secret\nLUNA_DEFAULT_THREAD_ID=old\nLUNA_UNITS=imperial\n")
    schema = settings_schema(Settings(_env_file=env), env)
    fields = {f["name"]: f for g in schema["groups"] for f in g["fields"]}
    assert fields["groq_api_key"]["value"] is None
    assert fields["groq_api_key"]["is_set"] is True
    assert fields["groq_api_key"]["default"] is None
    assert "gsk_secret" not in str(schema)
    assert fields["units"] == fields["units"] | {"value": "imperial", "in_file": True, "choices": ["metric", "imperial"]}
    assert fields["auto_approve"]["kind"] == "list"
    assert fields["web_port"]["kind"] == "int"
    assert fields["enable_mcp_tools"]["kind"] == "bool"
    assert schema["unknown"] == ["LUNA_DEFAULT_THREAD_ID"]
    assert set(SECRETS) <= set(fields)


def test_to_env_formats_by_kind():
    assert to_env("bool", True) == "true"
    assert to_env("bool", False) == "false"
    assert to_env("list", ["a", " b ", ""]) == "a,b"
    assert to_env("list", []) is None
    assert to_env("int", 5) == "5"
    assert to_env("str", "  ") is None
    assert to_env("str", None) is None


def test_save_settings_writes_and_validates(tmp_path):
    env = tmp_path / ".env"
    env.write_text("# mine\nLUNA_UNITS=metric\nLUNA_DEFAULT_THREAD_ID=old\n")
    settings, effects = save_settings(
        env, {"units": "imperial", "auto_approve": ["write_file"], "web_port": 9000}, ["LUNA_DEFAULT_THREAD_ID"]
    )
    assert settings.units == "imperial"
    assert settings.auto_approve == ["write_file"]
    assert effects == {"units": "rebuild", "auto_approve": "rebuild", "web_port": "restart"}
    assert env.read_text() == "# mine\nLUNA_UNITS=imperial\nLUNA_AUTO_APPROVE=write_file\nLUNA_WEB_PORT=9000\n"


def test_invalid_value_restores_the_file_exactly(tmp_path):
    env = tmp_path / ".env"
    original = "# keep   me\nLUNA_UNITS = metric\n"
    env.write_text(original)
    with pytest.raises(SettingsRejected, match="LUNA_UNITS"):
        save_settings(env, {"units": "furlongs"})
    assert env.read_text() == original
    with pytest.raises(SettingsRejected, match="Unknown setting"):
        save_settings(env, {"not_a_setting": 1})
    with pytest.raises(SettingsRejected):
        save_settings(env, {}, ["LUNA_UNITS"])  # known keys aren't "unknown"
    assert env.read_text() == original

"""
Google sign-in shared by the MCP servers (Gmail, Calendar, Tasks).

BEGINNER MAP
------------
servers/mail_mcp_server.py (Gmail API), servers/google_mcp_server.py
(Calendar) and servers/tasks_mcp_server.py (Google Tasks sync) all talk to
Google with ONE OAuth sign-in, kept in data/google/token.json.

Once (docs/google.md):

  1. Google Cloud Console → enable Gmail, Google Calendar and Google Tasks
     APIs → OAuth client of type "Desktop app" → download the JSON to
     data/google/credentials.json (or set LUNA_GOOGLE_CREDENTIALS_PATH).
  2. uv run luna-google-auth
     (opens the browser, saves the token; it is refreshed automatically)

The servers never open a browser themselves: they run as stdio
subprocesses, so a missing or too-narrow sign-in is reported as an error
message that tells the user to run luna-google-auth.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from luna.config import Settings

SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/gmail.readonly",  # reading never marks mail as read
    "https://www.googleapis.com/auth/gmail.send",
]
_HOW = "run `uv run luna-google-auth` (see docs/google.md)"


class GoogleNotConnected(ValueError):
    """No usable sign-in. Tools show the message; task sync just stays local."""


def _save_token(path: Path, creds: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(creds.to_json(), encoding="utf-8")
    os.chmod(tmp, 0o600)  # the token is a key to the account
    tmp.replace(path)


def is_connected(settings: Settings) -> bool:
    """A token file exists (cheap check; it may still be expired)."""
    return settings.google_token_path.exists()


def credentials(settings: Settings) -> Any:
    """Saved credentials, refreshed (and re-saved) when expired."""
    token = settings.google_token_path
    if not token.exists():
        raise GoogleNotConnected(f"Google is not connected: {_HOW}.")
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    # No scopes argument: keep the scopes the token was granted, so the
    # check below notices an old token from before Gmail was added.
    creds = Credentials.from_authorized_user_file(str(token))
    if not creds.has_scopes(SCOPES):
        raise GoogleNotConnected(f"The Google sign-in is missing access Luna needs: {_HOW} again.")
    if creds.valid:
        return creds
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _save_token(token, creds)
        return creds
    raise GoogleNotConnected(f"The Google sign-in has expired: {_HOW} again.")


def service(api: str, version: str, settings: Settings | None = None) -> Any:
    """A Google API client: ("gmail", "v1"), ("calendar", "v3") or ("tasks", "v1")."""
    from googleapiclient.discovery import build

    creds = credentials(settings or Settings())
    return build(api, version, credentials=creds, cache_discovery=False)


def execute(request: Any) -> Any:
    """Run a Google API request; turn HTTP errors into a short message for the model."""
    from googleapiclient.errors import HttpError

    try:
        return request.execute()
    except HttpError as exc:
        status = getattr(exc.resp, "status", "?")
        raise ValueError(f"Google API error {status}: {getattr(exc, 'reason', exc)}") from exc


def authorize(settings: Settings | None = None) -> Path:
    """Browser sign-in; saves the token."""
    settings = settings or Settings()
    client = settings.google_credentials_path
    if not client.exists():
        raise SystemExit(
            f"No OAuth client file at {client}. Download a 'Desktop app' OAuth client "
            "from Google Cloud Console there (see docs/google.md)."
        )
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(str(client), SCOPES)
    creds = flow.run_local_server(port=0)
    _save_token(settings.google_token_path, creds)
    return settings.google_token_path


def main() -> None:
    """Entry point of `luna-google-auth`."""
    print(f"Signed in to Google. Token saved to {authorize()}")


__all__ = ["SCOPES", "GoogleNotConnected", "authorize", "credentials", "execute", "is_connected", "service"]

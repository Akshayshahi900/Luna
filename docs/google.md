# Google: Gmail, Calendar, and to-dos synced with Google Tasks

One Google sign-in powers three MCP servers of Luna's **assistant** helper
(`ask_assistant`), all in `config/mcp_servers.json` with `"agent": "assistant"`:

| Server | Google part | Guide |
| --- | --- | --- |
| `mail` (`servers/mail_mcp_server.py`) | Gmail API (`LUNA_MAIL_BACKEND=gmail`, the default) | [`docs/mail.md`](mail.md) |
| `google` (`servers/google_mcp_server.py`) | Google Calendar | below |
| `tasks` (`servers/tasks_mcp_server.py`) | local to-dos, two-way synced with Google Tasks | below |

The sign-in code is `src/luna/integrations/google.py`.

## Set up (once)

1. [Google Cloud Console](https://console.cloud.google.com/): create (or pick)
   a project and enable **Gmail API**, **Google Calendar API** and
   **Google Tasks API**.
2. **OAuth consent screen**: type *External*, add yourself as a test user.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**.
   Download the JSON to `data/google/credentials.json`.
4. Sign in:

   ```bash
   uv run luna-google-auth
   ```

   A browser opens; allow access. The token is saved to
   `data/google/token.json` (mode 600, git-ignored with the rest of `data/`)
   and refreshed automatically.

Access asked for: `gmail.readonly` (reading never marks mail as read),
`gmail.send`, `calendar.events` (events only, not calendar settings) and
`tasks`. A token from before a scope was added is refused with "missing
access … run luna-google-auth again".

Settings (`.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `LUNA_GOOGLE_CREDENTIALS_PATH` | `./data/google/credentials.json` | OAuth client file |
| `LUNA_GOOGLE_TOKEN_PATH` | `./data/google/token.json` | Saved sign-in |
| `LUNA_GOOGLE_CALENDAR_ID` | `primary` | Calendar to use |
| `LUNA_GOOGLE_TASKLIST_ID` | `@default` | Google task list the to-dos sync with |
| `LUNA_TASKS_GOOGLE_SYNC` | `true` | Sync the to-dos with Google Tasks when signed in |
| `LUNA_MAIL_BACKEND` | `gmail` | `gmail` or `imap` (app password, any provider) |
| `LUNA_TIMEZONE` | computer's zone | Times without an offset are read in this zone |

Before you sign in, all servers still start. Mail and calendar tools answer
"Google is not connected: run `uv run luna-google-auth`"; the to-dos work
locally and sync once you're signed in.

## Calendar tools

Times are `YYYY-MM-DDTHH:MM` (local) or `YYYY-MM-DD` (all day).

| Tool | Approval | What it does |
| --- | --- | --- |
| `list_events(start, end, query, limit)` | no | events, soonest first (default: next 7 days) |
| `get_agenda(day)` | no | one day: events, to-dos due, overdue to-dos |
| `create_event(title, start, end, description, location, attendees)` | **yes** | end defaults to +1 hour; all-day end is the last day; attendees get invitations |
| `update_event(event_id, title, start, end, description, location)` | **yes** | changes only what you pass |
| `delete_event(event_id)` | **yes** | guests are told |
| `create_event_from_email(uid, start, end, title, location, invite_sender, folder)` | **yes** | see below |

## To-dos synced with Google Tasks

`list_tasks`, `add_task`, `set_task_done`, `delete_task`,
`add_task_from_email` work on `data/tasks.json`, which stays the source of
truth (works offline, works without Google). When signed in, every call
first syncs the file with the Google task list, both ways:

| Situation | Result |
| --- | --- |
| new here | created in Google |
| changed here | pushed |
| changed in Google | pulled |
| changed on both sides | the newer change wins (the whole to-do) |
| deleted on either side | deleted on the other |
| new open task in Google | added here (completed ones aren't imported) |

Google Tasks stores only a due **date**: a local `due` time is kept while
the day matches, and dropped if the day is changed in Google. Each to-do
has `"synced": true` once Google has its latest version. If Google can't be
reached, the change is saved locally and goes up on the next sync; a delete
made offline is kept (hidden) until Google has it too.

## From email to to-do or event

```
you: turn Bob's lunch email into an event on Friday at 1
     → search_emails / read_email
     ⏸  Approval needed: create_event_from_email {"uid": "18b2", "start": "2026-10-23T13:00", ...}
you: and add the invoice email as a to-do for Monday
     ⏸  Approval needed: add_task_from_email {"uid": "18c4", "due": "2026-10-26"}
```

The two tools read the email themselves through the mail server's
`fetch_email` (Gmail or IMAP, read-only), so the title defaults to the
subject and the item links back to the email:

- **event**: the email's `Message-ID` is stored as a private extended
  property (`luna_email_id`); the description has subject, sender, date, a
  link that opens the email in Gmail, and a short excerpt.
- **to-do**: the notes have the same lines plus a `[luna-email:<Message-ID>]`
  marker, so the link reaches Google Tasks too.

Asking again for the same email returns the existing item (`"created": false`).
Emails without a `Message-ID` are linked by `folder:uid`. An event's time
always comes from the assistant's call (from you or the email); the server
never guesses it from the text.

Tests: `tests/test_google_server.py`, `tests/test_tasks_server.py`,
`tests/test_mail_server.py` (fake Google clients, no network).

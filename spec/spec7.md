# Spec 7 — Google connectors: Gmail API, Calendar, and to-dos synced with Google Tasks

**Date:** 2026-10-18  
**Status:** Implemented.  
**Scope:** One Google sign-in for the assistant helper: mail over the Gmail API, Google Calendar, and the local to-do list kept in two-way sync with Google Tasks. An email can become a to-do or an event. Every change is approved.

Builds on [spec3](spec3.md) §5–6 and [spec6](spec6.md).
Decision: [`DECISIONS.md`](../DECISIONS.md) D32. User guide: [`docs/google.md`](../docs/google.md).

---

## 1. Goal

- "What's on tomorrow?", "move the dentist to 11", "any mail from the bank?".
- "Add 'pay rent' for Friday" shows up in the Google Tasks app, and a task
  ticked off on the phone is done in Luna too.
- "Make a to-do from the invoice email", "put Bob's lunch email on my calendar",
  without duplicates when asked twice.
- To-dos keep working offline and without a Google account.

## 2. Shape

```
main agent ──ask_assistant──▶ assistant helper (HITL on risky verbs)
          │ MCP stdio                  │                          │
          ▼                            ▼                          ▼
 servers/tasks_mcp_server.py   servers/mail_mcp_server.py   servers/google_mcp_server.py
  data/tasks.json ⇄ sync          gmail | imap backend         Calendar tools, agenda
          │       └── fetch_email ◀────┘ ────── fetch_email ──────┘ (+ to-dos via tasks)
          ▼                            ▼                          ▼
     Tasks v1                      Gmail v1                  Calendar v3
          └──────────── luna/integrations/google.py (one OAuth token) ──┘
```

## 3. Tools

| Server | Tool | Risky name? |
| --- | --- | --- |
| tasks | `list_tasks` | no |
| tasks | `add_task`, `set_task_done`, `delete_task`, `add_task_from_email` | add / set / delete |
| mail | `list_inbox`, `search_emails`, `read_email` | no |
| mail | `send_email`, `reply_to_email` | send / reply |
| google | `list_events`, `get_agenda` | no |
| google | `create_event`, `update_event`, `delete_event`, `create_event_from_email` | create / update / delete |

Mail tools are unchanged from spec6; only the backend is new.

## 4. Rules

1. Approval from `is_risky_tool_name`, no special casing.
2. Sign-in: `uv run luna-google-auth` (Desktop OAuth client) writes
   `data/google/token.json` (mode 600). Scopes `gmail.readonly`, `gmail.send`,
   `calendar.events`, `tasks`. Servers only refresh the token; a missing,
   expired or too-narrow token raises `GoogleNotConnected` with the command
   to run. Servers never open a browser.
3. Not signed in is not a startup error (same reason as spec6 rule 6).
4. Mail backend `LUNA_MAIL_BACKEND=gmail|imap` (default gmail). Gmail: uids
   are message ids, `folder` is a label, sender from the profile, replies
   sent with the original `threadId`. The recipient guard is the same code.
5. To-do sync (`LUNA_TASKS_GOOGLE_SYNC`, default on, needs a token):
   `data/tasks.json` is the source of truth. Every tool call syncs first:
   - local new → insert; local change (`dirty`) → patch; Google change
     (`updated` ≠ stored `google_updated`) → pull; both → newer `updated` wins,
     whole to-do
   - delete on either side → delete on the other; an offline local delete
     stays as a hidden tombstone until Google has it
   - unlinked open Google tasks are imported; completed and blank ones are not
   - Google keeps only the due date: a local time survives while the day matches

   Any Google error leaves the file consistent (each step is recorded after
   Google accepts it), is logged to stderr, and the tool still answers.
6. Email → item: `fetch_email` (read-only) by uid; link key = `Message-ID`
   (else `folder:uid`). Events: private extended property `luna_email_id`.
   To-dos: `[luna-email:…]` in notes (so the link survives the trip through
   Google). Existing linked item → returned, not duplicated. Event times
   come only from the tool call.
7. Times: `YYYY-MM-DDTHH:MM` in `LUNA_TIMEZONE` (else system zone) or
   `YYYY-MM-DD`; all-day `end` is inclusive. Invitations only with guests.

## 5. Settings

`LUNA_GOOGLE_CREDENTIALS_PATH`, `LUNA_GOOGLE_TOKEN_PATH`,
`LUNA_GOOGLE_CALENDAR_ID` (`primary`), `LUNA_GOOGLE_TASKLIST_ID` (`@default`),
`LUNA_TASKS_GOOGLE_SYNC` (`true`), `LUNA_MAIL_BACKEND` (`gmail`).

Dependencies added: `google-api-python-client`, `google-auth-oauthlib`.
Script added: `luna-google-auth`.

## 6. Tests

All with fake Google clients and no network; `conftest.py` points
`LUNA_GOOGLE_TOKEN_PATH` at a missing file for every test, so a real
sign-in on the developer's machine is never used.

- `test_google_server.py`: catalog, time parsing, event create / update / delete,
  list window, agenda with local to-dos, event from email (link, no duplicate,
  no Message-ID), not signed in, old token missing a scope, config routing
- `test_tasks_server.py`: local behaviour, no sign-in = local only, push, pull
  (paged; completed / blank skipped), both-way changes and due-time rule,
  conflict newest wins, deletes both ways, offline then sync, offline delete
  tombstone, to-do from email
- `test_mail_server.py`: Gmail query, list / search / read, send with profile
  address, threaded reply + stranger guard, not signed in; IMAP tests unchanged

## 7. Later

Several calendars / task lists, recurring-event editing, free/busy, Gmail
drafts and labels changes, batch Gmail metadata requests, file locking if
two servers write `data/tasks.json` at the same moment (today: atomic
rename, last write wins).

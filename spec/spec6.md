# Spec 6 — Mail connector (MCP) with human approval

**Date:** 2026-10-18  
**Status:** Implemented.  
**Scope:** Let the assistant helper read the inbox and send / reply to email, with every send approved by the user.

Builds on [spec3](spec3.md) §5 (approval) and §6 (MCP routing).
Decision: [`DECISIONS.md`](../DECISIONS.md) D31. User guide: [`docs/mail.md`](../docs/mail.md).

---

## 1. Goal

- "What's new in my inbox?", "find the invoice from X", "reply that it's paid".
- Nothing leaves the account without the user seeing recipients, subject
  and body, and approving, editing or rejecting it.
- No new Python dependencies, no agent code changes (D2: MCP servers are config).

## 2. Shape

```
main agent ──ask_assistant──▶ assistant helper (HITL on send_email, reply_to_email)
                                   │ MCP stdio
                                   ▼
                     servers/mail_mcp_server.py ── IMAP (read-only, PEEK) ──▶ mailbox
                       Settings (.env LUNA_MAIL_*) ─ SMTP (SSL / STARTTLS) ──▶ provider
```

`config/mcp_servers.json`: `"mail": {..., "agent": "assistant"}`, next to `tasks`.

## 3. Tools

| Tool | Risky name? | Notes |
| --- | --- | --- |
| `list_inbox` | no | newest first, ≤ 50 |
| `search_emails` | no | TEXT / FROM / SINCE / UNSEEN, ASCII terms |
| `read_email` | no | body ≤ `mail_max_body_chars`, HTML reduced to text |
| `send_email` | `send` | to / cc comma-separated, ≤ 20 recipients |
| `reply_to_email` | `reply` | recipients must be on the original; threading headers |

## 4. Rules

1. Approval comes from the existing name check (`is_risky_tool_name`); no
   special casing.
2. Reading opens folders read-only and fetches with `BODY.PEEK`: it never
   changes flags.
3. `reply_to_email` takes `to` explicitly, so the approval card shows the
   recipients, and the server refuses addresses not on the original email.
4. Email content is untrusted: the tool docstring and the assistant prompt
   say to treat it as data, never instructions.
5. Credentials are read by the server from `Settings` (project `.env`):
   stdio MCP servers only inherit PATH/HOME-like variables, and putting
   secrets in `mcp_servers.json` would risk committing them.
6. Unconfigured mail is not an error at startup: the tools answer with
   setup instructions, so the tasks server in the same group keeps working.

## 5. Settings

`LUNA_MAIL_ADDRESS`, `LUNA_MAIL_PASSWORD`, `LUNA_MAIL_USERNAME`,
`LUNA_MAIL_IMAP_HOST` (`imap.gmail.com`), `LUNA_MAIL_IMAP_PORT` (`993`),
`LUNA_MAIL_SMTP_HOST` (`smtp.gmail.com`), `LUNA_MAIL_SMTP_PORT` (`465`),
`LUNA_MAIL_MAX_BODY_CHARS` (`4000`).

## 6. Tests

`tests/test_mail_server.py` (fake IMAP and SMTP, fake models):

- tool catalog over MCP
- list newest-first and read-only + PEEK
- search criteria and bad input
- body extraction (HTML, truncation)
- send, unconfigured message
- reply threading and the stranger guard
- repo config routes mail to the assistant with approval on exactly the two send tools
- end-to-end: main agent → assistant → `send_email` sends nothing until approved; edit sends the edited body; reject sends nothing

## 7. Later

OAuth (Gmail API / Microsoft Graph) for accounts without app passwords,
drafts, attachments when sending, marking read / archiving (would need
`mark` / `archive` approval words), non-ASCII search (IMAP literals).

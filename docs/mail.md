# Mail (read the inbox, send and reply with your approval)

Luna's **assistant** helper (`ask_assistant`) reads and sends email through
`servers/mail_mcp_server.py`, an MCP server listed in
`config/mcp_servers.json` with `"agent": "assistant"`. It uses plain
IMAP (reading) and SMTP (sending), so any provider with app passwords works.

## Set up

1. Turn on 2-step verification for your account and create an **app password**
   (Gmail / Google Workspace: Google Account → Security → App passwords).
   Never use your normal login password.
2. Add to `.env`:

   ```bash
   LUNA_MAIL_ADDRESS=you@gmail.com
   LUNA_MAIL_PASSWORD=abcd efgh ijkl mnop
   ```

3. Other providers: also set the servers.

   | Provider | `LUNA_MAIL_IMAP_HOST` | `LUNA_MAIL_SMTP_HOST` / `_PORT` |
   | --- | --- | --- |
   | Gmail, Google Workspace (default) | `imap.gmail.com` | `smtp.gmail.com` / `465` |
   | Yahoo | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com` / `465` |
   | iCloud | `imap.mail.me.com` | `smtp.mail.me.com` / `587` |
   | Fastmail | `imap.fastmail.com` | `smtp.fastmail.com` / `465` |

   Port `465` uses SSL; any other SMTP port uses STARTTLS. Set
   `LUNA_MAIL_USERNAME` if your login is not your address.

The server reads these through `luna.config.Settings` (the project `.env`),
because MCP servers started over stdio don't inherit Luna's environment.
Without them the mail tools answer "Mail is not set up…".

## Tools

| Tool | Approval | What it does |
| --- | --- | --- |
| `list_inbox(limit, unread_only, folder)` | no | newest emails: uid, from, to, subject, date, unread |
| `search_emails(query, sender, since, unread_only, limit, folder)` | no | IMAP search; `since` is `YYYY-MM-DD`, terms ASCII |
| `read_email(uid, folder)` | no | headers, plain-text body (cut at `LUNA_MAIL_MAX_BODY_CHARS`), attachment names |
| `send_email(to, subject, body, cc)` | **yes** | new plain-text email |
| `reply_to_email(uid, to, body, cc, folder)` | **yes** | threaded reply (`Re:`, `In-Reply-To`, `References`) |

Reading never marks a message as read: folders are opened read-only and
bodies are fetched with `BODY.PEEK`.

## Human in the loop

`send_email` and `reply_to_email` contain risky verbs (`send`, `reply`), so
the assistant pauses before running them (D9, D12). You see the recipients,
subject and body, then choose:

- **approve**: it is sent as shown
- **edit**: change any argument (fix the wording, drop a recipient), then it is sent
- **reject**: nothing is sent; your optional reason goes back to Luna, which won't retry

CLI: `[a]pprove / [e]dit / [r]eject`. Web: the pause card.

Extra guards in the server:

- A reply names its recipients (`to`, `cc`), so the approval shows who gets
  it. Anyone who wasn't on the original (From, Reply-To, To, Cc) is refused;
  new people need `send_email`.
- Every address is checked, and an email can have at most 20 recipients.
- Email text is untrusted. The assistant is told to treat it as data and
  never to act because a message asks it to.

Adding `send_email` or `reply_to_email` to `LUNA_AUTO_APPROVE` turns the
pause off. Not recommended.

## Try it

```
you: any unread mail from the bank this week?
you: reply to the invoice email saying it's paid
     ⏸  Approval needed: reply_to_email {"uid": "7", "to": "accounts@shop.com", ...}
```

Tests: `tests/test_mail_server.py` (fake IMAP/SMTP, no network).

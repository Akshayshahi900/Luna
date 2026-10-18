# Security Policy

Luna is an agent that can read and write files, run shell commands, and act
on your Gmail, Calendar and Google Tasks. Please treat security reports
seriously and privately.

## Reporting a vulnerability

**Do not open a public issue.** Instead use GitHub's
[private vulnerability reporting](https://github.com/Akshayshahi900/Luna/security/advisories/new) or email
**shahiakshay900@gmail.com** with:

- what the issue is and its impact
- steps to reproduce (a minimal prompt, config or request)
- the commit you tested

You should get a reply within a week.

## Supported versions

Only the latest commit on `main` is supported.

## Running Luna safely

- Keep the web UI bound to `127.0.0.1` (`LUNA_WEB_HOST`). The agent can run
  commands, so never expose it to a network you don't trust.
- File and shell tools are limited to `./workspace` unless you set
  `LUNA_WORKSPACE_DIRS`. Point that only at folders you are happy for the
  agent to change.
- Writing, running and sending always ask for approval — review them before
  you approve, especially after the agent has read web pages or emails
  (prompt injection).
- Secrets live in `.env` and `data/google/` (git-ignored). Never commit them.
  The Google token is saved with `0600` permissions; revoke it at
  <https://myaccount.google.com/permissions> if it leaks.

# Contributing to Luna

Thanks for helping out! Luna is small on purpose, so a little context goes a
long way before you change things.

## Before you start

1. Read [`spec/beginner-guide.md`](spec/beginner-guide.md) and
   [`ARCHITECTURE.md`](ARCHITECTURE.md) — they explain how a message flows
   through the agent and where each piece lives.
2. Skim [`DECISIONS.md`](DECISIONS.md). If your change goes against a
   decision there, open an issue first so we can talk it through.
3. For anything bigger than a bug fix, open an issue describing the change
   before writing code.

## Setup

```bash
pnpm install && pnpm build               # all dependencies + the web UI build (Node 22.18+)
cp .env.example .env   # add your own keys (never commit .env)
```

## Making a change

- **Match the existing style.** Short modules, a plain-English "BEGINNER MAP"
  comment at the top, and comments that explain *why*.
- **Write tests.** Every change needs tests in `core/test/` (backend) or next
  to the module as `*.test.ts` (web). Tests use a fake chat model
  (`core/test/helpers.ts`), so they never call a real LLM or need an API key —
  keep it that way.
- **Keep the docs in step:**
  - architectural decision → add an entry to `DECISIONS.md`
  - new files, data flow or topology → update `ARCHITECTURE.md`
  - user-facing behaviour → update `README.md` and/or `docs/`
  - design changes → update the relevant `spec/` file
- **Risky tools stay gated.** Anything that writes files, runs commands or
  sends things must go through the human-in-the-loop approval (see D9 in
  `DECISIONS.md`).

## Running the checks

```bash
cd core && pnpm typecheck && pnpm test   # backend: tsc + vitest
cd web && pnpm test                      # web UI logic (vitest)
cd web && pnpm build                     # type-check + build
```

CI runs the same commands on every pull request.

## Pull requests

- One focused change per PR, with a clear description of what and why.
- Link the issue it closes (`Closes #123`).
- Never commit secrets, `.env`, `data/`, OAuth tokens or `config/persona.md`.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), and you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

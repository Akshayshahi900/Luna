# Development

How to work on Luna itself. Contribution rules are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Setup

```bash
pnpm install && pnpm build       # core, web and site dependencies; builds web/dist (Node 22.18+)
cp .env.example .env   # add a key, or use Ollama locally
```

## Repository layout

```
core/            the backend in TypeScript (D41)
  bin/           the luna, luna-web and luna-google-auth programs
  src/           agent, tools, CLI, web server, Control Center, routines, channels, voice
  servers/       MCP servers started by config/mcp_servers.json
  test/          vitest suite (fake model; helpers.ts)
config/          MCP config and persona example
web/             browser UI (Vite + React + React Three Fiber)
site/            product website (Vite + React), published to GitHub Pages
docs/            user and developer guides (this folder)
spec/            design specs, one per feature milestone
ARCHITECTURE.md  how the pieces fit, file by file
DECISIONS.md     architectural decisions (D1, D2, …), newest last
```

Start reading at [`spec/beginner-guide.md`](../spec/beginner-guide.md),
then `core/src/agent/builder.ts`.

## Tests

```bash
cd core && pnpm test                              # whole backend suite (vitest)
cd core && pnpm exec vitest run test/fs.test.ts   # one file
cd core && pnpm exec vitest run -t approval       # by name
cd core && pnpm typecheck                         # tsc --noEmit (strict)
cd web && pnpm test                               # web logic (vitest, *.test.ts next to the module)
cd web && pnpm build                              # type-check + production build
```

Node runs the backend's `.ts` files as they are (type stripping), so
there's nothing to build. Keep to erasable TypeScript: no `enum`, no
`namespace`, no constructor parameter properties, and import local files
with their `.ts` extension. The Telegram voice-note tests need `ffmpeg`.

Tests never call a real model. `core/test/helpers.ts` provides
`FakeToolModel`, a scripted chat model that records what it was sent, so
you can assert on prompts, tool calls and approvals. Keep new tests that
way: no network, no API keys, no free-tier usage.

CI (`.github/workflows/ci.yml`) runs the backend type-check and tests and
the web and site tests and builds on every pull request.

## Web UI development

```bash
pnpm web --no-window   # backend on :8765
cd web && pnpm dev     # Vite on :5173 with hot reload
```

The Vite origin is allowed by default (`LUNA_WEB_ALLOWED_ORIGINS`). The
WebSocket protocol is documented in [`web-ui.md`](web-ui.md); its types
are in `web/src/lib/protocol.ts` and `core/src/web/events.ts`.

## Website

```bash
cd site                   # (pnpm install at the root installs it)
pnpm dev                  # http://localhost:5174/Luna/
pnpm test && pnpm build   # what CI and the Pages deploy run
```

All text is in `site/src/content.ts`; sections in `site/src/sections/`
only lay it out. Screenshots in `site/public/screens/` (`hud`, `overview`,
`routines`, `models`, `permissions`, `mobile` as `.webp`, plus `og.jpg`
for link previews) are taken from `luna-web` running on **demo data**:
- a fake model and fake mail / calendar / to-do tools;
- seeded memories and usage;
- a temporary `.env`.

Never use your own data. Take them at 1440×900 (mobile at 390×844) and
keep the file names.

Pushing changes under `site/` to `main` deploys the site
(`.github/workflows/site.yml`). The first time, set the repo's Settings →
Pages → Source to "GitHub Actions".

## Keeping docs in step

| You changed… | Update |
| --- | --- |
| an architectural choice | add `D<n>` to `DECISIONS.md` |
| files, topology, data flow | `ARCHITECTURE.md` |
| a setting | `settings.ts` field description, `.env.example`, [`configuration.md`](configuration.md); put the field in a group in `config/schema.ts` (`GROUPS`) so the Control Center shows it (a test checks every field has a group) |
| a Control Center route or routine | [`control-center.md`](control-center.md), `web/src/lib/control.ts` types |
| a CLI command | `HELP_TEXT` in `cli/chat.ts`, [`cli.md`](cli.md) |
| a tool, helper or MCP server | [`agents-and-tools.md`](agents-and-tools.md) |
| feature design | the matching `spec/specN.md` |
| a user-visible feature | `site/src/content.ts` (capabilities, specs, usage, FAQ) and, if it shows, a screenshot |

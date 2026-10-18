# Control Center

The Control Center is an OS-style settings layer in the web UI. It covers:
- every setting;
- MCP connectors and sign-ins;
- model providers and the web server ("gateway");
- tool permissions;
- the HUD dashboard;
- scheduled routines;
- live stats about Luna.

Open it with the **SYSTEM** (gear) button in the dock, the **S** key, or
`http://127.0.0.1:8765/#/control`. **Esc** or ✕ goes back to the HUD. The
chat socket stays connected underneath, so a running task carries on.

Design: [`spec/spec8.md`](../spec/spec8.md). Decisions: D34–D36 in
[`DECISIONS.md`](../DECISIONS.md).

## Apps

| App | What you can do |
| --- | --- |
| **Overview** | Live tiles, refreshed every 5 s. They show: <ul><li>insights (mail, calendar, to-dos);</li><li>Luna's CPU and RAM, system memory and load;</li><li>the model in use, plus model/tool calls today with a 14-day chart;</li><li>memories by kind and suggestions to review;</li><li>sessions;</li><li>tools per helper and MCP errors;</li><li>routines (next runs, recent runs);</li><li>usage per model.</li></ul> |
| **Models** | <ul><li>See which provider is in use and which is the startup default.</li><li>Pick a model from the provider's live list.</li><li>**Save default** writes `LUNA_PROVIDER` and the model key to `.env`. **Save & switch now** also switches every tab.</li><li>Edit keys, endpoints and loop limits.</li></ul> |
| **Connectors** | <ul><li>The servers in `config/mcp_servers.json` with a status light (connected / failed / off / restart to load).</li><li>Add a stdio command or HTTP URL server, give it to a helper (e.g. assistant), switch it off, or remove it.</li><li>Tool switches (`LUNA_ENABLE_MCP_TOOLS`, built-ins).</li></ul> |
| **Logins** | <ul><li>Google sign-in status and checks.</li><li>**Connect Google** opens Google's consent page in your browser (the same flow as `luna-google-auth`). **Sign out** deletes the token.</li><li>Mail backend (Gmail or IMAP) and credentials.</li><li>API keys: write-only, so you can replace or clear one but never read it back.</li></ul> |
| **Permissions** | <ul><li>Every tool of the main agent and each helper: **asks first**, **runs without asking** (`LUNA_AUTO_APPROVE`) or **read-only**.</li><li>Switch a risky tool to run without asking (you're asked to confirm).</li><li>Edit the workspace sandbox folders.</li></ul> |
| **Routines** | <ul><li>Switch the insight checks on.</li><li>Create agent routines (a prompt on a schedule).</li><li>Edit schedules (with presets and a live preview), run now, and see run history.</li></ul> |
| **Dashboard** | The HUD widgets: which show, which corner, compact or minimal, opacity, and whether the keyboard hint line shows. |
| **Gateway** | <ul><li>The page and WebSocket addresses and a health check.</li><li>Host, port and allowed origins.</li><li>A warning if Luna listens beyond this computer.</li></ul> |
| **General** | Persona, memory, voice and routine settings. |
| **All settings** | Every `LUNA_*` setting with search. Also offers to remove keys Luna no longer reads (e.g. `LUNA_DEFAULT_THREAD_ID`). |

## Saving settings

Changes are written straight into the project's `.env`:
- only the changed lines are rewritten;
- your comments and the order of the keys are kept;
- new keys are added at the end.

Each value is checked by re-reading the file. If Luna would reject it,
the file is put back exactly as it was and the form shows why.

**reset** removes a key from `.env`, so its default applies again.
**clear** on a secret removes the saved key.

Each field has a badge saying when a change takes effect:

| Badge | Meaning |
| --- | --- |
| **LIVE** | Read fresh on every use (mail and Google settings, which the MCP servers read per call) |
| **INSTANT** | The agent is rebuilt right away with the same memory and MCP connections (persona, limits, API keys, auto-approve, sandbox, …) |
| **RESTART** | Applied after restarting `luna-web` (storage paths, web server, voice, provider at startup, MCP server list). A banner lists them until you restart. |

A variable exported in your shell overrides `.env`, as it always has.

## Routines

A routine is a job on a 5-field cron schedule (`minute hour day month
weekday`, e.g. `0 8 * * 1-5` = weekdays at 08:00). Times use
`LUNA_TIMEZONE`, or the machine's timezone if that isn't set.

There are two kinds:

- **Insights (built-in, no LLM):**
  - **Check email** (`list_inbox`, unread only);
  - **Today's agenda** (`get_agenda`);
  - **To-dos** (`list_tasks`).

  Each calls one read-only MCP tool directly, so it costs no model calls.
  They start switched off. Turn them on to fill the HUD widgets and the
  Overview. If the server isn't configured, the run says "Not connected".
- **Agent routines (use the LLM):** your prompt, run by Luna on its own
  thread `routine-<id>`. You can open that thread in the transcript; it
  shows in the session list. Each run gets the normal task budget.
  - Nobody is there to approve, so **risky tools are refused**. The run
    lists what it couldn't do.
  - Only tools you set to "run without asking" can change anything.

Routines run **only while `luna-web` is running**:
- they run one at a time;
- a missed run is skipped, not made up later;
- **run now** runs one immediately.

`LUNA_ROUTINES_ENABLED=false` turns the scheduler off.

## HUD widgets

Small cards sit in a bottom corner of the voice screen: unread mail, the
next event, and to-dos due or overdue. You can also add Luna's calls
today and memory count. They update the moment a routine finishes, and
clicking one opens the Control Center. They hide on narrow screens and
while the transcript or memory drawer is open.

## HTTP API

Everything is JSON under `/api/control/`, with the same Origin check as
the WebSocket (403 for other sites).

| Route | |
| --- | --- |
| `GET settings` | `{env_path, groups: [{id, title, fields: [{name, env, kind, choices, description, secret, applies, value, is_set, default, in_file}]}], unknown, restart_required}` |
| `PATCH settings` | `{values: {field: value \| null}, remove_unknown?: [KEY]}` → the schema plus `{ok, effects, rebuilt, restart_required}`. 400 with `error` if invalid; 409 if saved but the agent couldn't be rebuilt |
| `GET mcp` | `{path, enabled, helpers, servers: [{name, agent, command, args, url, env_keys, disabled, status, error, tools}]}` |
| `PUT mcp/{name}` | `{command, args} \| {url}`, `agent?`, `disabled?`, `env?: {KEY: value \| null}` → the list |
| `DELETE mcp/{name}` | → the list (404 if missing) |
| `GET connections` | `{google: {client_file, token, ok, error, signing_in}, mail: {backend, address, password_set, ready, …}, keys: {openrouter, groq, tavily}}` |
| `POST` / `DELETE connections/google` | Sign in (waits for the consent page, ≤ 5 min) / sign out |
| `GET providers` | `{providers, current, default, can_switch}` |
| `GET providers/{id}/models` | `{provider, models, error?}` |
| `POST providers/default` | `{provider, model, apply}` → providers |
| `GET permissions` | `{tools: [{name, owner, risky, mode: ask \| auto \| free, can_toggle}], helpers, auto_approve, workspace_dirs}` |
| `GET stats` | `{uptime, process, system, model, tabs, memory, storage, sessions, helper_tools, tools, usage: {since_start, days, models}, routines, restart_required}` |
| `GET insights` | `{insights: {mail_check?, agenda?, todos?: run}, dashboard}` |
| `GET` / `PUT dashboard` | `{widgets: {mail, agenda, todos, stats}, position, style, opacity, show_hints}` |
| `GET routines`, `POST routines` `{name, prompt, cron, enabled?, notify?}` | `{routines, builtins, scheduler, timezone}` |
| `PATCH` / `DELETE routines/{id}` | change (name, prompt, cron, enabled, notify) / delete an agent routine |
| `POST routines/{id}/run` | run now → `{run, …routines}` (409 if it's already running) |
| `GET routines/{id}/runs` | `{runs: [{status, summary, data, error, started_at, finished_at}]}` |
| `GET cron?expr=` | `{valid, text, next: [3 times]}` or `{valid: false, error}` |

WebSocket events for the Control Center are listed in
[`web-ui.md`](web-ui.md#websocket-protocol-ws): `routine_result`,
`settings_changed` and `dashboard`.

## Files

- **Backend:** `src/luna/web/control.py` (routes), `src/luna/config/envfile.py` and
  `schema.py` (writing `.env`), `src/luna/routines/` (cron, store, built-ins,
  agent runner, scheduler).
- **Frontend:** `web/src/components/control/` (shell and apps),
  `web/src/components/InsightWidgets.tsx`, `web/src/lib/control.ts` (client and
  helpers), `web/src/control.css`.
- **Data** (git-ignored): `data/luna_routines.sqlite` and `data/dashboard.json`.

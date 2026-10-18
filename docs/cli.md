# Command line

Luna installs three commands (`[project.scripts]` in `pyproject.toml`):

| Command | What it does | Code |
| --- | --- | --- |
| `uv run luna` | Chat in the terminal | `src/luna/cli/chat.py` |
| `uv run luna-web` | Voice-first web UI at <http://127.0.0.1:8765> | `src/luna/web/server.py`, [`web-ui.md`](web-ui.md) |
| `uv run luna-google-auth` | One-time Google sign-in (Gmail, Calendar, Tasks) | `src/luna/integrations/google.py`, [`google.md`](google.md) |

## `luna`

```bash
uv run luna                 # new session
uv run luna --resume        # continue the most recent session
uv run luna --resume 3      # continue session 3 from /sessions (or pass its id)
```

Every start opens a **new session** (thread) unless you pass `--resume`
(DECISIONS.md D30).

### Chat commands

| Command | What it does |
| --- | --- |
| `/help` | Show the commands |
| `/tools` | List the tools the main agent can call |
| `/sessions` | List saved sessions (1 = most recent) |
| `/resume <n\|id>` | Continue a saved session |
| `/delete <n\|id>` | Delete a saved session (asks first) |
| `/session` | Show the current session |
| `/new` | Start a new session |
| `/memory …` | Long-term memory (below) |
| `/quit`, `/exit` | Leave |

### `/memory`

Long-term memory is shared by every session and only you change it
([`memory.md`](memory.md)). Ids may be written `12`, `m12` or `s3`.

| Command | What it does |
| --- | --- |
| `/memory` | List saved memories |
| `/memory search <words>` | Find memories |
| `/memory add [kind:]<text>` | Save one; kinds: `fact`, `preference`, `person`, `project` |
| `/memory edit <id> <text>` | Change a memory's text |
| `/memory rm <id>` | Delete (undo brings it back) |
| `/memory pin <id>` | Pin / unpin; pinned memories are always shown to Luna |
| `/memory undo <id>` | Revert the last change |
| `/memory history <id>` | Show a memory's changes |
| `/memory inbox` | Luna's suggestions waiting for you |
| `/memory accept <id> [text]` | Accept suggestion `s<id>`, optionally reworded |
| `/memory reject <id>` | Decline a suggestion (it won't be suggested again) |

### Approvals

When a tool would change something (write a file, run a command, send an
email, create an event…), the run pauses and asks:

```
[a]pprove / [e]dit / [r]eject
```

- **approve** runs it as proposed
- **edit** lets you change the arguments first
- **reject** skips it; the agent is told not to retry

Tools listed in `LUNA_AUTO_APPROVE` skip the question. The agent can also
pause to ask you a question with `ask_user`.

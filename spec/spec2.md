# Spec 2 — Loop limits and subagents

**Date:** 2026-10-18  
**Status:** Implemented (limits + subagent seam; no subagents shipped yet)  
**Scope:** How Luna decides between doing a task itself and delegating it, and how runaway loops are capped

---

## 1. Decision

Luna has **one main ReAct agent**. A subagent is **just another tool**:
`ask_<name>(task)` runs a separate, capped agent with its own tools and a
fresh context, and returns only its final answer.

There is no hard-coded router. On every step the main agent's model picks
between its own tools and the delegate tools, exactly as it picks between
`calculator` and `get_current_time`, steered by the tool descriptions.

```
User → Main agent (ReAct, ≤ 25 model calls, ≤ 40 tool calls per message)
         ├─ direct tools: time, calculator, small MCP tools
         └─ delegate tools ─→ Subagent (ReAct, ≤ 10 model calls, timeout, fresh context)
         One level only: subagents cannot delegate further.
```

## 2. When something becomes a subagent

Decided **per domain, at design time** — not per request.

Keep it a **direct tool** on the main agent when:

- one or two calls finish the job (time, math, a lookup);
- the user benefits from seeing each step, or the raw result feeds the answer;
- the main agent has ≲ 15 tools and they don't overlap.

Make it a **subagent** only when at least one holds:

1. **Noisy, multi-step work** — research, reading big files, browsing. Keeps
   junk out of the main thread's history; only a summary comes back.
2. **Too many / look-alike tools** — past ~15 tools the model starts picking
   wrong. Group a whole domain (e.g. all GitHub MCP tools) behind one delegate.
3. **Different setup** — cheaper/faster model, separate prompt, or tighter
   permissions (e.g. a file-writing helper behind human approval).
4. **Independent, parallel pieces** — the main agent can call several
   delegates in one turn.

Otherwise don't: each hand-off adds latency and cost and loses context
(the subagent sees only the `task` text, not the conversation).

## 3. Limits

| Where | Mechanism | On hitting it |
| --- | --- | --- |
| Main agent model calls | `ModelCallLimitMiddleware(run_limit=LUNA_MAX_MODEL_CALLS)` (10; was 25) | Run ends; CLI prints `⚠ Model call limits exceeded…` |
| Main agent tool calls | `ToolCallLimitMiddleware(run_limit=LUNA_MAX_TOOL_CALLS)` (20; was 40) | Extra calls return errors; model answers with what it has |
| Subagent model calls | `SubagentSpec.max_model_calls` (default 6; researcher 5, files 6, coder 10, assistant 5) | Delegate returns `[name stopped at its limit of N steps]` + last partial text |
| Subagent wall time | `SubagentSpec.timeout_seconds` (120) via `asyncio.wait_for` | Delegate returns `[name stopped: timed out after Ns]` |
| Backstop | LangGraph `recursion_limit = max_model_calls * 4 + 10` | Error (should never trigger) |

Limits are **per user message** (`run_limit`), not per thread.

### 3a. Fewer API calls (added 2026-10-18)

Every model call is one request to the provider, and free tiers run out
fast, so the defaults were cut and the prompts ask for economy (DECISIONS D25):

- Lower caps: main 10 model / 20 tool calls, task budget 30 (was 80),
  helpers as in the table above.
- `LUNA_MODEL_MAX_RETRIES` (default 1; the OpenAI client's is 2): each
  retry of a failed/rate-limited request is another request.
- Summarization keeps `LUNA_SUMMARY_KEEP_TOKENS` (default 4000, capped at
  half of `LUNA_SUMMARY_TRIGGER_TOKENS`) instead of 20 messages. Keeping a
  message count could leave the kept part above the trigger, so every
  model call would also pay for a fresh summary.
- Prompts (main and helpers): answer directly when possible, call
  independent tools in the same step, give a helper everything in one
  call, and stop searching once the answer is good enough.

## 4. Implementation

- `luna/agent/builder.py` — `build_middleware()` (limits + summarization),
  `recursion_limit()`, and registration of delegate tools in `build_agent()`.
- `luna/agent/subagents.py` — `SubagentSpec`, `make_delegate_tool()`,
  `get_subagent_specs()` (empty list for now).
  - ~~Subagents are built with `checkpointer=False`~~ — **superseded by
    spec3 / DECISIONS.md D8**: subagents now inherit the main checkpointer
    (`None`) so approval pauses can resume; every task still starts fresh.
  - Delegate tools carry `metadata={"luna_delegate": True}`; a spec whose tools
    include one is rejected (no nesting).
- `luna/cli/chat.py` — streams with `subgraphs=True`; subagent steps print
  indented under the delegate call, middleware notices print with `⚠`.

### Adding a subagent

Append a `SubagentSpec` to `get_subagent_specs()`:

```python
SubagentSpec(
    name="ask_researcher",
    description="Research a question on the web and return a short summary "
    "with sources. Use for anything needing several searches.",
    system_prompt="You are a careful researcher. Cite sources.",
    tools=[web_search, fetch_page],
    max_model_calls=10,
)
```

The `description` is what makes the main agent choose it — write it like a
tool docstring, saying *when* to use it.

## 5. Next

- First real subagent once a domain meets §2 — likely **research**
  (web search + page fetch, rule 1).
- Let MCP servers be assigned to a subagent from `config/mcp_servers.json`
  (e.g. `"agent": "research"`) instead of the main agent.

## 6. Tests

`tests/test_limits.py`, `tests/test_subagents.py` (fake models, no API key):
caps end cleanly, limits reset per message, delegation returns only the
answer, each delegation is fresh, timeouts and limits return marked partial
results, nesting is refused, CLI indents subagent steps.

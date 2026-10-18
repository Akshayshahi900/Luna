# Personalizing Luna

For facts Luna should remember about you across conversations, use
long-term memory instead: see `docs/memory.md`.

Luna's behaviour comes from her system prompt, which is built from a few
settings plus an optional file (`src/luna/agent/persona.py`). Set them in
`.env` and restart `luna` / `luna-web`.

| Setting | Default | What it does |
| --- | --- | --- |
| `LUNA_RESPONSE_STYLE` | `concise` | `concise`: one or two spoken sentences, no lists, markdown or URLs unless you ask. `detailed`: fuller written answers. |
| `LUNA_USER_TITLE` | `Sir` | How she addresses you, once per reply. Empty = not used. |
| `LUNA_USER_NAME` | — | Your name. Used for address when the title is empty. |
| `LUNA_USER_LOCATION` | — | Default place for weather, local time, news, "near me". |
| `LUNA_UNITS` | `metric` | `metric` (Celsius, km) or `imperial` (Fahrenheit, miles). |
| `LUNA_TIMEZONE` | — | IANA name, e.g. `Asia/Kolkata`, for the local time. |
| `LUNA_PERSONA_PATH` | `config/persona.md` | Free-form extra instructions, added last. |
| `LUNA_SYSTEM_PROMPT` | built-in | Luna's role. Replace it only if you know why. |

Example:

```env
LUNA_USER_TITLE=Sir
LUNA_USER_LOCATION=Agra, India
LUNA_TIMEZONE=Asia/Kolkata
```

> You: what's the weather?
> Luna: It's 33 degrees, Sir, with a 30 percent chance of rain.

## Anything else: `config/persona.md`

Copy `config/persona.example.md` to `config/persona.md` (git-ignored) and
write plain instructions: interests, preferred sources, how formal to be,
words to avoid. Keep it short, because it is sent with every model call.

## Getting more detail

Concise mode still answers in full when you ask for it: "explain",
"give me the details", "list the steps", or anything that needs code.

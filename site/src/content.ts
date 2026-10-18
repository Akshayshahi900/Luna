// Everything the site says, in one place. Sections only lay it out.
// Keep in step with README.md, docs/ and DECISIONS.md when Luna changes.

export const REPO = "https://github.com/Akshayshahi900/Luna";
export const DOCS = `${REPO}/tree/main/docs`;
export const blob = (path: string) => `${REPO}/blob/main/${path}`;

export type IconName =
  | "mic"
  | "agents"
  | "memory"
  | "shield"
  | "grid"
  | "clock"
  | "window"
  | "terminal"
  | "mail"
  | "search"
  | "code"
  | "files"
  | "lock"
  | "chip"
  | "plug"
  | "history";

/** Page sections, in order: Nav links come from here. */
export const SECTIONS = [
  { id: "capabilities", label: "Capabilities" },
  { id: "showcase", label: "Tour" },
  { id: "how", label: "How it works" },
  { id: "specs", label: "Specs" },
  { id: "install", label: "Install" },
  { id: "usage", label: "Use" },
  { id: "faq", label: "FAQ" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const HERO = {
  kicker: "Open source · MIT · runs on your machine",
  title: "Your local, voice-first AI assistant.",
  pitch:
    "Say “Hey Luna”. She listens and speaks on your own computer. She researches, writes code, manages files, reads your mail and calendar, and keeps your to-dos. Anything risky waits for your OK.",
  stats: [
    { value: "4", label: "helper agents" },
    { value: "3", label: "model providers" },
    { value: "0", label: "audio sent to the cloud" },
  ],
};

export interface Capability {
  icon: IconName;
  title: string;
  text: string;
  points: string[];
}

export const CAPABILITIES: Capability[] = [
  {
    icon: "mic",
    title: "Voice first",
    text: "A HUD with a 3D core that reacts as Luna listens, thinks and speaks.",
    points: [
      "“Hey Luna” wake word, push-to-talk on Space",
      "Speech recognition (Whisper) and voice (Piper) run locally on the CPU",
      "Interrupt her mid-sentence; say “Luna, cancel” to stop a task",
    ],
  },
  {
    icon: "agents",
    title: "Helper agents",
    text: "One main agent does quick things itself and hands bigger jobs to specialists.",
    points: [
      "Researcher: live web search with Tavily",
      "Files and Coder: read, write and run code inside a sandbox folder",
      "Assistant: mail, calendar and to-dos",
    ],
  },
  {
    icon: "mail",
    title: "Mail, calendar, to-dos",
    text: "One Google sign-in for Gmail, Google Calendar and Google Tasks. IMAP works for any other provider.",
    points: [
      "“Any mail from the bank?” · “Move the dentist to 11”",
      "Turn an email into a to-do or a calendar event",
      "To-dos work offline and sync both ways with Google Tasks",
    ],
  },
  {
    icon: "shield",
    title: "You approve risky actions",
    text: "Writing files, running commands and sending email pause until you decide.",
    points: [
      "Approve, edit the arguments, or deny with a reason",
      "Answer by voice: “yes, go ahead” / “no, call it notes.md”",
      "Choose per tool what may run without asking",
    ],
  },
  {
    icon: "memory",
    title: "Memory you control",
    text: "Luna remembers facts about you across conversations, but only what you accept.",
    points: [
      "Luna suggests; you accept, edit or decline",
      "Pin what matters, search, undo any change",
      "Long threads are summarized automatically to save tokens",
    ],
  },
  {
    icon: "clock",
    title: "Routines & insights",
    text: "Scheduled jobs that keep you posted without you asking.",
    points: [
      "Mail, agenda and to-do checks that use no LLM calls",
      "Your own prompts on a schedule: “weekdays at 8, brief me”",
      "Results appear as subtle cards on the HUD",
    ],
  },
  {
    icon: "grid",
    title: "Control Center",
    text: "An OS-style settings layer with live stats.",
    points: [
      "Every setting, saved to .env with your comments kept",
      "MCP connectors, logins, model providers, permissions",
      "CPU, memory, API usage, sessions, routines at a glance",
    ],
  },
  {
    icon: "plug",
    title: "Extensible with MCP",
    text: "Add tools from any Model Context Protocol server, local or remote, and give them to the main agent or a helper.",
    points: [
      "stdio commands or HTTP URLs, configured in one JSON file",
      "Tools with names like send / delete / create ask first automatically",
      "Switch connectors on and off from the UI",
    ],
  },
  {
    icon: "chip",
    title: "Any model",
    text: "OpenRouter, Groq or a local Ollama model, switchable while Luna runs.",
    points: [
      "Switch provider by voice: “switch to Groq”",
      "Per-message budgets keep free tiers from running dry",
      "Fully offline with Ollama and local voice",
    ],
  },
  {
    icon: "window",
    title: "Feels like a desktop app",
    text: "luna-web opens Luna in its own window with its own taskbar icon.",
    points: [
      "Starts by itself, no browser tabs or address bar",
      "Closing the window quits Luna",
      "Add Luna to your applications menu with one command",
    ],
  },
  {
    icon: "history",
    title: "Sessions",
    text: "Every start is a fresh conversation, so context never piles up. Old ones are a click away.",
    points: [
      "Resume or delete saved sessions in the transcript",
      "A context meter shows when summarizing kicks in",
      "Pauses survive reloads and restarts",
    ],
  },
  {
    icon: "terminal",
    title: "Terminal too",
    text: "The same agent in a CLI, with streaming output and the same approvals.",
    points: ["uv run luna", "/sessions, /resume, /memory", "Helper steps shown indented as they run"],
  },
];

export interface Shot {
  id: string;
  label: string;
  src: string; // relative to the site's base URL
  caption: string;
  mobile?: boolean;
}

export const SHOTS: Shot[] = [
  {
    id: "hud",
    label: "Voice HUD",
    src: "screens/hud.webp",
    caption: "The voice HUD: the core, neural activity, subsystems, the dock, and routine insights in the corner.",
  },
  {
    id: "overview",
    label: "Overview",
    src: "screens/overview.webp",
    caption: "Control Center overview: insights, system load, API usage over 14 days, memory, sessions, tools and routines.",
  },
  {
    id: "routines",
    label: "Routines",
    src: "screens/routines.webp",
    caption: "Routines: data-only checks that cost no model calls, plus your own scheduled prompts.",
  },
  {
    id: "models",
    label: "Models",
    src: "screens/models.webp",
    caption: "Model providers: pick OpenRouter, Groq or Ollama, browse live model lists, set keys and limits.",
  },
  {
    id: "permissions",
    label: "Permissions",
    src: "screens/permissions.webp",
    caption: "Permissions: every tool that can change something asks first, unless you say otherwise.",
  },
  {
    id: "mobile",
    label: "Small screens",
    src: "screens/mobile.webp",
    caption: "The Control Center works at phone width too.",
    mobile: true,
  },
];

export const FLOW = [
  {
    title: "You speak",
    text: "Whisper turns your words into text on your machine. The wake word and voice detection run in the page.",
  },
  {
    title: "Luna plans",
    text: "The main agent sees your persona, its notes, and the memories that match. It answers directly or calls a tool.",
  },
  {
    title: "Helpers work",
    text: "Bigger jobs go to a helper with its own capped loop. A risky step pauses for your approval.",
  },
  {
    title: "Luna answers",
    text: "The reply streams back sentence by sentence, and Piper speaks it while the core moves with her voice.",
  },
];

export const CONVERSATIONS: { title: string; lines: { who: "you" | "luna" | "tool"; text: string }[] }[] = [
  {
    title: "Calendar",
    lines: [
      { who: "you", text: "Hey Luna, what's on tomorrow?" },
      { who: "tool", text: "ask_assistant → get_agenda" },
      { who: "luna", text: "Standup at nine, and the dentist at five thirty. Two to-dos are due, Sir." },
    ],
  },
  {
    title: "Email → to-do",
    lines: [
      { who: "you", text: "Make a to-do from the invoice email, due Friday." },
      { who: "tool", text: "add_task_from_email · awaiting approval" },
      { who: "you", text: "Yes, go ahead." },
      { who: "luna", text: "Added “Pay invoice #2231” for Friday. It's synced to Google Tasks." },
    ],
  },
  {
    title: "Coding",
    lines: [
      { who: "you", text: "Write a script that renames my photos by date, and run it." },
      { who: "tool", text: "ask_coder → write_file, run_command · awaiting approval" },
      { who: "you", text: "Approve." },
      { who: "luna", text: "Done: 214 photos renamed in workspace/photos." },
    ],
  },
  {
    title: "Routine",
    lines: [
      { who: "you", text: "Every weekday at eight, brief me on mail and my day." },
      { who: "luna", text: "Routine “Morning brief” created: weekdays at 08:00. It uses a few model calls per run." },
    ],
  },
];

export const SPECS: { group: string; rows: [string, string][] }[] = [
  {
    group: "Agent",
    rows: [
      ["Framework", "LangChain create_agent on LangGraph 1.x"],
      ["Helpers", "researcher, files, coder, assistant (each with its own call limit and timeout)"],
      ["Tools", "built-ins, MCP servers (stdio + HTTP), scratchpad, to-do planning"],
      ["Safety", "human-in-the-loop approval, sandboxed workspace, per-message task budget"],
    ],
  },
  {
    group: "Models",
    rows: [
      ["Providers", "OpenRouter · Groq · Ollama (all via the OpenAI-compatible API)"],
      ["Switching", "live, by voice, the HUD, or the Control Center"],
      ["Default limits", "10 model calls, 20 tool calls, task budget 30 per message"],
    ],
  },
  {
    group: "Voice",
    rows: [
      ["Speech in", "faster-whisper (tiny.en / base.en / small.en), local CPU"],
      ["Speech out", "Piper neural TTS (en_US-lessac-medium by default), local CPU"],
      ["Wake word", "“Hey Luna”, detected in the page while it's open"],
    ],
  },
  {
    group: "Memory & data",
    rows: [
      ["Conversations", "SQLite checkpoints, auto-summarized past 12k tokens"],
      ["Long-term memory", "SQLite + FTS5 keyword search, user-approved, with full history"],
      ["Routines", "SQLite: schedules, run history, daily API usage"],
      ["Location", "everything in the project's data/ folder"],
    ],
  },
  {
    group: "Interfaces",
    rows: [
      ["Desktop / web", "React 19 + React Three Fiber HUD, served by Starlette over a WebSocket"],
      ["App window", "Chrome / Chromium / Edge / Brave app mode, own profile"],
      ["CLI", "uv run luna"],
      ["Integrations", "Gmail API or IMAP/SMTP, Google Calendar, Google Tasks, Tavily"],
    ],
  },
  {
    group: "Project",
    rows: [
      ["Language", "Python 3.14 (uv), TypeScript"],
      ["License", "MIT"],
      ["Tests", "pytest + vitest with a fake chat model: no API keys, no LLM quota"],
    ],
  },
];

export const PRIVACY = [
  { icon: "lock" as IconName, title: "Local by default", text: "The server listens on 127.0.0.1. Speech recognition and the voice run on your CPU." },
  { icon: "shield" as IconName, title: "Nothing risky without you", text: "Sending, writing, deleting and running commands pause for approval, and routines can't approve anything." },
  { icon: "memory" as IconName, title: "Your memory, your call", text: "Luna can only suggest memories, and never suggests saving passwords or keys." },
  { icon: "files" as IconName, title: "Sandboxed files", text: "The file and code helpers only touch the folders you list." },
];

export interface InstallStep {
  title: string;
  text: string;
  code?: string;
  optional?: boolean;
}

export const INSTALL: InstallStep[] = [
  {
    title: "Get the code and the tools",
    text: "You need Python 3.14 with uv, and Node.js 22+ for the interface.",
    code: "git clone https://github.com/Akshayshahi900/Luna.git\ncd Luna\nuv sync",
  },
  {
    title: "Add a model key",
    text: "Copy the example settings and add an OpenRouter or Groq key. With Ollama, no key is needed.",
    code: "cp .env.example .env\n# edit .env: LUNA_OPENROUTER_API_KEY=sk-or-...",
  },
  {
    title: "Build the interface",
    text: "One-time build of the HUD and Control Center.",
    code: "cd web && npm install && npm run build && cd ..",
  },
  {
    title: "Start Luna",
    text: "Luna opens in her own window and comes online. The first start downloads the voice (~60 MB) and speech model (~140 MB).",
    code: "uv run luna-web",
  },
  {
    title: "Optional extras",
    text: "Add Luna to your app menu, connect Google (Gmail, Calendar, Tasks), or enable web research.",
    code: "uv run luna-web --install-desktop\nuv run luna-google-auth\n# .env: LUNA_TAVILY_API_KEY=tvly-...",
    optional: true,
  },
];

export const SHORTCUTS: [string, string][] = [
  ["Space", "Talk (push-to-talk)"],
  ["/", "Type a command"],
  ["T", "Transcript & sessions"],
  ["K", "Long-term memory"],
  ["M", "Switch model"],
  ["S", "Control Center"],
  ["Esc", "Stop the task / hush"],
];

export const VOICE_COMMANDS: [string, string][] = [
  ["“Hey Luna, …”", "Wake her up hands-free"],
  ["“Luna, cancel”", "Stop the running task and its helpers"],
  ["“Stop” / “quiet”", "Hush her voice"],
  ["“Yes, go ahead” / “no”", "Approve or deny an action"],
  ["“Switch to Groq”", "Change the model provider"],
  ["“New conversation”", "Start a fresh session"],
  ["“Go to sleep”", "Stop listening hands-free"],
];

export const CLI: [string, string][] = [
  ["uv run luna", "Chat in the terminal (new session)"],
  ["uv run luna --resume", "Continue the last session"],
  ["/sessions · /resume <n>", "List and resume sessions"],
  ["/memory inbox", "Review Luna's memory suggestions"],
  ["/tools", "What the main agent can call"],
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Does it cost money?",
    a: "Luna is free and open source. Models cost whatever your provider charges: OpenRouter and Groq have free tiers, and Ollama is free and local. Luna keeps a per-message budget so free tiers last, and the insight routines use no model calls at all.",
  },
  {
    q: "Does my voice leave my computer?",
    a: "No. Speech recognition (Whisper) and the voice (Piper) run locally. Only the text of your request goes to the model provider you choose, or nowhere with Ollama.",
  },
  {
    q: "Which operating systems and browsers?",
    a: "Anything that runs Python 3.14. The app window uses Chrome, Chromium, Edge or Brave. Without one, Luna opens in your default browser. The interface works in any modern browser.",
  },
  {
    q: "Can it work fully offline?",
    a: "Yes, with an Ollama model that supports tool calling (e.g. qwen3). Web research and Google sync need the internet, of course.",
  },
  {
    q: "Can Luna do things without asking me?",
    a: "Only the tools you explicitly allow in Permissions (LUNA_AUTO_APPROVE). Everything that sends, writes, deletes or runs commands asks first, and scheduled routines can never approve anything.",
  },
  {
    q: "Where is my data?",
    a: "In the project's data/ folder: conversations, long-term memory, to-dos, routines and the Google token. Settings are in .env. None of it is committed to git.",
  },
  {
    q: "How do I add my own tools?",
    a: "Point Luna at any MCP server in the Connectors app (or config/mcp_servers.json). Tag it with a helper to give the tools to that helper instead of the main agent.",
  },
];

export const FOOTER_LINKS: [string, string][] = [
  ["GitHub", REPO],
  ["Documentation", DOCS],
  ["Architecture", blob("ARCHITECTURE.md")],
  ["Decisions", blob("DECISIONS.md")],
  ["Contributing", blob("CONTRIBUTING.md")],
  ["Security", blob("SECURITY.md")],
];

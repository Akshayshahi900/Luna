// Fixed HUD around the core: top bar, activity feed (left), systems (right).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { Activity, ActivityGroup, LunaState } from "../lib/state";
import { helperOf, nestActivity } from "../lib/state";
import { codename, LOOKS, type Phase } from "../lib/theme";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="clock">
      <div className="clock-time">{now.toLocaleTimeString([], { hour12: false })}</div>
      <div className="clock-date">
        {now.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}
      </div>
    </div>
  );
}

interface TopBarProps {
  phase: Phase;
  connected: boolean;
  provider?: string;
  onModelClick: () => void;
}

export function TopBar({ phase, connected, provider, onModelClick }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" />
        <div>
          <div className="brand-name">LUNA</div>
          <div className="brand-sub">NEURAL ASSISTANT // v0.1</div>
        </div>
      </div>
      <div className="phase-chip" data-phase={phase}>
        <span className="phase-dot" />
        <AnimatePresence mode="wait">
          <motion.span
            key={phase}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2 }}
          >
            {LOOKS[phase].label}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="topbar-right">
        <button className={`link ${connected ? "up" : "down"}`} onClick={onModelClick} title="Switch model (M)">
          <span className="link-bars">
            <i />
            <i />
            <i />
          </span>
          {connected ? `UPLINK · ${provider?.toUpperCase() ?? "…"}` : "NO LINK"}
        </button>
        <Clock />
      </div>
    </header>
  );
}

/** One line of text cut with an ellipsis: hover shows it all, click expands. */
function Clip({ text, full, className = "", as: Tag = "div" }: { text: string; full?: string; className?: string; as?: "div" | "dd" }) {
  const [open, setOpen] = useState(false);
  const whole = full ?? text;
  return (
    <Tag
      className={`${className} clip ${open ? "open" : ""}`}
      title={whole}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setOpen((v) => !v);
      }}
    >
      {open ? whole : text}
    </Tag>
  );
}

function argSummary(args: Record<string, unknown>): string {
  const preferred = ["task", "question", "path", "command", "query", "expression", "text"];
  for (const key of preferred) {
    if (typeof args[key] === "string") return String(args[key]);
  }
  const first = Object.values(args)[0];
  return first === undefined ? "" : typeof first === "string" ? first : JSON.stringify(first);
}

function label(a: Activity): string {
  if (a.status === "interrupted") return "INTERRUPTED";
  const helper = helperOf(a.name);
  if (helper) return `DEPLOY ${codename(helper)}`;
  return a.name.replace(/_/g, " ").toUpperCase();
}

/** Helper steps shown under a delegation; older ones collapse into "+N EARLIER". */
const MAX_CHILDREN = 5;

function ActivityItem({ a, nested }: { a: Activity; nested?: boolean }) {
  const text = a.status === "done" && a.preview ? `↳ ${a.preview}` : argSummary(a.args);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -24, filter: "blur(4px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0 }}
      className={`act ${a.status} depth-${nested ? 1 : Math.min(a.depth, 2)}`}
    >
      <span className="act-status" />
      <div className="act-body">
        <div className="act-name">{label(a)}</div>
        {text && <Clip className="act-arg" text={text} />}
      </div>
    </motion.li>
  );
}

function groupRows({ item, children }: ActivityGroup) {
  const hidden = Math.max(children.length - MAX_CHILDREN, 0);
  return [
    <ActivityItem key={item.id} a={item} />,
    ...(hidden
      ? [
          <motion.li key={item.id + "-more"} layout className="act-more">
            +{hidden} EARLIER
          </motion.li>,
        ]
      : []),
    ...children.slice(hidden).map((c) => <ActivityItem key={c.id} a={c} nested />),
  ];
}

export function ActivityFeed({ activity }: { activity: Activity[] }) {
  return (
    <section className="panel activity">
      <div className="panel-title">
        <span>NEURAL ACTIVITY</span>
        <span className="panel-count">{String(activity.length).padStart(2, "0")}</span>
      </div>
      <ul>
        <AnimatePresence initial={false}>{nestActivity(activity).slice(0, 9).flatMap(groupRows)}</AnimatePresence>
        {activity.length === 0 && <li className="act-empty">AWAITING DIRECTIVE</li>}
      </ul>
    </section>
  );
}

interface SystemProps {
  state: LunaState;
  /** WAKE WORD / WHISPER / BROWSER / TEXT ONLY */
  voiceLabel: string;
  onModelClick: () => void;
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
}

/** Thread tokens vs. the point where history gets summarized. */
function ContextMeter({ context }: { context?: LunaState["context"] }) {
  if (!context) return <dd>—</dd>;
  const ratio = context.max > 0 ? context.used / context.max : 0;
  const level = ratio > 0.9 ? "hot" : ratio > 0.7 ? "warm" : "";
  return (
    <dd className={`ctx ${level}`} title={`${context.used} / ${context.max} tokens (summarized beyond this)`}>
      <span className="ctx-bar">
        <i style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      </span>
      {kilo(context.used)} / {kilo(context.max)}
    </dd>
  );
}

function Agent({ name, role, working }: { name: string; role: string; working: boolean }) {
  return (
    <li className={`agent ${working ? "busy" : ""}`} title={working ? `${name} is working` : role}>
      <span className="agent-led" />
      <span>{name}</span>
      <span className="agent-role">{working ? "WORKING" : role}</span>
    </li>
  );
}

export function SystemPanel({ state, voiceLabel, onModelClick }: SystemProps) {
  const helpers = state.helpers.length ? state.helpers : [];
  const model = state.model?.split("/").pop()?.toUpperCase();
  return (
    <section className="panel systems">
      <div className="panel-title">
        <span>SUBSYSTEMS</span>
      </div>
      <dl className="sys-grid">
        <dt>LINK</dt>
        <dd>
          <button className="sys-link" onClick={onModelClick} title="Switch model (M)">
            {state.provider?.toUpperCase() ?? "—"} ▾
          </button>
        </dd>
        <dt>MODEL</dt>
        {state.switching || !model ? (
          <dd>{state.switching ? "RELINKING…" : "—"}</dd>
        ) : (
          <Clip as="dd" text={model} full={state.model} />
        )}
        <dt>THREAD</dt>
        <dd title={state.threadId}>{state.threadId?.slice(0, 12).toUpperCase() ?? "—"}</dd>
        <dt>TOOLS</dt>
        <dd>{state.tools.length}</dd>
        <dt>OPS</dt>
        <dd>{state.ops}</dd>
        <dt>VOICE IN</dt>
        <dd className={voiceLabel === "TEXT ONLY" ? "warn" : "ok"}>{voiceLabel}</dd>
        <dt>CONTEXT</dt>
        <ContextMeter context={state.context} />
      </dl>
      <div className="panel-title small">
        <span>AGENTS</span>
      </div>
      <ul className="agents">
        <Agent name="LUNA" role="CORE" working={state.busy && state.activeHelpers.length === 0} />
        {helpers.map((h) => (
          <Agent key={h} name={codename(h)} role={h.toUpperCase()} working={state.activeHelpers.includes(h)} />
        ))}
      </ul>
    </section>
  );
}

/** Decorative corner brackets and edge readouts. */
export function Frame() {
  return (
    <div className="frame" aria-hidden>
      <i className="c tl" />
      <i className="c tr" />
      <i className="c bl" />
      <i className="c br" />
      <div className="edge-ticks left" />
      <div className="edge-ticks right" />
      <div className="scanline" />
    </div>
  );
}

// Fixed HUD around the core: top bar, activity feed (left), systems (right).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { Activity, LunaState } from "../lib/state";
import { helperOf } from "../lib/state";
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

function argSummary(args: Record<string, unknown>): string {
  const preferred = ["task", "question", "path", "command", "query", "expression", "text"];
  for (const key of preferred) {
    if (typeof args[key] === "string") return String(args[key]);
  }
  const first = Object.values(args)[0];
  return first === undefined ? "" : typeof first === "string" ? first : JSON.stringify(first);
}

function label(a: Activity): string {
  const helper = helperOf(a.name);
  if (helper) return `DEPLOY ${codename(helper)}`;
  return a.name.replace(/_/g, " ").toUpperCase();
}

export function ActivityFeed({ activity }: { activity: Activity[] }) {
  return (
    <section className="panel activity">
      <div className="panel-title">
        <span>NEURAL ACTIVITY</span>
        <span className="panel-count">{String(activity.length).padStart(2, "0")}</span>
      </div>
      <ul>
        <AnimatePresence initial={false}>
          {activity.slice(0, 9).map((a) => (
            <motion.li
              key={a.id}
              layout
              initial={{ opacity: 0, x: -24, filter: "blur(4px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0 }}
              className={`act ${a.status} depth-${Math.min(a.depth, 2)}`}
            >
              <span className="act-status" />
              <div className="act-body">
                <div className="act-name">{label(a)}</div>
                <div className="act-arg">{a.status === "done" && a.preview ? `↳ ${a.preview}` : argSummary(a.args)}</div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
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

export function SystemPanel({ state, voiceLabel, onModelClick }: SystemProps) {
  const helpers = state.helpers.length ? state.helpers : [];
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
        <dd title={state.model}>{state.switching ? "RELINKING…" : (state.model?.split("/").pop()?.toUpperCase() ?? "—")}</dd>
        <dt>THREAD</dt>
        <dd title={state.threadId}>{state.threadId?.slice(0, 12).toUpperCase() ?? "—"}</dd>
        <dt>TOOLS</dt>
        <dd>{state.tools.length}</dd>
        <dt>OPS</dt>
        <dd>{state.ops}</dd>
        <dt>VOICE IN</dt>
        <dd className={voiceLabel === "TEXT ONLY" ? "warn" : "ok"}>{voiceLabel}</dd>
      </dl>
      <div className="panel-title small">
        <span>AGENTS</span>
      </div>
      <ul className="agents">
        <li className={`agent ${state.busy && state.activeHelpers.length === 0 ? "busy" : ""}`}>
          <span className="agent-led" />
          <span>LUNA</span>
          <span className="agent-role">CORE</span>
        </li>
        {helpers.map((h) => (
          <li key={h} className={`agent ${state.activeHelpers.includes(h) ? "busy" : ""}`}>
            <span className="agent-led" />
            <span>{codename(h)}</span>
            <span className="agent-role">{h.toUpperCase()}</span>
          </li>
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

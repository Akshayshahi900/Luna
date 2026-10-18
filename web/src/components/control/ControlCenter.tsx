// Control Center: an OS-style full-screen layer over the HUD (#/control,
// gear button, S key). Status bar on top, app launcher on the left, one
// app window. It talks to /api/control (lib/control.ts); the chat socket
// stays connected underneath.
import { AnimatePresence, motion } from "motion/react";
import { type ComponentType, type SVGProps, useCallback, useEffect, useState } from "react";
import {
  api,
  formatBytes,
  formatDuration,
  type DashboardPrefs,
  type Insights,
  type Routine,
  type SaveResult,
  type SettingsSchema,
  type Stats,
} from "../../lib/control";
import {
  ChipIcon,
  ClockIcon,
  CloseIcon,
  GlobeIcon,
  GridIcon,
  KeyIcon,
  LayoutIcon,
  ListIcon,
  PlugIcon,
  ShieldIcon,
  SlidersIcon,
} from "../icons";
import { Accounts } from "./Accounts";
import { Connectors } from "./Connectors";
import { Models } from "./Models";
import { Overview } from "./Overview";
import { Permissions } from "./Permissions";
import { Routines } from "./Routines";
import { Advanced, Dashboard, General, Network } from "./SystemApps";

export type AppId =
  | "overview"
  | "models"
  | "connectors"
  | "accounts"
  | "permissions"
  | "routines"
  | "dashboard"
  | "network"
  | "general"
  | "advanced";

const APPS: { id: AppId; label: string; title: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "overview", label: "Overview", title: "System overview", Icon: GridIcon },
  { id: "models", label: "Models", title: "Model providers", Icon: ChipIcon },
  { id: "connectors", label: "Connectors", title: "MCP connectors", Icon: PlugIcon },
  { id: "accounts", label: "Logins", title: "Accounts & keys", Icon: KeyIcon },
  { id: "permissions", label: "Permissions", title: "Permissions", Icon: ShieldIcon },
  { id: "routines", label: "Routines", title: "Routines", Icon: ClockIcon },
  { id: "dashboard", label: "Dashboard", title: "Dashboard", Icon: LayoutIcon },
  { id: "network", label: "Gateway", title: "Gateway & network", Icon: GlobeIcon },
  { id: "general", label: "General", title: "General", Icon: SlidersIcon },
  { id: "advanced", label: "All settings", title: "All settings", Icon: ListIcon },
];

export const APP_IDS = APPS.map((a) => a.id);

const STATS_EVERY_MS = 5000;
const CPU_HISTORY = 60;

interface Props {
  open: boolean;
  app: AppId;
  onApp: (app: AppId) => void;
  onClose: () => void;
  connected: boolean;
  /** bumps when a routine finished or settings changed (from the socket) */
  signal: number;
  prefs: DashboardPrefs | null;
  onPrefs: (p: DashboardPrefs) => void;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="cc-clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>;
}

export function ControlCenter(p: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [cpu, setCpu] = useState<number[]>([]);
  const [schema, setSchema] = useState<SettingsSchema | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState<string>();

  const loadSchema = useCallback(() => api.settings().then(setSchema, (e) => setError(e.message)), []);

  // Live stats while open.
  useEffect(() => {
    if (!p.open) return;
    let alive = true;
    const tick = () =>
      api.stats().then(
        (s) => {
          if (!alive) return;
          setStats(s);
          setCpu((c) => [...c, s.process.cpu_percent].slice(-CPU_HISTORY));
          setError(undefined);
        },
        (e) => alive && setError(e.message),
      );
    void tick();
    const t = setInterval(tick, STATS_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [p.open]);

  // Settings, insights and routines: on open and whenever the server says something changed.
  useEffect(() => {
    if (!p.open) return;
    void loadSchema();
    api.insights().then(setInsights, () => undefined);
    api.routines().then((r) => setRoutines(r.routines), () => undefined);
  }, [p.open, p.signal, loadSchema]);

  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select")) return (target as HTMLInputElement).blur();
      p.onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [p.open, p.onClose]);

  const onSaved = useCallback((r: SaveResult) => {
    setSchema(r);
  }, []);

  const current = APPS.find((a) => a.id === p.app) ?? APPS[0];
  const restart = schema?.restart_required ?? stats?.restart_required ?? [];

  const body = (() => {
    switch (current.id) {
      case "overview":
        return <Overview stats={stats} cpu={cpu} insights={insights} routines={routines} onOpen={(a) => p.onApp(a as AppId)} />;
      case "models":
        return <Models schema={schema} onSaved={onSaved} />;
      case "connectors":
        return <Connectors schema={schema} onSaved={onSaved} />;
      case "accounts":
        return <Accounts schema={schema} onSaved={onSaved} />;
      case "permissions":
        return <Permissions schema={schema} onSaved={onSaved} />;
      case "routines":
        return <Routines signal={p.signal} />;
      case "dashboard":
        return <Dashboard prefs={p.prefs} onChange={p.onPrefs} />;
      case "network":
        return <Network schema={schema} onSaved={onSaved} />;
      case "general":
        return <General schema={schema} onSaved={onSaved} />;
      case "advanced":
        return <Advanced schema={schema} onSaved={onSaved} />;
    }
  })();

  return (
    <AnimatePresence>
      {p.open && (
        <motion.div
          className="cc"
          role="dialog"
          aria-label="Luna Control Center"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <header className="cc-bar">
            <span className="cc-logo">
              LUNA<b>OS</b>
            </span>
            <span className="cc-bar-title">{current.title}</span>
            <span className="cc-spacer" />
            <span className={`cc-pill ${p.connected ? "ok" : "bad"}`} title="Chat socket">
              <i className="dot" /> {p.connected ? "LINK" : "OFFLINE"}
            </span>
            {stats && (
              <>
                <span className="cc-pill" title="Model in use">
                  {stats.model.provider} · <span className="mono">{stats.model.model.split("/").pop()}</span>
                </span>
                <span className="cc-pill" title="Luna process CPU / RAM">
                  CPU {stats.process.cpu_percent.toFixed(0)}% · {formatBytes(stats.process.rss)}
                </span>
                <span className="cc-pill" title="Uptime">
                  UP {formatDuration(stats.uptime)}
                </span>
                {stats.routines.running.length > 0 && <span className="cc-pill busy">ROUTINE RUNNING</span>}
              </>
            )}
            <Clock />
            <button className="cc-close" onClick={p.onClose} title="Back to Luna (Esc)">
              <CloseIcon width={18} height={18} />
            </button>
          </header>

          <nav className="cc-dock" aria-label="Control Center apps">
            {APPS.map(({ id, label, Icon }) => (
              <button key={id} className={id === current.id ? "on" : ""} onClick={() => p.onApp(id)} title={label}>
                <Icon />
                <span>{label}</span>
                {id === "overview" && restart.length > 0 && <b className="cc-dot-badge" />}
              </button>
            ))}
          </nav>

          <main className="cc-window">
            {restart.length > 0 && (
              <div className="cc-banner">
                Restart luna-web to apply: {restart.join(", ")}.
                <small> (Ctrl+C in its terminal, then <code>uv run luna-web</code>)</small>
              </div>
            )}
            {error && <div className="cc-banner bad">Can't reach the Control API: {error}</div>}
            <motion.div key={current.id} className="cc-app" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
              {body}
            </motion.div>
          </main>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// The simpler Control Center apps: HUD dashboard preferences, web server
// & network, general (persona, memory, voice, routines) and the full
// searchable settings list.
import { useEffect, useState } from "react";
import {
  api,
  findField,
  isLoopback,
  searchFields,
  type DashboardPrefs,
  type SaveResult,
  type SettingsSchema,
} from "../../lib/control";
import { SettingsForm, Toggle } from "./SettingsForm";

interface FormProps {
  schema: SettingsSchema | null;
  onSaved: (r: SaveResult) => void;
}

const group = (schema: SettingsSchema | null, id: string) => schema?.groups.find((g) => g.id === id)?.fields ?? [];

// --- Dashboard -------------------------------------------------------------------

const WIDGETS: [keyof DashboardPrefs["widgets"], string, string][] = [
  ["mail", "Mail", "Unread count and the newest sender (Check email routine)"],
  ["agenda", "Calendar", "Today's events and the next one (Today's agenda routine)"],
  ["todos", "To-dos", "Open, due today and overdue (To-dos routine)"],
  ["stats", "Luna stats", "Model calls today and memory count"],
];

export function Dashboard({ prefs, onChange }: { prefs: DashboardPrefs | null; onChange: (p: DashboardPrefs) => void }) {
  const [error, setError] = useState<string>();
  const save = async (patch: Partial<DashboardPrefs>) => {
    try {
      onChange(await api.saveDashboard(patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!prefs) return <p className="cc-empty">Loading…</p>;
  return (
    <div className="cc-stack">
      <section className="cc-card">
        <h3>HUD widgets</h3>
        <p className="cc-help">Small cards on the voice screen. Each one needs its routine switched on (Routines).</p>
        <ul className="cc-list">
          {WIDGETS.map(([key, label, help]) => (
            <li key={key} className="cc-item row">
              <Toggle on={prefs.widgets[key]} onChange={(v) => save({ widgets: { ...prefs.widgets, [key]: v } })} label={label} />
              <b>{label}</b>
              <span className="cc-help">{help}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="cc-card">
        <h3>Look</h3>
        <div className="cc-field">
          <label>Position</label>
          <div className="cc-seg">
            {(["bottom-left", "bottom-right"] as const).map((p) => (
              <button key={p} className={prefs.position === p ? "on" : ""} onClick={() => save({ position: p })}>
                {p.replace("-", " ")}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-field">
          <label>Style</label>
          <div className="cc-seg">
            {(["compact", "minimal"] as const).map((s) => (
              <button key={s} className={prefs.style === s ? "on" : ""} onClick={() => save({ style: s })}>
                {s}
              </button>
            ))}
          </div>
          <p className="cc-help">Compact shows a detail line; minimal shows one line per widget.</p>
        </div>
        <div className="cc-field">
          <label>Opacity · {Math.round(prefs.opacity * 100)}%</label>
          <input
            type="range"
            min={30}
            max={100}
            value={Math.round(prefs.opacity * 100)}
            onChange={(e) => onChange({ ...prefs, opacity: Number(e.target.value) / 100 })}
            onPointerUp={(e) => save({ opacity: Number((e.target as HTMLInputElement).value) / 100 })}
            onKeyUp={(e) => save({ opacity: Number((e.target as HTMLInputElement).value) / 100 })}
          />
        </div>
        <div className="cc-field row">
          <Toggle on={prefs.show_hints} onChange={(v) => save({ show_hints: v })} label="Keyboard hints" />
          <label>Show the keyboard hint line under the dock</label>
        </div>
        {error && <p className="cc-error">{error}</p>}
      </section>
    </div>
  );
}

// --- Network ---------------------------------------------------------------------

export function Network({ schema, onSaved }: FormProps) {
  const [health, setHealth] = useState<string>("checking…");
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setHealth(`${h.status} · ${h.provider} / ${h.model}`))
      .catch(() => setHealth("unreachable"));
  }, []);
  const host = findField(schema, "web_host");
  const exposed = host && typeof host.value === "string" && !isLoopback(host.value);
  return (
    <div className="cc-stack">
      <section className="cc-card">
        <h3>Gateway</h3>
        <dl className="cc-dl">
          <dt>This page</dt>
          <dd>
            <code>{location.origin}</code>
          </dd>
          <dt>WebSocket</dt>
          <dd>
            <code>{location.origin.replace(/^http/, "ws")}/ws</code>
          </dd>
          <dt>Health</dt>
          <dd>{health}</dd>
        </dl>
        {exposed && (
          <p className="cc-help bad">
            Luna listens on {String(host!.value)}, not only this computer. Anyone on the network who can reach it could run
            tools. Keep it on 127.0.0.1 unless you know you need otherwise.
          </p>
        )}
      </section>
      <section className="cc-card">
        <h3>Web server</h3>
        <SettingsForm fields={group(schema, "network")} onSaved={onSaved} />
      </section>
    </div>
  );
}

// --- General -----------------------------------------------------------------------

const GENERAL: [string, string, string][] = [
  ["persona", "Persona", "How Luna talks and who she talks to."],
  ["memory", "Memory", "Conversation storage, summarizing, and long-term memory."],
  ["voice", "Voice", "Speech output (Piper) and input (Whisper)."],
  ["routines", "Routines", "The scheduler and where routines are stored."],
  ["messaging", "Messaging", "Use Luna from Telegram: text, voice notes, photos, files and approvals (docs/messaging.md)."],
];

export function General({ schema, onSaved }: FormProps) {
  const [tab, setTab] = useState("persona");
  const current = GENERAL.find(([id]) => id === tab)!;
  return (
    <div className="cc-stack">
      <div className="cc-tabs">
        {GENERAL.map(([id, title]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {title}
          </button>
        ))}
      </div>
      <section className="cc-card">
        <h3>{current[1]}</h3>
        <p className="cc-help">{current[2]}</p>
        <SettingsForm fields={group(schema, tab)} onSaved={onSaved} />
      </section>
    </div>
  );
}

// --- Advanced ------------------------------------------------------------------------

export function Advanced({ schema, onSaved }: FormProps) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  if (!schema) return <p className="cc-empty">Loading…</p>;
  const groups = searchFields(schema.groups, query);
  const removeUnknown = async () => {
    try {
      onSaved(await api.saveSettings({}, schema.unknown));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="cc-stack">
      <section className="cc-card">
        <div className="cc-row">
          <input
            className="cc-input grow"
            autoFocus
            placeholder="Search every setting (name, LUNA_ key or description)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <p className="cc-help">
          Saved to <code>{schema.env_path}</code>. Comments and other lines in the file are kept.
        </p>
        {schema.unknown.length > 0 && (
          <p className="cc-help warn">
            Luna no longer reads: {schema.unknown.join(", ")}.{" "}
            <button className="cc-link" onClick={removeUnknown}>
              remove from .env
            </button>
          </p>
        )}
        {error && <p className="cc-error">{error}</p>}
      </section>
      {groups.map((g) => (
        <section key={g.id} className="cc-card">
          <h3>{g.title}</h3>
          <SettingsForm fields={g.fields} onSaved={onSaved} compact />
        </section>
      ))}
      {!groups.length && <p className="cc-empty">No setting matches “{query}”.</p>}
    </div>
  );
}

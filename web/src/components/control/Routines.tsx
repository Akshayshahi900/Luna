// Routines: scheduled jobs. Built-ins (mail / agenda / to-dos) read data
// without the LLM and feed the HUD widgets; agent routines run a prompt on
// a cron schedule (each run uses model calls).
import { useEffect, useState } from "react";
import { ago } from "../../lib/time";
import { api, until, type CronCheck, type Routine, type RoutineList, type RoutineRun } from "../../lib/control";
import { Toggle } from "./SettingsForm";

const PRESETS: [string, string][] = [
  ["*/15 * * * *", "Every 15 min"],
  ["0 * * * *", "Hourly"],
  ["0 8 * * *", "Daily 08:00"],
  ["0 9 * * 1-5", "Weekdays 09:00"],
  ["0 18 * * 0", "Sundays 18:00"],
];

/** Schedule input with presets and a live check from the server. */
function CronInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [check, setCheck] = useState<CronCheck>();
  useEffect(() => {
    if (!value.trim()) return setCheck(undefined);
    const t = setTimeout(() => api.cron(value).then(setCheck, () => setCheck(undefined)), 300);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <div className="cc-cron">
      <div className="cc-row">
        <input className="cc-input mono grow" value={value} onChange={(e) => onChange(e.target.value)} placeholder="min hour day month weekday" />
        <select className="cc-input small" value="" onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">Presets…</option>
          {PRESETS.map(([expr, label]) => (
            <option key={expr} value={expr}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {check && (
        <p className={`cc-help ${check.valid ? "" : "bad"}`}>
          {check.valid
            ? `${check.text} · next ${check.next?.map((n) => n.replace("T", " ").slice(5, 16)).join(", ")}`
            : check.error}
        </p>
      )}
    </div>
  );
}

function RunList({ runs }: { runs: RoutineRun[] }) {
  if (!runs.length) return <p className="cc-empty">No runs yet.</p>;
  return (
    <ul className="cc-runs">
      {runs.map((r) => (
        <li key={r.id} className={r.status}>
          <span className={`cc-status ${r.status === "ok" ? "ok" : r.status === "error" ? "error" : "off"}`}>{r.status}</span>
          <small>{ago(r.finished_at ?? r.started_at)}</small>
          <p>{r.summary || r.error}</p>
          {r.data?.rejected?.length > 0 && <small className="warn">refused (needs approval): {r.data.rejected.join(", ")}</small>}
        </li>
      ))}
    </ul>
  );
}

function RoutineForm(p: {
  initial?: Routine;
  onSubmit: (v: { name: string; prompt: string; cron: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(p.initial?.name ?? "");
  const [prompt, setPrompt] = useState(p.initial?.prompt ?? "");
  const [cron, setCron] = useState(p.initial?.cron ?? "0 8 * * *");
  const [error, setError] = useState<string>();
  const agent = !p.initial || p.initial.kind === "agent";
  return (
    <form
      className="cc-subform"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        try {
          await p.onSubmit({ name, prompt, cron });
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input className="cc-input" placeholder="Name, e.g. Morning brief" value={name} onChange={(e) => setName(e.target.value)} required />
      {agent && (
        <textarea
          className="cc-input"
          rows={3}
          placeholder="What should Luna do? e.g. Summarize my unread mail and today's calendar in three bullet points."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
      )}
      <CronInput value={cron} onChange={setCron} />
      {agent && (
        <p className="cc-help warn">
          Runs on the agent: each run uses model calls (up to the task budget). Risky tools are refused unless auto-approved.
        </p>
      )}
      {error && <p className="cc-error">{error}</p>}
      <div className="cc-row end">
        <button type="button" className="cc-btn ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button className="cc-btn primary">{p.initial ? "Save" : "Create routine"}</button>
      </div>
    </form>
  );
}

interface Props {
  /** bumps when a routine_result arrives */
  signal: number;
}

export function Routines({ signal }: Props) {
  const [data, setData] = useState<RoutineList | null>(null);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [history, setHistory] = useState<{ id: number; runs: RoutineRun[] } | null>(null);
  const [running, setRunning] = useState<Set<number>>(new Set());

  useEffect(() => {
    api.routines().then(setData, (e) => setError(e.message));
  }, [signal]);

  const act = async (fn: () => Promise<RoutineList>) => {
    setError(undefined);
    try {
      setData(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runNow = async (r: Routine) => {
    setRunning((s) => new Set(s).add(r.id));
    await act(async () => {
      const res = await api.runRoutine(r.id);
      if (history?.id === r.id) setHistory({ id: r.id, runs: [res.run, ...history.runs] });
      return res;
    });
    setRunning((s) => {
      const n = new Set(s);
      n.delete(r.id);
      return n;
    });
  };

  const showHistory = async (r: Routine) => {
    if (history?.id === r.id) return setHistory(null);
    const res = await api.routineRuns(r.id);
    setHistory({ id: r.id, runs: res.runs });
  };

  const row = (r: Routine) => {
    const last = r.last_run;
    const isRunning = r.running || running.has(r.id);
    return (
      <li key={r.id} className={`cc-item ${r.enabled ? "" : "off"}`}>
        <div className="cc-item-main">
          <Toggle on={r.enabled} onChange={(v) => act(() => api.updateRoutine(r.id, { enabled: v }))} label={`Enable ${r.name}`} />
          <b>{r.name}</b>
          {r.kind === "agent" ? <span className="cc-badge llm">USES LLM</span> : <span className="cc-badge">NO LLM</span>}
          <span className="cc-help">{r.schedule}</span>
          {r.enabled && r.next_run_at && <small>next {until(r.next_run_at)}</small>}
          <span className="cc-spacer" />
          <button className="cc-link" disabled={isRunning} onClick={() => runNow(r)}>
            {isRunning ? "running…" : "run now"}
          </button>
          <button className="cc-link" onClick={() => showHistory(r)}>
            history
          </button>
          <button className="cc-link" onClick={() => setEditing(editing === r.id ? null : r.id)}>
            edit
          </button>
          {r.kind === "agent" && (
            <button className="cc-link bad" onClick={() => confirm(`Delete “${r.name}” and its history?`) && act(() => api.deleteRoutine(r.id))}>
              delete
            </button>
          )}
        </div>
        {r.kind === "builtin" && data?.builtins[r.builtin ?? ""] && <p className="cc-help">{data.builtins[r.builtin!].description}</p>}
        {r.kind === "agent" && <p className="cc-prompt">“{r.prompt}”</p>}
        {last && (
          <p className={`cc-last ${last.status}`}>
            <span className={`dot ${last.status === "ok" ? "ok" : last.status === "error" ? "bad" : "warn"}`} />
            {last.summary || last.error} <small>· {ago(last.finished_at ?? last.started_at)}</small>
          </p>
        )}
        {editing === r.id && (
          <RoutineForm
            initial={r}
            onSubmit={async (v) => {
              setData(await api.updateRoutine(r.id, r.kind === "agent" ? v : { name: v.name, cron: v.cron }));
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}
        {history?.id === r.id && <RunList runs={history.runs} />}
      </li>
    );
  };

  const builtins = data?.routines.filter((r) => r.kind === "builtin") ?? [];
  const agents = data?.routines.filter((r) => r.kind === "agent") ?? [];

  return (
    <div className="cc-stack">
      {error && <p className="cc-error">{error}</p>}
      {data && !data.scheduler && <p className="cc-help warn">The scheduler isn't running: routines only run with “run now”.</p>}
      <section className="cc-card">
        <div className="cc-card-head">
          <h3>Insights</h3>
          <span className="cc-help">quick checks that call one read-only tool · times in {data?.timezone}</span>
        </div>
        <ul className="cc-list">{builtins.map(row)}</ul>
      </section>
      <section className="cc-card">
        <div className="cc-card-head">
          <h3>Agent routines</h3>
          <span className="cc-spacer" />
          <button className="cc-btn primary small" onClick={() => setEditing("new")} disabled={editing === "new"}>
            + New routine
          </button>
        </div>
        {editing === "new" && (
          <RoutineForm
            onSubmit={async (v) => {
              setData(await api.createRoutine({ ...v, enabled: true }));
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}
        <ul className="cc-list">{agents.map(row)}</ul>
        {data && !agents.length && editing !== "new" && (
          <p className="cc-empty">No agent routines yet. Try “Every weekday at 08:00, summarize my unread mail and today's agenda.”</p>
        )}
      </section>
    </div>
  );
}

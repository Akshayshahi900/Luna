// Overview: live tiles for the whole system (polled from /api/control/stats
// by the Control Center every few seconds) plus the routine insights.
import type { ReactNode } from "react";
import { ago } from "../../lib/time";
import {
  formatBytes,
  formatDuration,
  insightLine,
  sparkPath,
  until,
  type Insights,
  type Routine,
  type Stats,
} from "../../lib/control";

function Spark({ values, width = 160, height = 36, label }: { values: number[]; width?: number; height?: number; label: string }) {
  const d = sparkPath(values, width, height);
  const last = values.length ? values[values.length - 1] : 0;
  return (
    <svg className="cc-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}</title>
      {d && <path d={`${d} L${width - 2} ${height - 2} L2 ${height - 2} Z`} className="area" />}
      {d && <path d={d} className="line" />}
      {values.length > 0 && <text x={width - 2} y={10} textAnchor="end">{last}</text>}
    </svg>
  );
}

function Meter({ value, max, label, detail }: { value: number; max: number; label: string; detail: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="cc-meter">
      <div className="cc-meter-head">
        <span>{label}</span>
        <b>{detail}</b>
      </div>
      <div className="cc-meter-bar" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${pct}%` }} className={pct > 85 ? "hot" : ""} />
      </div>
    </div>
  );
}

function Tile(p: { title: string; children: ReactNode; wide?: boolean; onOpen?: () => void; action?: string }) {
  return (
    <section className={`cc-tile ${p.wide ? "wide" : ""}`}>
      <header>
        <h3>{p.title}</h3>
        {p.onOpen && (
          <button className="cc-link" onClick={p.onOpen}>
            {p.action ?? "open"} →
          </button>
        )}
      </header>
      {p.children}
    </section>
  );
}

function Num({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="cc-num">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

const STATUS_DOT: Record<string, string> = { ok: "ok", error: "bad", skipped: "warn", running: "busy" };

interface Props {
  stats: Stats | null;
  cpu: number[];
  insights: Insights | null;
  routines: Routine[];
  onOpen: (app: string) => void;
}

export function Overview({ stats, cpu, insights, routines, onOpen }: Props) {
  if (!stats) return <p className="cc-empty">Reading system state…</p>;
  const memUsed = stats.system.mem_total && stats.system.mem_available !== null ? stats.system.mem_total - stats.system.mem_available : null;
  const days = stats.usage.days;
  const today = days[days.length - 1];
  const mem = stats.memory;
  const kinds = mem ? Object.entries(mem.by_kind) : [];
  const kindMax = Math.max(1, ...kinds.map(([, n]) => n));
  const nextUp = routines
    .filter((r) => r.enabled && r.next_run_at)
    .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))
    .slice(0, 3);

  return (
    <div className="cc-grid">
      <Tile title="Insights" wide onOpen={() => onOpen("routines")} action="routines">
        <div className="cc-insights">
          {(["mail_check", "agenda", "todos"] as const).map((key) => {
            const run = insights?.insights[key];
            const line = insightLine(key, run);
            const name = { mail_check: "MAIL", agenda: "CALENDAR", todos: "TO-DOS" }[key];
            return (
              <div key={key} className={`cc-insight ${line ? "" : "off"}`}>
                <span className="cc-kicker">{name}</span>
                {line ? (
                  <>
                    <b>{line.title}</b>
                    <p>{line.detail || " "}</p>
                    <small>updated {ago(run!.finished_at ?? run!.started_at)}</small>
                  </>
                ) : (
                  <>
                    <b>—</b>
                    <p>Turn on the “{{ mail_check: "Check email", agenda: "Today's agenda", todos: "To-dos" }[key]}” routine to see this here.</p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Tile>

      <Tile title="System">
        <Meter value={stats.process.cpu_percent} max={100 * stats.system.cpus} label="Luna CPU" detail={`${stats.process.cpu_percent.toFixed(0)}%`} />
        <Spark values={cpu.map((v) => Math.round(v))} width={240} height={32} label="CPU over the last minutes" />
        {memUsed !== null && (
          <Meter value={memUsed} max={stats.system.mem_total!} label="System memory" detail={`${formatBytes(memUsed)} / ${formatBytes(stats.system.mem_total)}`} />
        )}
        <dl className="cc-dl">
          <dt>Luna RAM</dt>
          <dd>{formatBytes(stats.process.rss)}</dd>
          <dt>Uptime</dt>
          <dd>{formatDuration(stats.uptime)}</dd>
          <dt>Load</dt>
          <dd>{stats.system.load ? stats.system.load.join(" · ") : "—"}</dd>
          <dt>Open tabs</dt>
          <dd>{stats.tabs}</dd>
        </dl>
      </Tile>

      <Tile title="Model & API usage" onOpen={() => onOpen("models")}>
        <div className="cc-model">
          <span className="cc-kicker">{stats.model.provider}</span>
          <b title={stats.model.model}>{stats.model.model}</b>
        </div>
        <div className="cc-nums">
          <Num value={today?.model_calls ?? 0} label="model calls today" />
          <Num value={today?.tool_calls ?? 0} label="tool calls today" />
          <Num value={today?.errors ?? 0} label="errors today" />
        </div>
        <Spark values={days.map((d) => d.model_calls)} width={240} height={40} label="Model calls per day, last 14 days" />
        <p className="cc-help">14 days · {days.reduce((a, d) => a + d.model_calls, 0)} model calls · since start {stats.usage.since_start.model_calls}</p>
      </Tile>

      <Tile title="Memory">
        {mem ? (
          <>
            <div className="cc-nums">
              <Num value={mem.total} label="memories" />
              <Num value={mem.pinned} label="pinned" />
              <Num value={mem.pending} label="to review" />
            </div>
            <ul className="cc-bars">
              {kinds.map(([kind, n]) => (
                <li key={kind}>
                  <span>{kind}</span>
                  <i style={{ width: `${(n / kindMax) * 100}%` }} />
                  <b>{n}</b>
                </li>
              ))}
            </ul>
            <p className="cc-help">{mem.changes} changes logged · {formatBytes(stats.storage.longterm)} on disk</p>
          </>
        ) : (
          <p className="cc-empty">Long-term memory is off.</p>
        )}
      </Tile>

      <Tile title="Sessions">
        {stats.sessions ? (
          <>
            <div className="cc-nums">
              <Num value={stats.sessions.count} label="conversations" />
              <Num value={stats.sessions.turns} label="messages" />
              <Num value={stats.sessions.routine_threads} label="routine threads" />
            </div>
            <dl className="cc-dl">
              <dt>Last active</dt>
              <dd>{stats.sessions.last ? ago(stats.sessions.last) : "—"}</dd>
              <dt>Checkpoints</dt>
              <dd>{formatBytes(stats.storage.checkpoints)}</dd>
            </dl>
          </>
        ) : (
          <p className="cc-empty">Sessions aren't saved (memory backend).</p>
        )}
      </Tile>

      <Tile title="Tools & connectors" onOpen={() => onOpen("connectors")}>
        <div className="cc-nums">
          <Num value={stats.tools.main} label="main agent" />
          <Num value={stats.tools.mcp_tools} label="MCP tools" />
          <Num value={Object.keys(stats.helper_tools).length} label="helpers" />
        </div>
        <ul className="cc-chips">
          {Object.entries(stats.helper_tools).map(([h, n]) => (
            <li key={h}>
              {h} <b>{n}</b>
            </li>
          ))}
        </ul>
        {Object.entries(stats.tools.mcp_errors).map(([group, err]) => (
          <p key={group} className="cc-help bad">
            {group}: {err}
          </p>
        ))}
      </Tile>

      <Tile title="Routines" onOpen={() => onOpen("routines")}>
        <div className="cc-nums">
          <Num value={`${stats.routines.enabled}/${stats.routines.total}`} label="enabled" />
          <Num value={stats.routines.running.length} label="running" />
          <Num value={stats.routines.scheduler ? "ON" : "OFF"} label="scheduler" />
        </div>
        {nextUp.length > 0 && (
          <ul className="cc-timeline next">
            {nextUp.map((r) => (
              <li key={r.id}>
                <i className="dot idle" />
                <span>{r.name}</span>
                <small>{until(r.next_run_at)}</small>
              </li>
            ))}
          </ul>
        )}
        <ul className="cc-timeline">
          {stats.routines.recent.slice(0, 5).map((run) => (
            <li key={run.id} title={run.error ?? run.summary}>
              <i className={`dot ${STATUS_DOT[run.status] ?? ""}`} />
              <span>{run.name}</span>
              <small>{ago(run.finished_at ?? run.started_at)}</small>
            </li>
          ))}
          {!stats.routines.recent.length && <li className="cc-empty">No runs yet.</li>}
        </ul>
      </Tile>

      {stats.usage.models.length > 0 && (
        <Tile title="Usage by model · 14 days" wide>
          <table className="cc-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>Runs</th>
                <th>Model calls</th>
                <th>Tool calls</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {stats.usage.models.map((m) => (
                <tr key={`${m.provider}/${m.model}`}>
                  <td>{m.provider}</td>
                  <td className="mono">{m.model}</td>
                  <td>{m.runs}</td>
                  <td>{m.model_calls}</td>
                  <td>{m.tool_calls}</td>
                  <td className={m.errors ? "bad" : ""}>{m.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tile>
      )}
    </div>
  );
}

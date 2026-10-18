// MCP connectors: the servers in config/mcp_servers.json. Add, edit,
// switch off or remove one; changes load on the next luna-web start.
import { useEffect, useState } from "react";
import { api, type McpList, type McpServer, type SaveResult, type SettingsSchema } from "../../lib/control";
import { SettingsForm, Toggle } from "./SettingsForm";

const STATUS_TEXT: Record<McpServer["status"], string> = {
  ok: "connected",
  error: "failed",
  off: "off",
  restart: "restart to load",
};

interface Draft {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  agent: string;
  envKey: string;
  envValue: string;
}

const EMPTY: Draft = { name: "", type: "stdio", command: "uv", args: "run python servers/", url: "", agent: "", envKey: "", envValue: "" };

function toDraft(s: McpServer): Draft {
  return {
    name: s.name,
    type: s.url ? "http" : "stdio",
    command: s.command ?? "",
    args: s.args.join(" "),
    url: s.url ?? "",
    agent: s.agent ?? "",
    envKey: "",
    envValue: "",
  };
}

function ServerForm(p: { initial: Draft; helpers: string[]; isNew: boolean; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState(p.initial);
  const [error, setError] = useState<string>();
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <form
      className="cc-subform"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        try {
          await p.onSave(d);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="cc-row">
        <input className="cc-input" placeholder="name (e.g. github)" value={d.name} onChange={set("name")} disabled={!p.isNew} required />
        <select className="cc-input" value={d.type} onChange={set("type")}>
          <option value="stdio">stdio command</option>
          <option value="http">HTTP url</option>
        </select>
        <select className="cc-input" value={d.agent} onChange={set("agent")} title="Which agent gets these tools">
          <option value="">main agent</option>
          {p.helpers.map((h) => (
            <option key={h} value={h}>
              {h} helper
            </option>
          ))}
        </select>
      </div>
      {d.type === "stdio" ? (
        <div className="cc-row">
          <input className="cc-input" placeholder="command" value={d.command} onChange={set("command")} />
          <input className="cc-input grow mono" placeholder="arguments, space separated" value={d.args} onChange={set("args")} />
        </div>
      ) : (
        <input className="cc-input mono" placeholder="https://example.com/mcp" value={d.url} onChange={set("url")} />
      )}
      <div className="cc-row">
        <input className="cc-input" placeholder="env var (optional)" value={d.envKey} onChange={set("envKey")} />
        <input className="cc-input grow" type="password" placeholder="value" value={d.envValue} onChange={set("envValue")} />
      </div>
      {error && <p className="cc-error">{error}</p>}
      <div className="cc-row end">
        <button type="button" className="cc-btn ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button className="cc-btn primary">{p.isNew ? "Add server" : "Save"}</button>
      </div>
    </form>
  );
}

interface Props {
  schema: SettingsSchema | null;
  onSaved: (r: SaveResult) => void;
}

export function Connectors({ schema, onSaved }: Props) {
  const [data, setData] = useState<McpList | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // server name, or "" for new
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.mcp().then(setData, (e) => setError(e.message));
  }, []);

  const save = async (d: Draft, existing?: McpServer) => {
    const body =
      d.type === "stdio"
        ? { command: d.command.trim(), args: d.args.split(/\s+/).filter(Boolean) }
        : { url: d.url.trim() };
    const env = d.envKey.trim() ? { [d.envKey.trim()]: d.envValue } : undefined;
    setData(await api.saveMcp(d.name.trim(), { ...body, agent: d.agent || null, disabled: existing?.disabled ?? false, env }));
    setEditing(null);
  };

  const toggle = async (s: McpServer) => {
    try {
      setData(
        await api.saveMcp(s.name, {
          ...(s.url ? { url: s.url } : { command: s.command ?? "", args: s.args }),
          agent: s.agent,
          disabled: !s.disabled,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (s: McpServer) => {
    if (!confirm(`Remove the “${s.name}” connector from mcp_servers.json?`)) return;
    try {
      setData(await api.deleteMcp(s.name));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tools = schema?.groups.find((g) => g.id === "tools")?.fields ?? [];

  return (
    <div className="cc-stack">
      <section className="cc-card">
        <div className="cc-card-head">
          <h3>MCP servers</h3>
          <code className="cc-env">{data?.path}</code>
          <span className="cc-spacer" />
          <button className="cc-btn primary small" onClick={() => setEditing("")} disabled={editing === ""}>
            + Add
          </button>
        </div>
        {data?.error && <p className="cc-error">{data.error}</p>}
        {data && !data.enabled && <p className="cc-help warn">MCP tools are switched off (LUNA_ENABLE_MCP_TOOLS) — nothing below loads.</p>}
        {error && <p className="cc-error">{error}</p>}
        {editing === "" && data && (
          <ServerForm initial={EMPTY} helpers={data.helpers} isNew onSave={(d) => save(d)} onCancel={() => setEditing(null)} />
        )}
        <ul className="cc-list">
          {data?.servers.map((s) => (
            <li key={s.name} className={`cc-item ${s.disabled ? "off" : ""}`}>
              <div className="cc-item-main">
                <span className={`dot ${s.status === "ok" ? "ok" : s.status === "error" ? "bad" : s.status === "off" ? "" : "warn"}`} />
                <b>{s.name}</b>
                <span className="cc-badge">{s.agent ? `${s.agent} helper` : "main agent"}</span>
                <span className={`cc-status ${s.status}`}>{STATUS_TEXT[s.status]}</span>
                {s.status === "ok" && <small>{s.tools} tools in group</small>}
                <span className="cc-spacer" />
                <Toggle on={!s.disabled} onChange={() => toggle(s)} label={`Enable ${s.name}`} />
                <button className="cc-link" onClick={() => setEditing(editing === s.name ? null : s.name)}>
                  edit
                </button>
                <button className="cc-link bad" onClick={() => remove(s)}>
                  remove
                </button>
              </div>
              <code className="cc-cmd">{s.url ?? [s.command, ...s.args].join(" ")}</code>
              {s.env_keys.length > 0 && <small className="cc-help">env: {s.env_keys.join(", ")}</small>}
              {s.error && <p className="cc-help bad">{s.error}</p>}
              {editing === s.name && data && (
                <ServerForm initial={toDraft(s)} helpers={data.helpers} isNew={false} onSave={(d) => save(d, s)} onCancel={() => setEditing(null)} />
              )}
            </li>
          ))}
        </ul>
        <p className="cc-help">
          Tagged servers go to that helper (e.g. mail and calendar → assistant). Risky tool names (send, delete, create…) always ask
          first — see Permissions.
        </p>
      </section>
      <section className="cc-card">
        <h3>Tool switches</h3>
        <SettingsForm fields={tools} onSaved={onSaved} />
      </section>
    </div>
  );
}

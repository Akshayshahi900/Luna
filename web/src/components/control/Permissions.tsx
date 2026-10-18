// Permissions: which tools pause for your approval, which run without
// asking (LUNA_AUTO_APPROVE), and the folders the file / code helpers may use.
import { useEffect, useMemo, useState } from "react";
import { api, type Permissions as Perms, type SaveResult, type SettingsSchema } from "../../lib/control";
import { SettingsForm } from "./SettingsForm";

const MODE_TEXT = { ask: "asks first", auto: "runs without asking", free: "read-only" } as const;

interface Props {
  schema: SettingsSchema | null;
  onSaved: (r: SaveResult) => void;
}

export function Permissions({ schema, onSaved }: Props) {
  const [data, setData] = useState<Perms | null>(null);
  const [filter, setFilter] = useState("");
  const [onlyRisky, setOnlyRisky] = useState(true);
  const [error, setError] = useState<string>();

  const load = () => api.permissions().then(setData, (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const setAuto = async (tool: string, auto: boolean) => {
    if (!data) return;
    if (auto && !confirm(`Let “${tool}” run WITHOUT asking you first? Luna (and routines) could then use it on its own.`)) return;
    const next = auto ? [...new Set([...data.auto_approve, tool])] : data.auto_approve.filter((t) => t !== tool);
    try {
      onSaved(await api.saveSettings({ auto_approve: next }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const owners = useMemo(() => {
    const rows = (data?.tools ?? []).filter(
      (t) => (!onlyRisky || t.can_toggle) && t.name.toLowerCase().includes(filter.trim().toLowerCase()),
    );
    const map = new Map<string, typeof rows>();
    rows.forEach((t) => map.set(t.owner, [...(map.get(t.owner) ?? []), t]));
    return [...map.entries()];
  }, [data, filter, onlyRisky]);

  const sandbox = schema?.groups.find((g) => g.id === "permissions")?.fields.filter((f) => f.name === "workspace_dirs") ?? [];
  const asking = data?.tools.filter((t) => t.mode === "ask").length ?? 0;

  return (
    <div className="cc-stack">
      <section className="cc-card">
        <div className="cc-card-head">
          <h3>Tool approvals</h3>
          <span className="cc-help">
            {asking} ask first · {data?.auto_approve.length ?? 0} auto-approved
          </span>
        </div>
        <p className="cc-help">
          Tools that change things outside Luna (send, delete, write, run…) pause for your approval. Scheduled routines can't
          approve anything, so they only use tools you set to “runs without asking”.
        </p>
        <div className="cc-row">
          <input className="cc-input grow" placeholder="Filter tools…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="cc-check">
            <input type="checkbox" checked={onlyRisky} onChange={(e) => setOnlyRisky(e.target.checked)} /> only tools that can change things
          </label>
        </div>
        {error && <p className="cc-error">{error}</p>}
        {owners.map(([owner, tools]) => (
          <div key={owner} className="cc-perm-group">
            <h4>{owner === "main" ? "Main agent" : `${owner} helper`}</h4>
            <ul className="cc-list">
              {tools.map((t) => (
                <li key={`${owner}/${t.name}`} className="cc-item row">
                  <span className={`dot ${t.mode === "auto" ? "warn" : t.mode === "ask" ? "ok" : ""}`} />
                  <code>{t.name}</code>
                  <span className={`cc-status mode-${t.mode}`}>{MODE_TEXT[t.mode]}</span>
                  <span className="cc-spacer" />
                  {t.can_toggle && (
                    <select
                      className="cc-input small"
                      value={t.mode === "auto" ? "auto" : "ask"}
                      onChange={(e) => setAuto(t.name, e.target.value === "auto")}
                    >
                      <option value="ask">Ask me first</option>
                      <option value="auto">Run without asking</option>
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {data && !owners.length && <p className="cc-empty">No tools match.</p>}
      </section>

      <section className="cc-card">
        <h3>Workspace sandbox</h3>
        <p className="cc-help">The files and coder helpers can only read and write inside these folders.</p>
        <SettingsForm fields={sandbox} onSaved={(r) => (onSaved(r), void load())} compact />
      </section>
    </div>
  );
}

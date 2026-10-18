// Model providers: which one runs now, the saved default, API keys, and
// per-provider model settings and limits.
import { useEffect, useState } from "react";
import { api, type Providers, type SaveResult, type SettingsSchema } from "../../lib/control";
import { SettingsForm } from "./SettingsForm";

interface Props {
  schema: SettingsSchema | null;
  onSaved: (r: SaveResult) => void;
}

export function Models({ schema, onSaved }: Props) {
  const [data, setData] = useState<Providers | null>(null);
  const [picked, setPicked] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<Record<string, { list: string[]; error?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const load = () =>
    api.providers().then((d) => {
      setData(d);
      setPicked((p) => p || d.current.provider);
      setModel((m) => m || d.current.model);
    });
  useEffect(() => {
    void load().catch((e) => setMessage({ ok: false, text: e.message }));
  }, []);

  useEffect(() => {
    if (!picked || models[picked]) return;
    const info = data?.providers.find((p) => p.id === picked);
    if (!info?.configured) return;
    api
      .models(picked)
      .then((r) => setModels((m) => ({ ...m, [picked]: { list: r.models, error: r.error } })))
      .catch((e) => setModels((m) => ({ ...m, [picked]: { list: [], error: e.message } })));
  }, [picked, data, models]);

  const choose = (id: string) => {
    setPicked(id);
    const info = data?.providers.find((p) => p.id === id);
    setModel(id === data?.current.provider ? data.current.model : (info?.default_model ?? ""));
  };

  const save = async (apply: boolean) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setData(await api.setDefaultModel(picked, model.trim(), apply));
      setMessage({ ok: true, text: apply ? "Saved as default and switched for every tab." : "Saved as the startup default." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const group = (id: string) => schema?.groups.find((g) => g.id === id)?.fields ?? [];
  const info = data?.providers.find((p) => p.id === picked);
  const list = models[picked];

  return (
    <div className="cc-stack">
      <section className="cc-card">
        <h3>Providers</h3>
        <div className="cc-providers">
          {data?.providers.map((p) => (
            <button key={p.id} className={`cc-provider ${picked === p.id ? "picked" : ""}`} onClick={() => choose(p.id)}>
              <span className={`dot ${p.configured ? "ok" : "bad"}`} />
              <b>{p.label}</b>
              <small>{p.configured ? (p.key_env ? "key saved" : "local") : `needs ${p.key_env}`}</small>
              {data.current.provider === p.id && <em>IN USE</em>}
              {data.default.provider === p.id && <em className="alt">DEFAULT</em>}
            </button>
          ))}
        </div>
        {data && (
          <p className="cc-help">
            Running now: <b>{data.current.provider}</b> · <code>{data.current.model}</code>. Starts with:{" "}
            <b>{data.default.provider}</b> · <code>{data.default.model}</code>.
          </p>
        )}
        <div className="cc-row">
          <input
            className="cc-input grow"
            list="cc-model-list"
            value={model}
            placeholder={info?.default_model}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="cc-model-list">
            {list?.list.map((m) => <option key={m} value={m} />)}
          </datalist>
          <button className="cc-btn ghost" disabled={busy || !info?.configured} onClick={() => save(false)}>
            Save default
          </button>
          <button className="cc-btn primary" disabled={busy || !info?.configured || !data?.can_switch} onClick={() => save(true)}>
            Save & switch now
          </button>
        </div>
        {list?.error && <p className="cc-help warn">Couldn't list models: {list.error}</p>}
        {list && !list.error && <p className="cc-help">{list.list.length} models available — start typing to search.</p>}
        {message && <p className={message.ok ? "cc-ok" : "cc-error"}>{message.text}</p>}
      </section>

      <section className="cc-card">
        <h3>Keys & endpoints</h3>
        <SettingsForm fields={group("models").filter((f) => f.name !== "provider")} onSaved={onSaved} />
      </section>

      <section className="cc-card">
        <h3>Limits</h3>
        <p className="cc-help">Every model call is one API request; free tiers run out fast. These cap one message.</p>
        <SettingsForm fields={group("limits")} onSaved={onSaved} />
      </section>
    </div>
  );
}

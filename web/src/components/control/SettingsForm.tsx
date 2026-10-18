// A form for any list of settings, built from the server's schema
// (src/luna/config/schema.py): enum → select, bool → switch, number → number,
// list → comma text, secret → write-only password box. Save writes .env.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, fieldText, parseField, type Applies, type SaveResult, type SettingField } from "../../lib/control";

const APPLIES_LABEL: Record<Applies, string> = {
  live: "LIVE",
  rebuild: "INSTANT",
  restart: "RESTART",
};
const APPLIES_HINT: Record<Applies, string> = {
  live: "Read fresh on every use",
  rebuild: "Applied right away (the agent is rebuilt)",
  restart: "Applied after restarting luna-web",
};

/** "max_model_calls" → "Max model calls" */
export function humanize(name: string): string {
  const text = name.replace(/_/g, " ").replace(/\bapi\b/g, "API").replace(/\burl\b/g, "URL");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Draft = string | boolean | null;

interface Props {
  fields: SettingField[];
  onSaved: (result: SaveResult) => void;
  /** shown above the fields */
  intro?: ReactNode;
  compact?: boolean;
}

export function Toggle(p: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.on}
      aria-label={p.label}
      disabled={p.disabled}
      className={`cc-toggle ${p.on ? "on" : ""}`}
      onClick={() => p.onChange(!p.on)}
    >
      <span />
    </button>
  );
}

export function AppliesBadge({ applies }: { applies: Applies }) {
  return (
    <span className={`cc-badge applies-${applies}`} title={APPLIES_HINT[applies]}>
      {APPLIES_LABEL[applies]}
    </span>
  );
}

function FieldInput(p: { field: SettingField; draft: Draft | undefined; onChange: (v: Draft) => void }) {
  const { field } = p;
  const current = p.draft === undefined ? field.value : p.draft;
  if (field.kind === "bool") {
    return <Toggle on={Boolean(current)} onChange={p.onChange} label={field.name} />;
  }
  if (field.choices) {
    return (
      <select className="cc-input" value={String(current ?? "")} onChange={(e) => p.onChange(e.target.value)}>
        {field.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  }
  if (field.secret) {
    return (
      <input
        className="cc-input"
        type="password"
        autoComplete="off"
        placeholder={field.is_set ? "•••••••• saved — type to replace" : "not set"}
        value={typeof p.draft === "string" ? p.draft : ""}
        onChange={(e) => p.onChange(e.target.value)}
      />
    );
  }
  const text = typeof p.draft === "string" ? p.draft : p.draft === null ? "" : fieldText(field.value);
  if (field.name === "system_prompt") {
    return <textarea className="cc-input" rows={5} value={text} onChange={(e) => p.onChange(e.target.value)} />;
  }
  return (
    <input
      className="cc-input"
      type={field.kind === "int" || field.kind === "float" ? "number" : "text"}
      step={field.kind === "float" ? "0.05" : undefined}
      value={text}
      placeholder={p.draft === null ? `default: ${fieldText(field.default)}` : undefined}
      onChange={(e) => p.onChange(e.target.value)}
    />
  );
}

export function SettingsForm({ fields, onSaved, intro, compact }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();

  // Fresh values from the server replace the drafts.
  const key = useMemo(() => fields.map((f) => `${f.name}=${JSON.stringify(f.value)}:${f.is_set}`).join("|"), [fields]);
  useEffect(() => setDrafts({}), [key]);

  const dirty = Object.keys(drafts).filter((name) => {
    const f = fields.find((x) => x.name === name);
    if (!f) return false;
    const d = drafts[name];
    if (f.secret) return d === null || (typeof d === "string" && d.length > 0);
    if (d === null) return f.in_file;
    if (f.kind === "bool" || f.choices) return d !== f.value;
    return d !== fieldText(f.value);
  });

  const save = async () => {
    setError(undefined);
    setNotice(undefined);
    const values: Record<string, unknown> = {};
    try {
      for (const name of dirty) {
        const f = fields.find((x) => x.name === name)!;
        const d = drafts[name];
        values[name] = d === null || typeof d === "boolean" ? d : f.choices ? d : parseField(f.kind, d);
      }
    } catch (e) {
      return setError((e as Error).message);
    }
    setSaving(true);
    try {
      const result = await api.saveSettings(values);
      const restart = Object.values(result.effects).includes("restart");
      setNotice(result.rebuilt ? "Saved · agent rebuilt" : restart ? "Saved · restart luna-web to apply" : "Saved");
      onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`cc-form ${compact ? "compact" : ""}`}>
      {intro}
      {fields.map((f) => (
        <div key={f.name} className={`cc-field ${f.name in drafts && dirty.includes(f.name) ? "dirty" : ""}`}>
          <div className="cc-field-head">
            <label>{humanize(f.name)}</label>
            <AppliesBadge applies={f.applies} />
            <code className="cc-env">{f.env}</code>
            <span className="cc-spacer" />
            {(f.in_file || (f.secret && f.is_set)) && drafts[f.name] !== null && (
              <button
                type="button"
                className="cc-link"
                title={f.secret ? "Remove the saved value" : "Remove from .env (use the default)"}
                onClick={() => setDrafts({ ...drafts, [f.name]: null })}
              >
                {f.secret ? "clear" : "reset"}
              </button>
            )}
          </div>
          <FieldInput field={f} draft={drafts[f.name]} onChange={(v) => setDrafts({ ...drafts, [f.name]: v })} />
          {f.description && <p className="cc-help">{f.description}</p>}
          {drafts[f.name] === null && <p className="cc-help warn">Will be removed from .env (default: {fieldText(f.default) || "none"})</p>}
        </div>
      ))}
      <div className="cc-form-actions">
        {error && <span className="cc-error">{error}</span>}
        {notice && !error && <span className="cc-ok">{notice}</span>}
        <span className="cc-spacer" />
        <button type="button" className="cc-btn ghost" disabled={!dirty.length || saving} onClick={() => setDrafts({})}>
          Revert
        </button>
        <button type="button" className="cc-btn primary" disabled={!dirty.length || saving} onClick={save}>
          {saving ? "Saving…" : dirty.length ? `Save ${dirty.length}` : "Saved"}
        </button>
      </div>
    </div>
  );
}

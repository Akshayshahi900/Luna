// Logins: the Google sign-in (Gmail, Calendar, Tasks), the mail account and
// which API keys are saved.
import { useEffect, useState } from "react";
import { api, type Connections, type SaveResult, type SettingsSchema } from "../../lib/control";
import { SettingsForm } from "./SettingsForm";

interface Props {
  schema: SettingsSchema | null;
  onSaved: (r: SaveResult) => void;
}

export function Accounts({ schema, onSaved }: Props) {
  const [data, setData] = useState<Connections | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () => api.connections().then(setData, (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setData(await api.connectGoogle());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Sign out of Google? Mail (Gmail backend), calendar and to-do sync stop until you sign in again.")) return;
    setData(await api.disconnectGoogle());
  };

  const group = (id: string) => schema?.groups.find((g) => g.id === id)?.fields ?? [];
  const g = data?.google;

  return (
    <div className="cc-stack">
      <section className="cc-card">
        <div className="cc-card-head">
          <h3>Google</h3>
          <span className={`cc-status ${g?.ok ? "ok" : g?.token ? "error" : "off"}`}>
            {g?.ok ? "signed in" : g?.token ? "needs attention" : "not connected"}
          </span>
        </div>
        <p className="cc-help">Gmail, Google Calendar and Google Tasks sync with one sign-in. The token stays in data/google/ on this computer.</p>
        <ul className="cc-checks">
          <li className={g?.client_file ? "ok" : "bad"}>
            OAuth client file {g?.client_file ? "found" : "missing"} <code>{g?.client_path}</code>
          </li>
          <li className={g?.token ? "ok" : "bad"}>Sign-in token {g?.token ? "saved" : "not saved"}</li>
          {g?.error && <li className="bad">{g.error}</li>}
        </ul>
        <div className="cc-row">
          <button className="cc-btn primary" disabled={busy || !g?.client_file} onClick={connect}>
            {busy ? "Waiting for Google… (approve in the new browser tab)" : g?.token ? "Sign in again" : "Connect Google"}
          </button>
          {g?.token && (
            <button className="cc-btn ghost" onClick={disconnect}>
              Sign out
            </button>
          )}
        </div>
        {!g?.client_file && (
          <p className="cc-help">First download a “Desktop app” OAuth client from Google Cloud Console to the path above (docs/google.md).</p>
        )}
        {error && <p className="cc-error">{error}</p>}
        <details className="cc-details">
          <summary>Google settings</summary>
          <SettingsForm fields={group("google")} onSaved={(r) => (onSaved(r), void load())} compact />
        </details>
      </section>

      <section className="cc-card">
        <div className="cc-card-head">
          <h3>Mail</h3>
          <span className={`cc-status ${data?.mail.ready ? "ok" : "error"}`}>
            {data?.mail.ready ? "ready" : "not set up"} · {data?.mail.backend}
          </span>
        </div>
        <p className="cc-help">
          gmail = the Google sign-in above. imap = any provider with an app password (address + password below).
        </p>
        <SettingsForm fields={group("mail")} onSaved={(r) => (onSaved(r), void load())} compact />
      </section>

      <section className="cc-card">
        <h3>API keys</h3>
        <ul className="cc-checks">
          {data &&
            Object.entries(data.keys).map(([k, set]) => (
              <li key={k} className={set ? "ok" : "bad"}>
                {k} {set ? "saved" : "not set"}
              </li>
            ))}
        </ul>
        <SettingsForm
          fields={[...group("models"), ...group("tools")].filter((f) => f.secret)}
          onSaved={(r) => (onSaved(r), void load())}
          compact
        />
      </section>
    </div>
  );
}

// Small popover to pick the model provider (OpenRouter / Groq / Ollama) and
// model. Applying rebuilds the agent on the server for every open tab.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ProviderInfo } from "../lib/protocol";
import type { LunaState } from "../lib/state";

interface Props {
  open: boolean;
  state: LunaState;
  onFetch: (provider: string) => void;
  onApply: (provider: string, model: string) => void;
  onClose: () => void;
}

export function ModelSwitcher({ open, state, onFetch, onApply, onClose }: Props) {
  const [picked, setPicked] = useState(state.provider ?? "openrouter");
  const [model, setModel] = useState(state.model ?? "");

  const choose = (p: ProviderInfo) => {
    setPicked(p.id);
    setModel(p.id === state.provider ? (state.model ?? "") : p.default_model);
    if (p.configured && !state.models[p.id]) onFetch(p.id);
  };

  // Each time it opens: start from what's active and load that provider's list.
  useEffect(() => {
    if (!open) return;
    const current = state.providers.find((p) => p.id === state.provider);
    if (current) choose(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const info = state.providers.find((p) => p.id === picked);
  const list = state.models[picked];
  const unchanged = picked === state.provider && model.trim() === state.model;
  const canApply = state.canSwitch && !!info?.configured && !!model.trim() && !unchanged && !state.switching && !state.busy;

  return (
    <AnimatePresence>
      {open && (
        <>
          <div className="switcher-backdrop" onClick={onClose} />
          <motion.form
            className="switcher"
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (canApply) onApply(picked, model.trim());
            }}
          >
            <div className="panel-title">
              <span>NEURAL LINK</span>
              <span className="panel-count">{state.provider?.toUpperCase()}</span>
            </div>

            <div className="seg">
              {state.providers.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={p.id === picked ? "on" : ""}
                  disabled={!p.configured}
                  title={p.configured ? p.label : `${p.label}: add its API key to .env`}
                  onClick={() => choose(p)}
                >
                  {p.label.toUpperCase()}
                  {!p.configured && <small>NO KEY</small>}
                  {p.id === state.provider && <i className="seg-live" />}
                </button>
              ))}
            </div>

            <label className="switcher-label" htmlFor="model-input">
              MODEL
            </label>
            <input
              id="model-input"
              className="switcher-input"
              list={`models-${picked}`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={info?.default_model}
            />
            <datalist id={`models-${picked}`}>
              {list?.ids.map((id) => <option key={id} value={id} />)}
            </datalist>
            <div className={`switcher-hint ${list?.error ? "warn" : ""}`}>
              {!info?.configured
                ? "No API key configured"
                : !list
                  ? "Scanning models…"
                  : list.error
                    ? `Couldn't list models: ${list.error.slice(0, 90)}`
                    : `${list.ids.length} models available`}
            </div>

            <div className="switcher-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                CLOSE
              </button>
              <button type="submit" className="btn approve" disabled={!canApply}>
                {state.switching ? "LINKING…" : "ENGAGE"}
              </button>
            </div>
            {state.busy && <div className="switcher-hint">Wait for the current task to finish.</div>}
          </motion.form>
        </>
      )}
    </AnimatePresence>
  );
}

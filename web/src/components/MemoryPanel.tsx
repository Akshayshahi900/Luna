// Long-term memory editor, in a side drawer like the transcript.
// Inbox: Luna's suggestions (accept, edit then accept, decline).
// Saved: every memory (search, add, edit, pin, delete, history + undo).
// Only actions here change memories; Luna can only suggest.
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { ClientMessage, Memory, MemoryKind, MemorySuggestion } from "../lib/protocol";
import type { LunaState } from "../lib/state";
import { CloseIcon, PlusIcon } from "./icons";

const KINDS: MemoryKind[] = ["fact", "preference", "person", "project"];

interface Props {
  open: boolean;
  state: Pick<LunaState, "memories" | "suggestions" | "memoryHistory" | "memoryError">;
  send: (msg: ClientMessage) => boolean;
  onClose: () => void;
}

/** Text + kind form, shared by "add" and "edit". */
function MemoryForm(p: {
  initial?: { text: string; kind: MemoryKind };
  submitLabel: string;
  onSubmit: (text: string, kind: MemoryKind) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(p.initial?.text ?? "");
  const [kind, setKind] = useState<MemoryKind>(p.initial?.kind ?? "fact");
  return (
    <form
      className="mem-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) p.onSubmit(text.trim(), kind);
      }}
    >
      <textarea
        autoFocus
        rows={2}
        maxLength={300}
        value={text}
        placeholder="e.g. Prefers tea over coffee"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
          if (e.key === "Escape") p.onCancel();
        }}
      />
      <div className="mem-row">
        <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="mem-spacer" />
        <button type="button" className="mem-btn" onClick={p.onCancel}>
          CANCEL
        </button>
        <button type="submit" className="mem-btn primary" disabled={!text.trim()}>
          {p.submitLabel}
        </button>
      </div>
    </form>
  );
}

function SuggestionCard({ s, send }: { s: MemorySuggestion; send: Props["send"] }) {
  const [editing, setEditing] = useState(false);
  const verb = s.action === "add" ? `NEW ${s.kind.toUpperCase()}` : s.action === "update" ? `CHANGE m${s.target_id}` : `FORGET m${s.target_id}`;
  return (
    <li className={`mem-card suggestion ${s.action}`}>
      <div className="mem-meta">
        <span>{verb}</span>
        <span>s{s.id}</span>
      </div>
      {s.action !== "add" && <div className="mem-old">{s.target_text ?? "(memory no longer exists)"}</div>}
      {s.action !== "forget" &&
        (editing ? (
          <MemoryForm
            initial={{ text: s.text, kind: s.kind }}
            submitLabel="ACCEPT"
            onSubmit={(text) => send({ type: "suggestion_accept", id: s.id, text })}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="mem-text">{s.text}</div>
        ))}
      {s.reason && <div className="mem-reason">“{s.reason}”</div>}
      {!editing && (
        <div className="mem-row">
          <span className="mem-spacer" />
          <button className="mem-btn" onClick={() => send({ type: "suggestion_reject", id: s.id })}>
            DECLINE
          </button>
          {s.action !== "forget" && (
            <button className="mem-btn" onClick={() => setEditing(true)}>
              EDIT
            </button>
          )}
          <button className="mem-btn primary" onClick={() => send({ type: "suggestion_accept", id: s.id })}>
            ACCEPT
          </button>
        </div>
      )}
    </li>
  );
}

function MemoryCard({ m, history, send }: { m: Memory; history: Props["state"]["memoryHistory"]; send: Props["send"] }) {
  const [editing, setEditing] = useState(false);
  const showHistory = history?.id === m.id;
  if (editing) {
    return (
      <li className="mem-card">
        <MemoryForm
          initial={{ text: m.text, kind: m.kind }}
          submitLabel="SAVE"
          onSubmit={(text, kind) => {
            send({ type: "memory_save", id: m.id, text, kind, pinned: m.pinned });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }
  return (
    <li className={`mem-card ${m.pinned ? "pinned" : ""}`}>
      <div className="mem-meta">
        <span>
          {m.pinned ? "PINNED · " : ""}
          {m.kind.toUpperCase()}
        </span>
        <span>m{m.id}</span>
      </div>
      <div className="mem-text">{m.text}</div>
      <div className="mem-row">
        <button
          className="mem-btn"
          title="Pinned memories are shown to Luna in every message"
          onClick={() => send({ type: "memory_save", id: m.id, text: m.text, kind: m.kind, pinned: !m.pinned })}
        >
          {m.pinned ? "UNPIN" : "PIN"}
        </button>
        <button className="mem-btn" onClick={() => send({ type: "memory_history", id: m.id })}>
          HISTORY
        </button>
        <span className="mem-spacer" />
        <button className="mem-btn" onClick={() => setEditing(true)}>
          EDIT
        </button>
        <button className="mem-btn danger" onClick={() => send({ type: "memory_delete", id: m.id })}>
          DELETE
        </button>
      </div>
      {showHistory && (
        <div className="mem-history">
          {history.entries.map((h, i) => (
            <div key={i} className={h.undone ? "undone" : ""}>
              <span>{h.at.replace("T", " ").slice(0, 16)}</span> {h.action} · {h.after?.text ?? ""}
              <em> ({h.source})</em>
            </div>
          ))}
          <button className="mem-btn" onClick={() => send({ type: "memory_undo", id: m.id })}>
            UNDO LAST CHANGE
          </button>
        </div>
      )}
    </li>
  );
}

export function MemoryPanel(p: Props) {
  const [tab, setTab] = useState<"inbox" | "saved">("inbox");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  // Deleted memories are gone from the list, so undo for them lives here.
  const [lastDeleted, setLastDeleted] = useState<number | null>(null);
  const { memories, suggestions, memoryHistory, memoryError } = p.state;

  const send: Props["send"] = (msg) => {
    if (msg.type === "memory_delete") setLastDeleted(msg.id);
    else if (msg.type === "memory_undo" && msg.id === lastDeleted) setLastDeleted(null);
    return p.send(msg);
  };

  const q = query.trim().toLowerCase();
  const shown = q ? memories.filter((m) => m.text.toLowerCase().includes(q) || m.kind.includes(q)) : memories;

  return (
    <AnimatePresence>
      {p.open && (
        <motion.aside
          className="drawer memory"
          initial={{ x: "105%", opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "105%", opacity: 0.4 }}
          transition={{ type: "spring", stiffness: 220, damping: 28 }}
        >
          <header className="drawer-head">
            <div>
              <div className="panel-title">
                <span>LONG-TERM MEMORY</span>
              </div>
              <div className="mem-tabs">
                <button className={tab === "inbox" ? "current" : ""} onClick={() => setTab("inbox")}>
                  INBOX · {suggestions.length}
                </button>
                <button className={tab === "saved" ? "current" : ""} onClick={() => setTab("saved")}>
                  SAVED · {memories.length}
                </button>
              </div>
            </div>
            <div className="drawer-actions">
              <button
                className="icon-btn"
                title="Add a memory"
                onClick={() => {
                  setTab("saved");
                  setAdding(true);
                }}
              >
                <PlusIcon />
              </button>
              <button className="icon-btn" onClick={p.onClose} title="Close (Esc)">
                <CloseIcon />
              </button>
            </div>
          </header>

          {memoryError && <div className="mem-error">{memoryError}</div>}
          {lastDeleted !== null && (
            <div className="mem-undo">
              Deleted m{lastDeleted}.
              <button className="mem-btn" onClick={() => send({ type: "memory_undo", id: lastDeleted })}>
                UNDO
              </button>
            </div>
          )}

          <div className="drawer-list">
            {tab === "inbox" ? (
              <ul className="mem-list">
                {suggestions.length === 0 && (
                  <li className="muted center">No suggestions. Luna adds them here when she learns something lasting.</li>
                )}
                {suggestions.map((s) => (
                  <SuggestionCard key={s.id} s={s} send={send} />
                ))}
              </ul>
            ) : (
              <>
                <input
                  className="mem-search"
                  placeholder="Search memories…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <ul className="mem-list">
                  {adding && (
                    <li className="mem-card">
                      <MemoryForm
                        submitLabel="SAVE"
                        onSubmit={(text, kind) => {
                          send({ type: "memory_save", text, kind, pinned: false });
                          setAdding(false);
                        }}
                        onCancel={() => setAdding(false)}
                      />
                    </li>
                  )}
                  {shown.length === 0 && !adding && (
                    <li className="muted center">{q ? "No match." : "Nothing saved yet."}</li>
                  )}
                  {shown.map((m) => (
                    <MemoryCard key={m.id} m={m} history={memoryHistory} send={send} />
                  ))}
                </ul>
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

// The chat interface: full transcript plus a text box, in a side drawer.
// The header opens the session list: resume or delete saved conversations
// (every tab / reload starts a new session).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "../lib/protocol";
import type { ChatMessage } from "../lib/state";
import { ago } from "../lib/time";
import { CloseIcon, PlusIcon, SendIcon } from "./icons";

interface Props {
  open: boolean;
  messages: ChatMessage[];
  threadId?: string;
  sessions: SessionInfo[];
  busy: boolean;
  replyId?: string;
  onClose: () => void;
  onSend: (text: string) => void;
  onNewThread: () => void;
  onPickThread: (id: string) => void;
  onListSessions: () => void;
  onDeleteSession: (id: string) => void;
}


/** Minimal formatting: paragraphs, `code` and ``` blocks. No HTML injection. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          return <pre key={i}>{part.replace(/^```\w*\n?/, "").replace(/```$/, "")}</pre>;
        }
        return part
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((para, j) => (
            <p key={`${i}-${j}`}>
              {para.split(/(`[^`]+`)/g).map((seg, k) =>
                seg.startsWith("`") && seg.endsWith("`") ? <code key={k}>{seg.slice(1, -1)}</code> : seg,
              )}
            </p>
          ));
      })}
    </>
  );
}

export function ChatDrawer(p: Props) {
  const [text, setText] = useState("");
  const [picker, setPicker] = useState(false);
  // Delete needs a second click on the same row.
  const [confirm, setConfirm] = useState<string | null>(null);
  const saved = p.sessions.find((x) => x.id === p.threadId);
  const firstSaid = p.messages.find((m) => m.role === "user")?.text;
  const title = saved?.title ?? (firstSaid ? firstSaid.slice(0, 40) : "NEW SESSION");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (p.open) list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [p.messages, p.open]);

  return (
    <AnimatePresence>
      {p.open && (
        <motion.aside
          className="drawer"
          initial={{ x: "105%", opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "105%", opacity: 0.4 }}
          transition={{ type: "spring", stiffness: 220, damping: 28 }}
        >
          <header className="drawer-head">
            <div>
              <div className="panel-title">
                <span>TRANSCRIPT</span>
              </div>
              <button
                className="thread-btn"
                onClick={() => {
                  setPicker((v) => !v);
                  setConfirm(null);
                  p.onListSessions();
                }}
                title={`Saved sessions (current: ${p.threadId ?? "—"})`}
              >
                SESSION · {title} ▾
              </button>
            </div>
            <div className="drawer-actions">
              <button className="icon-btn" onClick={p.onNewThread} title="New session" disabled={p.busy}>
                <PlusIcon />
              </button>
              <button className="icon-btn" onClick={p.onClose} title="Close (Esc)">
                <CloseIcon />
              </button>
            </div>
          </header>

          <AnimatePresence>
            {picker && (
              <motion.ul
                className="thread-list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
              >
                {p.sessions.length === 0 && <li className="muted">No saved sessions yet</li>}
                {p.sessions.map((x) => (
                  <li key={x.id} className="session-row">
                    <button
                      className={`session-pick ${x.id === p.threadId ? "current" : ""}`}
                      disabled={p.busy}
                      title={x.id}
                      onClick={() => {
                        p.onPickThread(x.id);
                        setPicker(false);
                      }}
                    >
                      <span className="session-title">{x.title}</span>
                      <span className="session-meta">
                        {ago(x.updated_at)} · {x.turns} msg{x.turns === 1 ? "" : "s"}
                        {x.id === p.threadId ? " · OPEN" : ""}
                      </span>
                    </button>
                    <button
                      className={`session-del ${confirm === x.id ? "armed" : ""}`}
                      disabled={p.busy}
                      title="Delete this session (click twice)"
                      onClick={() => {
                        if (confirm !== x.id) return setConfirm(x.id);
                        setConfirm(null);
                        p.onDeleteSession(x.id);
                      }}
                    >
                      {confirm === x.id ? "DELETE?" : <CloseIcon width={14} height={14} />}
                    </button>
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>

          <div className="drawer-list" ref={list}>
            {p.messages.length === 0 && <div className="muted center">No transmissions yet.</div>}
            {p.messages.map((m) => (
              <motion.div
                key={m.id}
                className={`msg ${m.role}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="msg-who">{m.role === "user" ? "YOU" : m.role === "luna" ? "LUNA" : "SYSTEM"}</div>
                <div className="msg-body">
                  <Body text={m.text} />
                  {m.id === p.replyId && <span className="caret" />}
                </div>
              </motion.div>
            ))}
            {p.busy && !p.replyId && (
              <div className="msg luna thinking">
                <div className="msg-who">LUNA</div>
                <div className="dots">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            )}
          </div>

          <form
            className="drawer-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              p.onSend(text);
              setText("");
            }}
          >
            <textarea
              value={text}
              rows={1}
              placeholder="Message Luna…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
                if (e.key === "Escape") p.onClose();
              }}
            />
            <button type="submit" className="cmd-send" aria-label="Send" disabled={p.busy}>
              <SendIcon />
            </button>
          </form>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

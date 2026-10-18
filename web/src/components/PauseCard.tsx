// Shown when the agent pauses: an approval for a risky action, or a question.
// Can be answered by voice (handled in App) or with these controls.
import { motion } from "motion/react";
import { useState } from "react";
import type { Pause, PauseReply } from "../lib/protocol";

interface Props {
  pause: Pause;
  index: number;
  total: number;
  listening: boolean;
  voiceIn: boolean;
  onReply: (reply: PauseReply) => void;
}

function Approval({ pause, onReply }: { pause: Extract<Pause, { kind: "approval" }>; onReply: Props["onReply"] }) {
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [json, setJson] = useState(() =>
    JSON.stringify(pause.actions.length === 1 ? pause.actions[0].args : pause.actions.map((a) => a.args), null, 2),
  );
  const [jsonError, setJsonError] = useState("");
  const allowed = new Set(pause.actions.flatMap((a) => a.allowed));
  const canEdit = pause.actions.length === 1 && pause.actions[0].allowed.includes("edit");

  const submitEdit = () => {
    try {
      const args = JSON.parse(json);
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Arguments must be an object");
      onReply({ decisions: [{ type: "edit", args }] });
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  return (
    <>
      {pause.actions.map((a, i) => (
        <div className="pause-action" key={i}>
          <div className="pause-action-name">{a.name.replace(/_/g, " ").toUpperCase()}</div>
          {/* The default description repeats the tool name and args; the first line is enough. */}
          {a.description && <div className="pause-desc">{a.description.split("\n")[0]}</div>}
          {!editing && <pre className="pause-args">{JSON.stringify(a.args, null, 2)}</pre>}
        </div>
      ))}
      {editing && (
        <>
          <textarea className="pause-edit" value={json} onChange={(e) => setJson(e.target.value)} rows={8} spellCheck={false} />
          {jsonError && <div className="pause-error">{jsonError}</div>}
        </>
      )}
      {rejecting && (
        <input
          className="pause-input"
          autoFocus
          placeholder="Reason for Luna (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onReply({ decisions: [{ type: "reject", message: reason }] })}
        />
      )}
      <div className="pause-buttons">
        {editing ? (
          <>
            <button className="btn approve" onClick={submitEdit}>
              EXECUTE MODIFIED
            </button>
            <button className="btn ghost" onClick={() => setEditing(false)}>
              BACK
            </button>
          </>
        ) : rejecting ? (
          <>
            <button className="btn reject" onClick={() => onReply({ decisions: [{ type: "reject", message: reason }] })}>
              CONFIRM DENIAL
            </button>
            <button className="btn ghost" onClick={() => setRejecting(false)}>
              BACK
            </button>
          </>
        ) : (
          <>
            {allowed.has("approve") && (
              <button className="btn approve" onClick={() => onReply({ decisions: [{ type: "approve" }] })} autoFocus>
                AUTHORIZE
              </button>
            )}
            {canEdit && (
              <button className="btn ghost" onClick={() => setEditing(true)}>
                MODIFY
              </button>
            )}
            {allowed.has("reject") && (
              <button className="btn reject" onClick={() => setRejecting(true)}>
                DENY
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Question({ text, onReply }: { text: string; onReply: Props["onReply"] }) {
  const [answer, setAnswer] = useState("");
  return (
    <>
      <div className="pause-question">{text}</div>
      <form
        className="pause-buttons"
        onSubmit={(e) => {
          e.preventDefault();
          onReply({ answer });
        }}
      >
        <input className="pause-input" autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer…" />
        <button className="btn approve" type="submit">
          TRANSMIT
        </button>
      </form>
    </>
  );
}

export function PauseCard({ pause, index, total, listening, voiceIn, onReply }: Props) {
  const approval = pause.kind === "approval";
  return (
    <motion.div
      className={`pause ${approval ? "amber" : "query"}`}
      key={pause.id}
      initial={{ opacity: 0, scale: 0.9, rotateX: 20 }}
      animate={{ opacity: 1, scale: 1, rotateX: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 240, damping: 22 }}
    >
      <div className="pause-stripes" />
      <div className="pause-head">
        <span className="pause-title">{approval ? "AUTHORIZATION REQUIRED" : "LUNA REQUESTS INPUT"}</span>
        {total > 1 && (
          <span className="pause-count">
            {index + 1}/{total}
          </span>
        )}
      </div>
      {pause.kind === "approval" && <Approval pause={pause} onReply={onReply} />}
      {pause.kind === "question" && <Question text={pause.question} onReply={onReply} />}
      {pause.kind === "other" && <Question text={pause.text} onReply={onReply} />}
      {voiceIn && (
        <div className={`pause-voice ${listening ? "live" : ""}`}>
          {listening ? "● LISTENING — " : "SPACE TO SPEAK — "}
          {approval ? "say “approve” or “deny”" : "speak your answer"}
        </div>
      )}
    </motion.div>
  );
}

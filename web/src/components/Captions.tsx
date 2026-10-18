// Subtitles under the core: what you said and Luna's reply as it streams.
// Voice-first: only the tail of a long reply is shown; the transcript
// drawer has everything.
import { AnimatePresence, motion } from "motion/react";
import { cleanForSpeech } from "../lib/speech";

const TAIL = 280;

function tail(text: string): string {
  const clean = cleanForSpeech(text);
  if (clean.length <= TAIL) return clean;
  const cut = clean.slice(-TAIL);
  return "…" + cut.slice(cut.indexOf(" ") + 1);
}

interface Props {
  user?: string;
  luna?: string;
  interim?: string;
  notice?: string;
}

export function Captions({ user, luna, interim, notice }: Props) {
  const you = interim || user;
  return (
    <div className="captions" aria-live="polite">
      <AnimatePresence mode="popLayout">
        {you && (
          <motion.div
            key={"u" + (interim ? "live" : you)}
            className={`cap-user ${interim ? "live" : ""}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <span className="cap-tag">YOU</span>
            {you}
          </motion.div>
        )}
      </AnimatePresence>
      {luna && (
        <div className="cap-luna">
          <span className="cap-tag">LUNA</span>
          {tail(luna)}
          <span className="caret" />
        </div>
      )}
      {notice && <div className="cap-notice">⚠ {notice}</div>}
    </div>
  );
}

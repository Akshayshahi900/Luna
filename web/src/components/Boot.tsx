// Boot sequence. The ENGAGE click doubles as the user gesture browsers
// require before a page may use audio, speech or the microphone.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

interface Props {
  connected: boolean;
  voiceIn: boolean;
  voiceOut: boolean;
  onEngage: () => void;
}

export function Boot({ connected, voiceIn, voiceOut, onEngage }: Props) {
  const lines: [string, string, boolean][] = [
    ["CORE MATRIX", "STABLE", true],
    ["NEURAL MESH", "SYNCHRONIZED", true],
    ["VOICE SYNTHESIS", voiceOut ? "ONLINE" : "UNAVAILABLE", voiceOut],
    ["SPEECH RECOGNITION", voiceIn ? "ONLINE" : "TEXT FALLBACK", voiceIn],
    ["AGENT UPLINK", connected ? "ESTABLISHED" : "SEARCHING…", connected],
  ];
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= lines.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 320 + Math.random() * 260);
    return () => clearTimeout(t);
  }, [shown, lines.length]);

  const ready = shown >= lines.length;

  return (
    <motion.div className="boot" exit={{ opacity: 0, scale: 1.04, filter: "blur(8px)" }} transition={{ duration: 0.7 }}>
      <div className="boot-inner">
        <motion.div
          className="boot-title"
          initial={{ opacity: 0, letterSpacing: "1.4em" }}
          animate={{ opacity: 1, letterSpacing: "0.6em" }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        >
          L·U·N·A
        </motion.div>
        <div className="boot-sub">LOGICAL UNIFIED NEURAL ASSISTANT</div>
        <div className="boot-bar">
          <motion.div
            className="boot-bar-fill"
            animate={{ width: `${(shown / lines.length) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
        <ul className="boot-lines">
          <AnimatePresence>
            {lines.slice(0, shown).map(([name, status, ok]) => (
              <motion.li key={name} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}>
                <span>{name}</span>
                <span className="boot-dots" />
                <span className={ok ? "ok" : "warn"}>{status}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        <AnimatePresence>
          {ready && (
            <motion.button
              className="engage"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={onEngage}
              autoFocus
            >
              <span>ENGAGE</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

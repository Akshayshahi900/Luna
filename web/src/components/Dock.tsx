// Bottom controls: the big talk button plus a few toggles.
import { motion } from "motion/react";
import { CloseIcon, KeyboardIcon, LoopIcon, MicIcon, SpeakerIcon, TranscriptIcon } from "./icons";

interface Props {
  listening: boolean;
  voiceIn: boolean;
  handsFree: boolean;
  /** local speech recognition: hands-free means "Hey Luna" wake word */
  wakeWord: boolean;
  voiceOut: boolean;
  /** a task is running or waiting: show ABORT */
  canAbort: boolean;
  onTalk: () => void;
  onHandsFree: () => void;
  onVoiceOut: () => void;
  onKeyboard: () => void;
  onTranscript: () => void;
  onAbort: () => void;
}

export function Dock(p: Props) {
  return (
    <nav className="dock">
      <button className={`dock-btn ${p.voiceOut ? "on" : ""}`} onClick={p.onVoiceOut} title="Voice replies">
        <SpeakerIcon off={!p.voiceOut} />
        <span>VOICE</span>
      </button>
      <button
        className={`dock-btn ${p.handsFree ? "on" : ""}`}
        onClick={p.onHandsFree}
        disabled={!p.voiceIn}
        title={p.wakeWord ? "Hands-free: always listening for “Hey Luna”" : "Conversation mode: listen again after every reply"}
      >
        <LoopIcon />
        <span>{p.wakeWord ? "WAKE" : "CONVO"}</span>
      </button>

      <motion.button
        className={`talk ${p.listening ? "live" : ""}`}
        onClick={p.onTalk}
        whileTap={{ scale: 0.92 }}
        title={p.voiceIn ? "Talk (Space)" : "Type a command (Space)"}
      >
        <span className="talk-ring r1" />
        <span className="talk-ring r2" />
        <span className="talk-core">{p.voiceIn ? <MicIcon width={30} height={30} /> : <KeyboardIcon width={30} height={30} />}</span>
      </motion.button>

      {p.canAbort ? (
        <button className="dock-btn abort" onClick={p.onAbort} title="Cancel the current task (or say “Luna, cancel”)">
          <CloseIcon />
          <span>ABORT</span>
        </button>
      ) : (
        <button className="dock-btn" onClick={p.onKeyboard} title="Type a command (/)">
          <KeyboardIcon />
          <span>TYPE</span>
        </button>
      )}
      <button className="dock-btn" onClick={p.onTranscript} title="Transcript (T)">
        <TranscriptIcon />
        <span>LOG</span>
      </button>
    </nav>
  );
}

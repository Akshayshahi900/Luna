// Bottom controls: the big talk button plus a few toggles.
import { motion } from "motion/react";
import { KeyboardIcon, LoopIcon, MicIcon, SpeakerIcon, TranscriptIcon } from "./icons";

interface Props {
  listening: boolean;
  voiceIn: boolean;
  handsFree: boolean;
  voiceOut: boolean;
  onTalk: () => void;
  onHandsFree: () => void;
  onVoiceOut: () => void;
  onKeyboard: () => void;
  onTranscript: () => void;
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
        title="Conversation mode: listen again after every reply"
      >
        <LoopIcon />
        <span>CONVO</span>
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

      <button className="dock-btn" onClick={p.onKeyboard} title="Type a command (/)">
        <KeyboardIcon />
        <span>TYPE</span>
      </button>
      <button className="dock-btn" onClick={p.onTranscript} title="Transcript (T)">
        <TranscriptIcon />
        <span>LOG</span>
      </button>
    </nav>
  );
}

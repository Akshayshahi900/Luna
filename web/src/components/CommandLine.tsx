// Floating one-line text input, for when talking isn't an option.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SendIcon } from "./icons";

interface Props {
  open: boolean;
  placeholder?: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}

export function CommandLine({ open, placeholder, onSubmit, onClose }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.form
          className="cmdline"
          initial={{ opacity: 0, y: 20, scaleX: 0.6 }}
          animate={{ opacity: 1, y: 0, scaleX: 1 }}
          exit={{ opacity: 0, y: 10, scaleX: 0.8 }}
          transition={{ type: "spring", stiffness: 260, damping: 24 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onSubmit(text);
            setText("");
            onClose(); // voice-first: get out of the way of the captions
          }}
        >
          <span className="cmd-prompt">›_</span>
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={placeholder ?? "Enter directive…"}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="cmd-send" aria-label="Send">
            <SendIcon />
          </button>
        </motion.form>
      )}
    </AnimatePresence>
  );
}

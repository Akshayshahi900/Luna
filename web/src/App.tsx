// Ties it together: socket (useLuna) ↔ voice (Listener / Speaker) ↔ visuals.
//
// Voice loop: Space or the talk button → listen → the final transcript is
// sent (or answers a pending pause) → Luna's reply is spoken sentence by
// sentence as it streams → in conversation mode, listen again.
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boot } from "./components/Boot";
import { Captions } from "./components/Captions";
import { ChatDrawer } from "./components/ChatDrawer";
import { CommandLine } from "./components/CommandLine";
import { Dock } from "./components/Dock";
import { ModelSwitcher } from "./components/ModelSwitcher";
import { ActivityFeed, Frame, SystemPanel, TopBar } from "./components/Hud";
import { PauseCard } from "./components/PauseCard";
import { Core } from "./core/Core";
import { decayLive, live, MicMeter, setLive, sfx, sounds } from "./lib/audio";
import { isStopCommand, parseDecision } from "./lib/intent";
import type { Pause, PauseReply, ServerEvent } from "./lib/protocol";
import { Listener, SentenceChunker, Speaker } from "./lib/speech";
import type { Phase } from "./lib/theme";
import { useLuna } from "./lib/useLuna";

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function save(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* private mode: fine */
  }
}

/** What Luna says out loud when it pauses. */
function pausePrompt(pause: Pause): string {
  if (pause.kind === "question") return pause.question;
  if (pause.kind === "other") return pause.text;
  const a = pause.actions[0];
  const target = ["path", "command", "to", "title"].map((k) => a.args[k]).find((v) => typeof v === "string");
  const what = a.name.replace(/_/g, " ") + (target ? `: ${String(target).slice(0, 80)}` : "");
  const more = pause.actions.length > 1 ? ` and ${pause.actions.length - 1} more` : "";
  return `Authorization required. ${what}${more}. Approve or deny?`;
}

export default function App() {
  const voiceIn = Listener.supported;
  const [booted, setBooted] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [handsFree, setHandsFree] = useState(() => load("luna.handsFree", false));
  const [voiceOut, setVoiceOut] = useState(() => load("luna.voiceOut", true));
  const [drawer, setDrawer] = useState(false);
  const [typing, setTyping] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [fault, setFault] = useState(false);
  const [replies, setReplies] = useState<Record<string, PauseReply>>({});

  const speaker = useMemo(() => new Speaker(), []);
  const listener = useMemo(() => new Listener(), []);
  const mic = useMemo(() => new MicMeter(), []);
  const chunker = useMemo(() => new SentenceChunker(), []);

  // Callbacks below run from socket / speech events, so they read the
  // latest values through refs instead of stale closures.
  const lastInputWasVoice = useRef(false);
  const flags = useRef({ handsFree, booted });
  flags.current = { handsFree, booted };

  const startListening = useCallback(() => {
    if (!voiceIn) {
      setTyping(true);
      return;
    }
    if (listener.active) return;
    speaker.stop(); // barge-in: talking over Luna interrupts her
    listener.start();
    setListening(true);
    sounds.listen();
    void mic.start();
  }, [voiceIn, listener, speaker, mic]);

  const stopListening = useCallback(() => {
    listener.stop();
  }, [listener]);

  const onEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "hello") {
        speaker.mode = event.tts === "piper" ? "audio" : "browser";
      } else if (event.type === "token") {
        chunker.push(event.text).forEach((s) => speaker.speak(s));
      } else if (event.type === "tool_call" && event.depth === 0) {
        // Text before a tool call is a complete thought; say it now.
        chunker.flush().forEach((s) => speaker.speak(s));
      } else if (event.type === "done") {
        chunker.flush().forEach((s) => speaker.speak(s));
        sounds.done();
        if (!speaker.speaking && flags.current.handsFree && lastInputWasVoice.current) {
          setTimeout(startListening, 250);
        }
      } else if (event.type === "pause") {
        chunker.flush().forEach((s) => speaker.speak(s));
        sounds.alert();
        if (event.pauses[0]) speaker.speak(pausePrompt(event.pauses[0]));
        if (!speaker.speaking && lastInputWasVoice.current) setTimeout(startListening, 250);
      } else if (event.type === "model" && stateRef.current.switching) {
        sounds.done();
        speaker.speak(`Neural link switched to ${event.provider}.`);
      } else if (event.type === "error") {
        chunker.flush();
        sounds.error();
        setFault(true);
        setTimeout(() => setFault(false), 4000);
      }
    },
    [chunker, speaker, startListening],
  );

  const { state, send, sendMessage, answer, setModel } = useLuna(onEvent);
  const stateRef = useRef(state);
  stateRef.current = state;

  const currentPause = state.pauses.find((p) => !(p.id in replies));
  const pauseIndex = currentPause ? state.pauses.indexOf(currentPause) : 0;

  useEffect(() => setReplies({}), [state.pauses]);

  const replyToPause = useCallback(
    (pause: Pause, reply: PauseReply) => {
      const next = { ...replies, [pause.id]: reply };
      const all = stateRef.current.pauses;
      if (all.every((p) => p.id in next)) {
        answer(next);
        setReplies({});
      } else {
        setReplies(next);
        const upcoming = all.find((p) => !(p.id in next));
        if (upcoming) speaker.speak(pausePrompt(upcoming));
      }
      sounds.send();
    },
    [replies, answer, speaker],
  );

  /** Something the user said or typed. */
  const handleInput = useCallback(
    (text: string, viaVoice: boolean) => {
      lastInputWasVoice.current = viaVoice;
      if (viaVoice && isStopCommand(text)) {
        speaker.stop();
        return;
      }
      const pause = stateRef.current.pauses.find((p) => !(p.id in replies));
      if (pause) {
        if (pause.kind === "approval") {
          const decision = parseDecision(text);
          if (!decision) {
            speaker.speak("Sorry — approve or deny?");
            return;
          }
          replyToPause(pause, { decisions: [decision === "approve" ? { type: "approve" } : { type: "reject" }] });
        } else {
          replyToPause(pause, { answer: text });
        }
        return;
      }
      if (stateRef.current.busy) {
        speaker.speak("Still working on the last request.");
        return;
      }
      chunker.flush();
      speaker.stop();
      if (sendMessage(text)) sounds.send();
    },
    [replies, replyToPause, sendMessage, speaker, chunker],
  );

  // Wire speech callbacks once.
  useEffect(() => {
    listener.onInterim = setInterim;
    listener.onFinal = (text) => handleInput(text, true);
    listener.onEnd = () => {
      setListening(false);
      setInterim("");
      mic.stop();
      sounds.stopListen();
    };
    listener.onError = (err) => {
      setListening(false);
      mic.stop();
      if (err === "not-allowed") speaker.speak("Microphone access was denied.");
      if (err === "network") speaker.speak("Speech recognition needs Google Chrome or Edge with a network connection.");
    };
    speaker.onStart = () => setSpeaking(true);
    speaker.onEnd = () => {
      setSpeaking(false);
      const s = stateRef.current;
      const waitingOnUser = s.pauses.length > 0 && lastInputWasVoice.current;
      const continueConvo = flags.current.handsFree && lastInputWasVoice.current && !s.busy && !chunker.pending;
      if (waitingOnUser || continueConvo) setTimeout(startListening, 200);
    };
  }, [listener, speaker, mic, chunker, handleInput, startListening]);

  useEffect(() => {
    speaker.enabled = voiceOut;
    sfx.muted = !voiceOut; // one switch for all of Luna's sound
    if (!voiceOut) speaker.stop();
    save("luna.voiceOut", voiceOut);
  }, [voiceOut, speaker]);
  useEffect(() => save("luna.handsFree", handsFree), [handsFree]);

  // Feed audio levels to the core every frame.
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      if (mic.running) {
        mic.sample(now);
      } else if (speaker.speaking) {
        // Real Piper audio when available, a word-timed estimate otherwise.
        setLive(speaker.sample(live.bins, now));
      } else {
        decayLive();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onMove = (e: PointerEvent) => {
      live.pointer.x = (e.clientX / innerWidth) * 2 - 1;
      live.pointer.y = (e.clientY / innerHeight) * 2 - 1;
    };
    addEventListener("pointermove", onMove);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", onMove);
    };
  }, [mic, speaker]);

  // Keyboard: Space talk, / type, T transcript, Esc hush/close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!flags.current.booted) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]")) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (listener.active) stopListening();
        else startListening();
      } else if (e.key === "/") {
        e.preventDefault();
        setTyping(true);
      } else if (e.key.toLowerCase() === "t") {
        setDrawer((v) => !v);
      } else if (e.key.toLowerCase() === "m") {
        setSwitcher((v) => !v);
      } else if (e.key === "Escape") {
        speaker.stop();
        listener.abort();
        setDrawer(false);
        setTyping(false);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [listener, speaker, startListening, stopListening]);

  const engage = () => {
    speaker.unlock(); // inside the click: browsers only allow audio after a gesture
    setBooted(true);
    sounds.boot();
    if (stateRef.current.connected) setTimeout(() => speaker.speak("Luna online. How can I help?"), 700);
  };

  const phase: Phase = !booted
    ? "boot"
    : !state.connected
      ? "offline"
      : currentPause
        ? "waiting"
        : listening
          ? "listening"
          : speaking
            ? "speaking"
            : state.busy
              ? "thinking"
              : fault
                ? "error"
                : "idle";

  const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
  const last = state.messages[state.messages.length - 1];
  const lunaCaption = last?.role === "luna" ? last.text : undefined;
  const notice = fault ? state.error : last?.role === "system" ? last.text : undefined;

  return (
    <div className="app" data-phase={phase}>
      <div className="bg-grid" />
      <Core phase={phase} helpers={state.activeHelpers.length} />
      <Frame />

      <AnimatePresence>
        {!booted && <Boot connected={state.connected} voiceIn={voiceIn} voiceOut={speaker.supported} onEngage={engage} />}
      </AnimatePresence>

      {booted && (
        <>
          <TopBar phase={phase} connected={state.connected} provider={state.provider} onModelClick={() => setSwitcher(true)} />
          <ActivityFeed activity={state.activity} />
          <SystemPanel state={state} voiceIn={voiceIn} onModelClick={() => setSwitcher(true)} />
          <ModelSwitcher
            open={switcher}
            state={state}
            onFetch={(provider) => send({ type: "models", provider })}
            onApply={(provider, model) => {
              setModel(provider, model);
              setSwitcher(false);
            }}
            onClose={() => setSwitcher(false)}
          />

          <Captions user={lastUser?.text} luna={lunaCaption} interim={interim} notice={notice} />

          <AnimatePresence mode="wait">
            {currentPause && (
              <PauseCard
                key={currentPause.id}
                pause={currentPause}
                index={pauseIndex}
                total={state.pauses.length}
                listening={listening}
                voiceIn={voiceIn}
                onReply={(r) => {
                  lastInputWasVoice.current = false;
                  replyToPause(currentPause, r);
                }}
              />
            )}
          </AnimatePresence>

          <CommandLine
            open={typing}
            placeholder={currentPause ? "Answer Luna…" : undefined}
            onSubmit={(t) => handleInput(t, false)}
            onClose={() => setTyping(false)}
          />

          <Dock
            listening={listening}
            voiceIn={voiceIn}
            handsFree={handsFree}
            voiceOut={voiceOut}
            onTalk={() => (listening ? stopListening() : startListening())}
            onHandsFree={() => setHandsFree((v) => !v)}
            onVoiceOut={() => setVoiceOut((v) => !v)}
            onKeyboard={() => setTyping((v) => !v)}
            onTranscript={() => setDrawer((v) => !v)}
          />

          <ChatDrawer
            open={drawer}
            messages={state.messages}
            threadId={state.threadId}
            threads={state.threads}
            busy={state.busy}
            replyId={state.replyId}
            onClose={() => setDrawer(false)}
            onSend={(t) => handleInput(t, false)}
            onNewThread={() => send({ type: "new_thread" })}
            onPickThread={(id) => send({ type: "thread", id })}
            onListThreads={() => send({ type: "threads" })}
          />

          <div className="hint">
            {voiceIn ? "SPACE · TALK" : "VOICE INPUT NEEDS CHROME / EDGE"} &nbsp;/&nbsp; / · TYPE &nbsp;/&nbsp; T · LOG &nbsp;/&nbsp; M · MODEL &nbsp;/&nbsp; ESC · HUSH
          </div>
        </>
      )}
    </div>
  );
}

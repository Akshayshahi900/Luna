// Ties it together: socket (useLuna) ↔ voice in/out ↔ visuals.
//
// Voice in, two engines (the server says which in "hello"):
//  - whisper (default): VoiceInput records utterances, /api/stt transcribes
//    them locally. Hands-free mode keeps the mic open and reacts only to
//    "Hey Luna …" — or to anything said in a short follow-up window after
//    Luna replies, after a bare "Hey Luna", or while a question/approval is
//    open. Space / the talk button captures one utterance, no wake word.
//  - browser: Chrome/Edge speech recognition (Listener), push-to-talk only;
//    hands-free just means "listen again after each reply".
// Short commands (stop, cancel, switch to Groq, new conversation, sleep…)
// are handled here; everything else goes to Luna.
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boot } from "./components/Boot";
import { Captions } from "./components/Captions";
import { ChatDrawer } from "./components/ChatDrawer";
import { CommandLine } from "./components/CommandLine";
import { Dock } from "./components/Dock";
import { MemoryPanel } from "./components/MemoryPanel";
import { ModelSwitcher } from "./components/ModelSwitcher";
import { ActivityFeed, Frame, SystemPanel, TopBar } from "./components/Hud";
import { PauseCard } from "./components/PauseCard";
import { Core } from "./core/Core";
import { decayLive, live, MicMeter, setLive, sfx, sounds } from "./lib/audio";
import { isEcho, parseApproval, parseVoiceCommand, parseWake } from "./lib/intent";
import type { Pause, PauseReply, ServerEvent } from "./lib/protocol";
import { Listener, SentenceChunker, Speaker } from "./lib/speech";
import type { Phase } from "./lib/theme";
import { useLuna } from "./lib/useLuna";
import { transcribe, VoiceInput } from "./lib/voiceInput";

/** How long Luna keeps listening without the wake word after she replies. */
const FOLLOW_UP_MS = 8000;
/** Push-to-talk gives up if nobody starts talking within this time. */
const ONE_SHOT_WAIT_MS = 8000;
/** What Luna said in the last this-many ms counts for the echo check. */
const ECHO_WINDOW_MS = 30000;

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

const PROVIDER_NAMES = { openrouter: "OpenRouter", groq: "Groq", ollama: "Ollama" } as const;

export default function App() {
  const [booted, setBooted] = useState(false);
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState(false); // someone is talking (VAD)
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [handsFree, setHandsFree] = useState(() => load("luna.handsFree", false));
  const [voiceOut, setVoiceOut] = useState(() => load("luna.voiceOut", true));
  const [drawer, setDrawer] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [fault, setFault] = useState(false);
  const [replies, setReplies] = useState<Record<string, PauseReply>>({});

  const speaker = useMemo(() => new Speaker(), []);
  const listener = useMemo(() => new Listener(), []);
  const mic = useMemo(() => new MicMeter(), []); // browser mode: visuals only
  const voice = useMemo(() => new VoiceInput(), []); // whisper mode
  const chunker = useMemo(() => new SentenceChunker(), []);

  // Callbacks below run from socket / audio events, so they read the
  // latest values through refs instead of stale closures.
  const lastInputWasVoice = useRef(false);
  const oneShot = useRef(false); // push-to-talk capture in progress
  const followUntil = useRef(0); // accept speech without the wake word until then
  const followTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const oneShotTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wantReply = useRef(false); // listen once Luna finishes this prompt
  const spoken = useRef<{ text: string; at: number }[]>([]);
  const flags = useRef({ handsFree, booted, whisper: false });

  const onEventRef = useRef<(e: ServerEvent) => void>(() => {});
  const { state, send, sendMessage, answer, setModel } = useLuna((e) => onEventRef.current(e));
  const stateRef = useRef(state);
  stateRef.current = state;
  const whisper = state.stt === "whisper";
  const voiceIn = whisper || Listener.supported;
  flags.current = { handsFree, booted, whisper };

  /** Speak, remembering the words for the echo check. */
  const say = useCallback(
    (text: string) => {
      const now = Date.now();
      spoken.current = [...spoken.current.filter((s) => now - s.at < ECHO_WINDOW_MS), { text, at: now }];
      speaker.speak(text);
    },
    [speaker],
  );

  // --- listening ---------------------------------------------------------

  const endFollow = useCallback(() => {
    followUntil.current = 0;
    clearTimeout(followTimer.current);
    if (!oneShot.current) setListening(false);
  }, []);

  /** Hands-free: accept the next thing said, without the wake word, for `ms`. */
  const startFollow = useCallback((ms = FOLLOW_UP_MS) => {
    followUntil.current = Date.now() + ms;
    setListening(true);
    clearTimeout(followTimer.current);
    followTimer.current = setTimeout(() => {
      // Still talking when it runs out? Keep listening until they finish.
      if (voice.inSpeech) return startFollow(1500);
      followUntil.current = 0;
      if (!oneShot.current) setListening(false);
    }, ms);
  }, [voice]);

  const endOneShot = useCallback(() => {
    oneShot.current = false;
    clearTimeout(oneShotTimer.current);
    if (Date.now() >= followUntil.current) setListening(false);
    if (!flags.current.handsFree) voice.stop();
  }, [voice]);

  /** Push-to-talk: capture one utterance. */
  const startListening = useCallback(async () => {
    speaker.stop(); // talking over Luna interrupts her
    if (!flags.current.whisper) {
      if (!Listener.supported) return setTyping(true);
      if (listener.active) return;
      listener.start();
      setListening(true);
      sounds.listen();
      void mic.start();
      return;
    }
    oneShot.current = true;
    setListening(true);
    sounds.listen();
    clearTimeout(oneShotTimer.current);
    oneShotTimer.current = setTimeout(() => {
      if (oneShot.current && !voice.inSpeech) endOneShot();
    }, ONE_SHOT_WAIT_MS);
    if (!(await voice.start())) endOneShot();
  }, [speaker, listener, mic, voice, endOneShot]);

  /** Space / button again: finish now (or give up if nothing was said). */
  const stopListening = useCallback(() => {
    if (!flags.current.whisper) return listener.stop();
    if (voice.inSpeech) voice.flush();
    else {
      endOneShot();
      endFollow();
      sounds.stopListen();
    }
  }, [listener, voice, endOneShot, endFollow]);

  /** Luna asked something / replied: be ready for the answer. */
  const listenForReply = useCallback(() => {
    if (!flags.current.booted) return;
    if (flags.current.whisper && flags.current.handsFree) startFollow();
    else void startListening();
  }, [startFollow, startListening]);

  // --- server events -----------------------------------------------------

  onEventRef.current = (event: ServerEvent) => {
    if (event.type === "hello") {
      speaker.mode = event.tts === "piper" ? "audio" : "browser";
    } else if (event.type === "token") {
      chunker.push(event.text).forEach(say);
    } else if (event.type === "tool_call" && event.depth === 0) {
      // Text before a tool call is a complete thought; say it now.
      chunker.flush().forEach(say);
    } else if (event.type === "done") {
      chunker.flush().forEach(say);
      sounds.done();
      if (!speaker.speaking && flags.current.handsFree && lastInputWasVoice.current) listenForReply();
    } else if (event.type === "pause") {
      chunker.flush().forEach(say);
      sounds.alert();
      if (event.pauses[0]) say(pausePrompt(event.pauses[0]));
      wantReply.current = lastInputWasVoice.current || (flags.current.handsFree && flags.current.whisper);
      if (!speaker.speaking && wantReply.current) {
        wantReply.current = false;
        listenForReply();
      }
    } else if (event.type === "cancelled") {
      chunker.flush();
      speaker.stop();
      sounds.stopListen();
      if (lastInputWasVoice.current) say("Cancelled.");
    } else if (event.type === "model" && stateRef.current.switching) {
      sounds.done();
      say(`Neural link switched to ${PROVIDER_NAMES[event.provider as keyof typeof PROVIDER_NAMES] ?? event.provider}.`);
    } else if (event.type === "error") {
      chunker.flush();
      sounds.error();
      setFault(true);
      setTimeout(() => setFault(false), 4000);
    }
  };

  // --- pauses ------------------------------------------------------------

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
        if (upcoming) {
          say(pausePrompt(upcoming));
          wantReply.current = lastInputWasVoice.current;
        }
      }
      sounds.send();
    },
    [replies, answer, say],
  );

  // --- what the user said or typed ----------------------------------------

  const handleInput = useCallback(
    (text: string, viaVoice: boolean) => {
      lastInputWasVoice.current = viaVoice;
      const s = stateRef.current;

      if (viaVoice) {
        const cmd = parseVoiceCommand(text);
        if (cmd?.kind === "hush") return speaker.stop();
        if (cmd?.kind === "cancel") {
          speaker.stop();
          if (s.busy || s.pauses.length) send({ type: "cancel" });
          return;
        }
        if (cmd?.kind === "model") {
          const info = s.providers.find((p) => p.id === cmd.provider);
          if (!info?.configured) return say(`There's no API key for ${PROVIDER_NAMES[cmd.provider]}.`);
          if (s.busy) return say("I'll switch after this task.");
          return setModel(cmd.provider, "");
        }
        if (cmd?.kind === "new_thread") {
          if (s.busy || s.pauses.length) return say("Finish or cancel the current task first.");
          send({ type: "new_thread" });
          return say("New conversation.");
        }
        if (cmd?.kind === "sleep") {
          setHandsFree(false);
          endFollow();
          return say("Going quiet. Press space when you need me.");
        }
        if (cmd?.kind === "transcript") {
          setMemoryOpen(false);
          return setDrawer(cmd.open);
        }
      }

      const pause = s.pauses.find((p) => !(p.id in replies));
      if (pause) {
        if (pause.kind === "approval") {
          const parsed = parseApproval(text);
          if (!parsed) {
            say("Sorry — approve or deny?");
            wantReply.current = viaVoice;
            return;
          }
          const decision =
            parsed.decision === "approve"
              ? ({ type: "approve" } as const)
              : ({ type: "reject", message: parsed.reason } as const);
          replyToPause(pause, { decisions: [decision] });
        } else {
          replyToPause(pause, { answer: text });
        }
        return;
      }
      if (s.busy) {
        say(viaVoice ? "Still working on it. Say “Luna, cancel” to stop." : "Still working on the last request.");
        return;
      }
      chunker.flush();
      speaker.stop();
      if (sendMessage(text)) sounds.send();
    },
    [replies, replyToPause, sendMessage, send, setModel, say, speaker, chunker, endFollow],
  );

  /** One transcribed utterance from the local mic (whisper mode). */
  const handleHeard = useCallback(
    (text: string, accepting: boolean) => {
      if (!text) return;
      const now = Date.now();
      if (isEcho(text, spoken.current.filter((s) => now - s.at < ECHO_WINDOW_MS).map((s) => s.text))) return;
      const { woke, rest } = parseWake(text);
      // While Luna talks, only "Luna, …" counts (barge-in).
      if (!woke && (!accepting || speaker.speaking)) return;
      const command = woke ? rest : text;
      if (!command) {
        // Just "Hey Luna": acknowledge and listen for the request.
        speaker.stop();
        sounds.listen();
        say("Yes?");
        startFollow(FOLLOW_UP_MS + 2000);
        return;
      }
      endFollow();
      handleInput(command, true);
    },
    [speaker, say, startFollow, endFollow, handleInput],
  );

  // Wire engine callbacks (they read fresh state through the refs above).
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
      if (err === "not-allowed") say("Microphone access was denied.");
      if (err === "network") say("Speech recognition needs Google Chrome or Edge with a network connection.");
    };

    voice.onSpeechStart = () => setHearing(true);
    voice.onUtterance = async (wav) => {
      setHearing(false);
      // Decided when they stopped talking, not after transcription.
      const accepting = oneShot.current || Date.now() < followUntil.current;
      if (oneShot.current) endOneShot();
      setTranscribing(true);
      try {
        handleHeard(await transcribe(wav), accepting);
      } catch {
        setFault(true);
        setTimeout(() => setFault(false), 3000);
      } finally {
        setTranscribing(false);
      }
    };
    voice.onError = (err) => {
      endOneShot();
      setHandsFree(false);
      say(err === "not-allowed" ? "Microphone access was denied." : "I can't open the microphone.");
    };

    speaker.onStart = () => {
      setSpeaking(true);
      voice.sensitivity = 1.6; // her own voice may leak into the mic
    };
    speaker.onEnd = () => {
      setSpeaking(false);
      voice.sensitivity = 1;
      const s = stateRef.current;
      if (wantReply.current) {
        wantReply.current = false;
        return listenForReply();
      }
      if (flags.current.handsFree && lastInputWasVoice.current && !s.busy && !chunker.pending && !s.pauses.length) {
        listenForReply();
      }
    };
  }, [listener, voice, speaker, mic, chunker, handleInput, handleHeard, endOneShot, listenForReply, say]);

  // Hands-free (whisper): keep the mic open while the page is engaged.
  useEffect(() => {
    if (booted && whisper && handsFree) void voice.start();
    else if (!oneShot.current) {
      voice.stop();
      endFollow();
    }
    save("luna.handsFree", handsFree);
  }, [booted, whisper, handsFree, voice, endFollow]);

  useEffect(() => {
    speaker.enabled = voiceOut;
    sfx.muted = !voiceOut; // one switch for all of Luna's sound
    if (!voiceOut) speaker.stop();
    save("luna.voiceOut", voiceOut);
  }, [voiceOut, speaker]);

  // Feed audio levels to the core every frame.
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      if (speaker.speaking) {
        // Real Piper audio when available, a word-timed estimate otherwise.
        setLive(speaker.sample(live.bins, now));
      } else if (voice.open && (voice.inSpeech || oneShot.current || Date.now() < followUntil.current)) {
        voice.sample(now);
      } else if (mic.running) {
        mic.sample(now);
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
  }, [mic, speaker, voice]);

  // The Memory panel shares the right edge with the transcript: one at a time.
  const toggleDrawer = useCallback(() => {
    setMemoryOpen(false);
    setDrawer((v) => !v);
  }, []);
  const toggleMemory = useCallback(() => {
    setDrawer(false);
    setMemoryOpen((v) => !v);
  }, []);

  // Fresh list on open, and whenever Luna adds a suggestion while it's open.
  useEffect(() => {
    if (memoryOpen) send({ type: "memories" });
  }, [memoryOpen, state.inbox, send]);

  // Keyboard: Space talk, / type, T transcript, K memory, M model,
  // Esc stops a running task (STOP), otherwise hushes Luna and closes panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!flags.current.booted) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]")) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (listener.active || oneShot.current) stopListening();
        else void startListening();
      } else if (e.key === "/") {
        e.preventDefault();
        setTyping(true);
      } else if (e.key.toLowerCase() === "t") {
        toggleDrawer();
      } else if (e.key.toLowerCase() === "k" && stateRef.current.memoryOn) {
        toggleMemory();
      } else if (e.key.toLowerCase() === "m") {
        setSwitcher((v) => !v);
      } else if (e.key === "Escape" && stateRef.current.busy) {
        // A run is in progress: stop it (and its helpers). Approvals and
        // questions are not "running"; Esc keeps its old meaning for them.
        speaker.stop();
        send({ type: "cancel" }); // "cancelled" then flushes the rest of the reply
      } else if (e.key === "Escape") {
        speaker.stop();
        listener.abort();
        if (oneShot.current) {
          voice.discard();
          endOneShot();
        }
        endFollow();
        setDrawer(false);
        setMemoryOpen(false);
        setTyping(false);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [listener, speaker, voice, send, startListening, stopListening, endOneShot, endFollow, toggleDrawer, toggleMemory]);

  const engage = () => {
    speaker.unlock(); // inside the click: browsers only allow audio after a gesture
    setBooted(true);
    sounds.boot();
    const s = stateRef.current;
    if (!s.connected) return;
    // Never start with "Luna": the mic could hear it and wake her.
    const hint = s.stt === "whisper" && flags.current.handsFree ? " Say “Hey Luna” when you need me." : " How can I help?";
    setTimeout(() => say(`Online.${hint}`), 700);
  };

  const phase: Phase = !booted
    ? "boot"
    : !state.connected
      ? "offline"
      : currentPause
        ? "waiting"
        : listening || transcribing
          ? "listening"
          : speaking
            ? "speaking"
            : state.busy
              ? "thinking"
              : fault
                ? "error"
                : whisper && handsFree
                  ? "standby"
                  : "idle";

  const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
  const last = state.messages[state.messages.length - 1];
  const lunaCaption = last?.role === "luna" ? last.text : undefined;
  const notice = fault ? (state.error ?? "Voice error") : last?.role === "system" ? last.text : undefined;
  const liveCaption = interim || (transcribing ? "…" : hearing && listening ? "● ● ●" : "");
  const voiceLabel = whisper ? (handsFree ? "WAKE WORD" : "WHISPER") : Listener.supported ? "BROWSER" : "TEXT ONLY";

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
          <SystemPanel state={state} voiceLabel={voiceLabel} onModelClick={() => setSwitcher(true)} />
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

          {/* The transcript drawer already shows the conversation. */}
          <Captions
            user={drawer ? undefined : lastUser?.text}
            luna={drawer ? undefined : lunaCaption}
            interim={liveCaption}
            notice={notice}
            beside={drawer || memoryOpen}
          />

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
            wakeWord={whisper}
            voiceOut={voiceOut}
            canAbort={state.busy || state.pauses.length > 0}
            onTalk={() => (listening && (oneShot.current || listener.active) ? stopListening() : void startListening())}
            onHandsFree={() => setHandsFree((v) => !v)}
            onVoiceOut={() => setVoiceOut((v) => !v)}
            onKeyboard={() => setTyping((v) => !v)}
            onTranscript={toggleDrawer}
            onAbort={() => send({ type: "cancel" })}
            memory={state.memoryOn}
            inbox={state.inbox}
            onMemory={toggleMemory}
          />

          <MemoryPanel open={memoryOpen} state={state} send={send} onClose={() => setMemoryOpen(false)} />

          <ChatDrawer
            open={drawer}
            messages={state.messages}
            threadId={state.threadId}
            sessions={state.sessions}
            busy={state.busy}
            replyId={state.replyId}
            onClose={() => setDrawer(false)}
            onSend={(t) => handleInput(t, false)}
            onNewThread={() => send({ type: "new_thread" })}
            onPickThread={(id) => send({ type: "thread", id })}
            onListSessions={() => send({ type: "sessions" })}
            onDeleteSession={(id) => send({ type: "delete_session", id })}
          />

          <div className="hint">
            {whisper && handsFree ? "“HEY LUNA” · TALK" : voiceIn ? "SPACE · TALK" : "VOICE INPUT NEEDS CHROME / EDGE"} &nbsp;/&nbsp; / · TYPE
            &nbsp;/&nbsp; T · LOG {state.memoryOn && <>&nbsp;/&nbsp; K · MEMORY </>}&nbsp;/&nbsp; M · MODEL &nbsp;/&nbsp; ESC · {state.busy ? "STOP" : "HUSH"}
          </div>
        </>
      )}
    </div>
  );
}

// Voice parsing that doesn't need the model: the wake phrase, short
// commands (stop, cancel, switch model, new chat, sleep), approvals, and an
// echo check so Luna doesn't react to her own voice. All pure, tested in
// intent.test.ts.

const APPROVE = /\b(approve[ds]?|yes|yeah|yep|sure|confirm(ed)?|authori[sz]e[ds]?|go ahead|do it|proceed|affirmative|ok(ay)?)\b/i;
const REJECT = /\b(reject(ed)?|no|nope|deny|denied|decline[ds]?|cancel(led)?|abort|stop|don'?t|negative)\b/i;
// "don't do it" / "do not proceed" are one rejection, not reject + approve.
const NEGATED = /\b(don'?t|do not)\s+(do it|proceed|go ahead|approve)\b/gi;
const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const STOP = /^\s*(luna[, ]*)?(stop|quiet|silence|shut up|be quiet|enough|hush)( talking| it| that| now)?[.!]?\s*$/i;

/**
 * Whisper writes the name several ways ("Luna", "Lunar", "Hey-Lunar",
 * "Heilunar"); accept those, but only as the FIRST word(s), so "the lunar
 * eclipse is tonight" doesn't wake her.
 */
const WAKE = /^[\s"'“(]*(?:(?:hey|hi|hei|hay|okay|ok|oh|yo)[\s,.!-]*)?(?:luna|lunar|loona|lunah|nuna)(?:'s)?\b[\s,.!?:;-]*/i;

/** "Hey Luna, what time is it?" → {woke: true, rest: "What time is it?"}. */
export function parseWake(text: string): { woke: boolean; rest: string } {
  const m = text.match(WAKE);
  if (!m) return { woke: false, rest: text.trim() };
  const rest = text.slice(m[0].length).trim();
  return { woke: true, rest: rest ? rest[0].toUpperCase() + rest.slice(1) : "" };
}

function decision(text: string): "approve" | "reject" | null {
  const t = text.replace(NEGATED, "no");
  const yes = t.match(APPROVE);
  const no = t.match(REJECT);
  if (!yes && !no) return null;
  if (yes && !no) return "approve";
  if (no && !yes) return "reject";
  // Both: in a short answer ("yes no", "yes, no wait") it's unclear; in a
  // longer one the first counts ("no, do it in notes.md instead" → reject).
  if (words(t).length <= 3) return null;
  return yes!.index! < no!.index! ? "approve" : "reject";
}

/** "yes, go ahead" → approve, "no" → reject, anything unclear → null. */
export function parseDecision(text: string): "approve" | "reject" | null {
  return decision(text);
}

/**
 * A spoken approval, with an optional reason on rejections:
 * "no, call it notes.md instead" → reject, reason "call it notes.md instead".
 * The reason goes back to Luna, so a denial can steer what she does next.
 */
export function parseApproval(text: string): { decision: "approve" | "reject"; reason?: string } | null {
  const d = decision(text);
  if (d !== "reject") return d ? { decision: d } : null;
  const after = text.replace(NEGATED, "no").replace(/^.*?\b(reject(ed)?|no|nope|deny|denied|decline[ds]?|negative)\b[\s,.!:;-]*/i, "");
  const reason = after.replace(/^(because|since)\s+/i, "").trim();
  return reason.split(/\s+/).length >= 2 ? { decision: "reject", reason } : { decision: "reject" };
}

/** A short "stop" / "quiet" that should silence Luna instead of becoming a message. */
export function isStopCommand(text: string): boolean {
  return STOP.test(text);
}

export type VoiceCommand =
  | { kind: "hush" }
  | { kind: "cancel" }
  | { kind: "model"; provider: "openrouter" | "groq" | "ollama" }
  | { kind: "new_thread" }
  | { kind: "sleep" }
  | { kind: "transcript"; open: boolean };

const PROVIDER_WORDS: [RegExp, "openrouter" | "groq" | "ollama"][] = [
  [/^(groq|grok|grog|grock|grogue|rock)$/i, "groq"],
  [/^(open ?router|open rooter)$/i, "openrouter"],
  [/^(ollama|olama|o llama|llama|lama)$/i, "ollama"],
];

const whole = (body: string) => new RegExp(`^\\s*(?:please\\s+)?(?:${body})(?:\\s+please)?[\\s.!?]*$`, "i");

const CANCEL = whole("cancel|cancel (?:that|it|the task|everything)|abort|abort (?:that|it|the task)|never ?mind|forget (?:it|that)|stop (?:working|the task|that task)");
const NEW_THREAD = whole("(?:start )?(?:a )?(?:new|fresh) (?:conversation|chat|thread|session)|start over|clear (?:the )?(?:chat|conversation)");
const SLEEP = whole("go to sleep|sleep|stop listening|sleep mode|goodbye|good night");
const SWITCH = whole("(?:switch|change|swap)(?: the)?(?: model| brain)? (?:to|over to) (?:the )?(.+?)(?: model)?|use (?:the )?(.+?)(?: model)?");
const TRANSCRIPT = whole("(show|open|hide|close)(?: the)? (?:transcript|log|chat|history)");

/** Recognize one of Luna's built-in voice commands (whole utterance only). */
export function parseVoiceCommand(text: string): VoiceCommand | null {
  if (isStopCommand(text)) return { kind: "hush" };
  if (CANCEL.test(text)) return { kind: "cancel" };
  if (NEW_THREAD.test(text)) return { kind: "new_thread" };
  if (SLEEP.test(text)) return { kind: "sleep" };
  const t = text.match(TRANSCRIPT);
  if (t) return { kind: "transcript", open: /show|open/i.test(t[1]) };
  const s = text.match(SWITCH);
  if (s) {
    const name = (s[1] ?? s[2] ?? "").trim().replace(/[.!?]+$/, "");
    for (const [re, provider] of PROVIDER_WORDS) if (re.test(name)) return { kind: "model", provider };
  }
  return null;
}

/**
 * Is this transcript just Luna's own voice coming back through the mic?
 * True when 3+ words and ≥ 70% of them are words she said recently.
 * Short phrases ("Luna, stop") never count, so barge-in still works.
 */
export function isEcho(transcript: string, recentlySpoken: string[]): boolean {
  const heard = words(transcript);
  if (heard.length < 3) return false;
  const said = new Set(recentlySpoken.flatMap(words));
  const overlap = heard.filter((w) => said.has(w)).length / heard.length;
  return overlap >= 0.7;
}

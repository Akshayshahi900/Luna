// Tiny voice-command parser for the moments that don't need the model:
// answering an approval, or telling Luna to stop talking.

const APPROVE = /\b(approve[ds]?|yes|yeah|yep|sure|confirm(ed)?|authori[sz]e[ds]?|go ahead|do it|proceed|affirmative|ok(ay)?)\b/i;
const REJECT = /\b(reject(ed)?|no|nope|deny|denied|decline[ds]?|cancel(led)?|abort|stop|don'?t|negative)\b/i;
const STOP = /^\s*(luna[, ]*)?(stop|quiet|silence|shut up|be quiet|enough|cancel)( talking| it| that)?[.!]?\s*$/i;

/** "yes, go ahead" → approve, "no don't" → reject, anything else → null. */
export function parseDecision(text: string): "approve" | "reject" | null {
  const no = REJECT.test(text);
  const yes = APPROVE.test(text);
  if (no && !yes) return "reject";
  if (yes && !no) return "approve";
  return null; // unclear ("yes... no wait") — ask again
}

/** A short "stop" / "quiet" that should silence Luna instead of becoming a message. */
export function isStopCommand(text: string): boolean {
  return STOP.test(text);
}

/** Test emails for the mail, tasks and calendar server tests. */
import MailComposer from "nodemailer/lib/mail-composer/index.js";

import { type Email, parseEmail } from "../servers/mail.ts";

export interface FakeMail {
  from?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  subject?: string;
  messageId?: string;
  body?: string;
  html?: boolean;
}

/** Raw RFC 822 bytes for a test email (Date: Sat, 17 Oct 2026 10:00:00 +0530). */
export async function rawEmail(m: FakeMail): Promise<Buffer> {
  const raw = await new MailComposer({
    from: m.from ?? "Bob <bob@example.com>",
    to: m.to ?? "me@example.com",
    ...(m.cc ? { cc: m.cc } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    subject: m.subject ?? "",
    ...(m.messageId ? { messageId: m.messageId } : {}),
    headers: { Date: "Sat, 17 Oct 2026 10:00:00 +0530" },
    ...(m.html ? { html: m.body ?? "" } : { text: m.body ?? "Hi there" }),
  }).compile().build();
  if (m.messageId === "") return Buffer.from(raw.toString().replace(/^Message-ID:.*\r?\n/im, ""));
  return raw;
}

export async function fakeEmail(m: FakeMail): Promise<Email> {
  return parseEmail(await rawEmail(m));
}

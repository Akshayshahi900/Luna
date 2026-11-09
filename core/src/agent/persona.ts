/**
 * Persona — how Luna talks and who she talks to.
 *
 * BEGINNER MAP
 * ------------
 * The model's behaviour comes from its system prompt. Instead of one long
 * hard-coded string, the prompt is built here from small pieces, each one
 * controlled by a setting (see config/settings.ts):
 *
 *   system_prompt     what Luna is and how she works (role, economy)
 *   response_style    'concise' (spoken, one or two sentences) or 'detailed'
 *   user_title        how she addresses you, e.g. "Sir" ("" = by name or not at all)
 *   user_name         your name, if you want her to know it
 *   user_location     your default place for weather, time, "near me" questions
 *   units             'metric' or 'imperial'
 *   timezone          your IANA timezone, e.g. Asia/Kolkata
 *   persona_path      optional Markdown file with any extra instructions
 *
 * Example .env:
 *
 *   LUNA_USER_TITLE=Sir
 *   LUNA_USER_LOCATION=Agra, India
 *   LUNA_TIMEZONE=Asia/Kolkata
 *
 * Then "what's the weather?" gets something like
 * "It's 33 degrees, Sir, with a 30 percent chance of rain."
 *
 * Only the main agent gets the persona. Helpers (researcher, coder, ...)
 * return facts to the main agent, which phrases the final reply.
 */

import { readFileSync, statSync } from "node:fs";

import type { Settings } from "../config/settings.ts";

export const CONCISE_STYLE = `
How to reply (your replies are usually spoken aloud):
- Answer in one or two short sentences, like a person talking. Lead with the answer.
- No lists, headings, markdown, URLs or source names unless the user asks for them.
- Give only what was asked: e.g. for weather, the temperature and chance of rain.
  Round numbers ("33 degrees", "30 percent"), and spell units the way you'd say them.
- If the user asks for detail, an explanation, steps or code, give it in full.
`.trim();

export const DETAILED_STYLE = `
How to reply:
- Lead with the answer, then the detail that helps. Use lists or code blocks when they help.
`.trim();

export const STYLES: Record<string, string> = { concise: CONCISE_STYLE, detailed: DETAILED_STYLE };

function addressRule(settings: Settings): string {
  const title = settings.user_title.trim();
  const name = (settings.user_name ?? "").trim();
  if (title) {
    return `Address the user as "${title}", once per reply, e.g. "It's 33 degrees, ${title}, with a 30 percent chance of rain."`;
  }
  if (name) return `Address the user by name (${name}) now and then, not in every reply.`;
  return "";
}

function profile(settings: Settings): string {
  const facts: string[] = [];
  if (settings.user_name) facts.push(`- Name: ${settings.user_name.trim()}`);
  if (settings.user_location) {
    facts.push(
      `- Location: ${settings.user_location.trim()}. Use it when a question needs ` +
        'a place and none is given (weather, local time, news, "near me").',
    );
  }
  facts.push(`- Units: ${settings.units}` + (settings.units === "metric" ? " (Celsius, km, kg)." : " (Fahrenheit, miles, lb)."));
  if (settings.timezone) facts.push(`- Timezone: ${settings.timezone}. Pass it to get_current_time for the local time.`);
  return (
    "About the user:\n" + facts.join("\n") + "\n" +
    "When you hand a task to a helper, include the facts it needs (place, units)."
  );
}

/** Text of the user's persona file, or "" when there is none. */
export function loadPersonaFile(file: string | null): string {
  if (!file) return "";
  try {
    if (!statSync(file).isFile()) return "";
  } catch {
    return "";
  }
  return readFileSync(file, "utf8").trim();
}

/** The main agent's full system prompt, built from the persona settings. */
export function buildSystemPrompt(settings: Settings): string {
  const parts = [settings.system_prompt.trim(), STYLES[settings.response_style], addressRule(settings), profile(settings)];
  const extra = loadPersonaFile(settings.persona_path);
  if (extra) parts.push("Extra instructions from the user (follow them):\n" + extra);
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Researcher subagent — web search and reading pages (Tavily).
 *
 * Why a subagent (spec2 rule 1): research is noisy and multi-step. Several
 * searches and long pages stay in the researcher's own context; the main
 * agent only gets the key facts (≤ 60 words) and a source or two.
 *
 * Enabled only when LUNA_TAVILY_API_KEY is set. All tools are read-only, so
 * nothing here needs human approval.
 */

import { TavilyExtract, TavilySearch } from "@langchain/tavily";

import type { Settings } from "../../config/settings.ts";
import { calculator } from "../../tools/builtin/index.ts";
import { capOutput } from "../../tools/limits.ts";
import type { AnyTool } from "../../tools/registry.ts";
import { type SubagentSpec, subagentSpec } from "./base.ts";

export const RESEARCHER_PROMPT = `
You are Luna's research helper. Answer the task using the web.

- Every step costs an API request, so be brief: one or two focused tavily_search
  calls usually suffice. When you need several searches, make them in the same step.
- Use tavily_extract only when the snippets truly are not enough, on one or two URLs.
- Answer as soon as you have enough; do not keep searching to be thorough.
- Prefer recent, primary sources. Note dates when they matter.
- tavily_search returns a short "answer" next to the results; if it answers the
  task, use it and stop.
- If sources disagree or you are unsure, say so in a few words.
- Your reply is turned into one or two spoken sentences, so return only the facts
  that answer the task (numbers with units, names, dates), at most 60 words, no
  background or filler. If the task asks for a detailed report, up to 300 words is fine.
- End with a "Sources:" line of at most two URLs.
`.trim();

const DESCRIPTION =
  "Research a question on the web and get back a short answer with sources. " +
  "Use for current events, facts you are unsure of, comparisons, or anything " +
  "that needs several searches or reading web pages.";

/** The researcher, or null when no Tavily key is configured. */
export function researcherSpec(settings: Settings): SubagentSpec | null {
  const key = settings.tavily_api_key;
  if (!key) return null;
  return subagentSpec({
    name: "ask_researcher",
    description: DESCRIPTION,
    systemPrompt: RESEARCHER_PROMPT,
    tools: [
      // Fewer, shorter results plus Tavily's own one-paragraph answer:
      // most questions are settled by the answer alone (less noise, fewer calls).
      capOutput(
        new TavilySearch({ maxResults: 3, includeAnswer: "basic", searchDepth: "basic", tavilyApiKey: key } as never) as unknown as AnyTool,
        4000,
      ),
      capOutput(new TavilyExtract({ extractDepth: "basic", tavilyApiKey: key } as never) as unknown as AnyTool),
      calculator as unknown as AnyTool,
    ],
    maxModelCalls: 5,
    timeoutSeconds: 180,
  });
}

/**
 * ask_user — let the agent pause and ask you a question.
 *
 * BEGINNER MAP
 * ------------
 * interrupt() stops the agent graph and saves its state (needs a
 * checkpointer). The CLI sees the pause, shows the question, and resumes the
 * graph with your answer, which becomes this tool's return value.
 */

import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import * as z from "zod";

export const askUser = tool(
  async ({ question }) => {
    const answer = interrupt({ type: "ask_user", question });
    return String(answer ?? "").trim() || "(no answer)";
  },
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question and wait for their answer.\n\n" +
      "Use only when you cannot continue without information only the user has " +
      "(a preference, a missing detail, a choice between options). Do not use it " +
      "to confirm actions; risky actions already ask for approval.",
    schema: z.object({ question: z.string().describe("One clear, specific question.") }),
  },
);

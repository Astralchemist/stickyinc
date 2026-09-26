import { z } from "zod";
import { addTaskUnique } from "../db.js";
import { describeDue, resolveDue, type Due } from "../dates.js";
import { contextSchema, fromTool, type ToolContext } from "../provenance.js";
import { resolveLLMProvider } from "../providers/index.js";
import { alreadyListed } from "./duplicate.js";

export const addTaskNaturalSchema = {
  input: z
    .string()
    .min(1)
    .describe(
      "Free-text phrase like 'call dentist Friday 3pm' or 'buy bread'. Will be parsed by the configured LLM."
    ),
  context: contextSchema,
};

interface ParsedTask {
  text: string;
  due: Due | null;
}

// The model only finds the words that say when; resolveDue turns them into
// a date, so the arithmetic is deterministic.
const SYSTEM_PROMPT = `You convert a user phrase into a JSON task description.

Output ONLY a single JSON object, no prose, no code fences. Schema:
{
  "text": "<the thing to do, concise, no date>",
  "due": "<the words that say when, copied from the phrase, or null>"
}

Rules:
- "text" is the action, cleaned of date/time phrasing.
- "due" copies the date/time words as written ("Friday 3pm", "tomorrow", "in 2 hours", "next week"), or null if the phrase doesn't say when.
- Don't work out a date; copy the words. If an hour has no am/pm, add the one the user means.`;

function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function extractJson(raw: string): unknown {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`LLM returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

async function parseTask(input: string): Promise<ParsedTask> {
  const provider = await resolveLLMProvider();
  if (!provider) {
    throw new Error(
      "No LLM configured. StickyInc will use whatever you already have: the claude / codex / gemini " +
        "CLI signed in (subscription piggyback), Ollama or LM Studio running locally, or an API key " +
        "via OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY. Or create ~/.stickyinc/llm.json. " +
        "See README 'LLM providers'."
    );
  }

  const res = await provider.chat({
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: `Phrase: ${input}` },
    ],
    response_format: "json",
    max_tokens: 200,
    temperature: 0,
  });

  const parsed = extractJson(res.content) as { text?: unknown; due?: unknown } | null;
  if (!parsed || typeof parsed.text !== "string") {
    throw new Error(`LLM returned malformed task: ${res.content.slice(0, 200)}`);
  }
  return {
    text: parsed.text,
    due: typeof parsed.due === "string" && parsed.due.trim() ? resolveDue(parsed.due) : null,
  };
}

export async function handleAddTaskNatural(
  args: { input: string; context?: ToolContext },
  client: string | null
) {
  try {
    const parsed = await parseTask(args.input);
    const { task, inserted } = addTaskUnique({
      text: parsed.text,
      due: parsed.due,
      from: fromTool(client, args.context),
    });
    if (!inserted) return { content: [{ type: "text" as const, text: alreadyListed(task) }] };
    const due = parsed.due ? `, ${describeDue(parsed.due)}` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Parsed & added task #${task.id}: ${task.text}${due}`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Could not parse: ${msg}` }],
      isError: true,
    };
  }
}

import { z } from "zod";
import { addTask } from "../db.js";
import { resolveLLMProvider } from "../providers/index.js";

export const addTaskNaturalSchema = {
  input: z
    .string()
    .min(1)
    .describe(
      "Free-text phrase like 'call dentist Friday 3pm' or 'buy bread'. Will be parsed by the configured LLM."
    ),
};

interface ParsedTask {
  text: string;
  due_at: string | null;
}

const SYSTEM_PROMPT = `You convert a user phrase into a JSON task description.

Output ONLY a single JSON object, no prose, no code fences. Schema:
{
  "text": "<the thing to do, concise, no date>",
  "due_at": "<ISO 8601 UTC datetime or null>"
}

Rules:
- "text" is the action, cleaned of date/time phrasing.
- "due_at" is UTC ISO 8601 (e.g. "2026-04-25T15:00:00Z") or null if no time implied.
- Relative dates resolve against the current moment provided.
- If a date is given without a time, default to 09:00 local → UTC.
- If only a time is given, default to today (or tomorrow if the time has passed).`;

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
  const provider = resolveLLMProvider();
  if (!provider) {
    throw new Error(
      "No LLM configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY, " +
        "or create ~/.stickyinc/llm.json. See README 'LLM providers'."
    );
  }

  const now = new Date().toISOString();
  const res = await provider.chat({
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: `Current time: ${now}\n\nPhrase: ${input}` },
    ],
    response_format: "json",
    max_tokens: 200,
    temperature: 0,
  });

  const parsed = extractJson(res.content) as Partial<ParsedTask>;
  if (!parsed || typeof parsed.text !== "string") {
    throw new Error(`LLM returned malformed task: ${res.content.slice(0, 200)}`);
  }
  return {
    text: parsed.text,
    due_at:
      typeof parsed.due_at === "string" && parsed.due_at.length > 0
        ? parsed.due_at
        : null,
  };
}

export async function handleAddTaskNatural(args: { input: string }) {
  try {
    const parsed = await parseTask(args.input);
    const task = addTask(parsed.text, parsed.due_at);
    const due = task.due_at ? ` (due ${task.due_at})` : "";
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

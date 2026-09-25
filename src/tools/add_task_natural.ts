import { z } from "zod";
import { addTask } from "../db.js";
import { timeContext, toStoredDue } from "../dates.js";
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
  "due_at": "<local date-time YYYY-MM-DDTHH:MM, or null>"
}

Rules:
- "text" is the action, cleaned of date/time phrasing.
- "due_at" is the user's local time, with no offset or Z, or null if no time is implied. Take weekdays and "tomorrow" from the dates listed below.
- A weekday means its next occurrence; if that is today and the time has already passed, the one a week later.
- If a date is given without a time, use 09:00.
- If only a time is given, use today (or tomorrow if that time has passed).`;

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
      { role: "user", content: `${timeContext()}\n\nPhrase: ${input}` },
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
    due_at: typeof parsed.due_at === "string" ? toStoredDue(parsed.due_at) : null,
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

import { z } from "zod";
import { addTaskUnique } from "../db.js";
import { describeDue, resolveDue } from "../dates.js";
import { contextSchema, fromTool, type ToolContext } from "../provenance.js";
import { alreadyListed } from "./duplicate.js";

export const scheduleEventSchema = {
  title: z.string().min(1).describe("Event title"),
  start: z
    .string()
    .describe(
      "When it starts, in the user's own words ('Friday 3pm', 'tomorrow at 10am'); StickyInc works " +
        "out the date in their time zone. Or ISO 8601: with Z or an offset it's exact, without one local."
    ),
  end: z.string().optional().describe("Optional end, ISO 8601. Echoed back, not stored."),
  notes: z.string().optional().describe("Optional notes/description"),
  context: contextSchema,
};

/**
 * Creates a dated local task. If you want a real Google Calendar event,
 * ask Claude Desktop's built-in Google Calendar connector in the same turn —
 * StickyInc intentionally doesn't ship its own OAuth flow to keep setup
 * friction-free.
 */
export async function handleScheduleEvent(
  args: {
    title: string;
    start: string;
    end?: string;
    notes?: string;
    context?: ToolContext;
  },
  client: string | null
) {
  const start = resolveDue(args.start);
  if (!start.at) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `start "${args.start}" isn't a date StickyInc can read. Try words like ` +
            `"Friday 3pm", or ISO 8601 (2026-04-24T15:00).`,
        },
      ],
      isError: true,
    };
  }
  const text = args.notes ? `${args.title} — ${args.notes}` : args.title;
  const { task, inserted } = addTaskUnique({
    text,
    due: start,
    source: "calendar",
    from: fromTool(client, args.context),
  });
  if (!inserted) return { content: [{ type: "text" as const, text: alreadyListed(task) }] };
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Scheduled task #${task.id}: ${args.title}, ${describeDue(start)}` +
          (args.end ? ` → ${args.end}` : "") +
          `\n(If you want this on your Google Calendar too, ask me in the same ` +
          `turn — I'll use my Google Calendar connector. StickyInc only stores ` +
          `it locally.)`,
      },
    ],
  };
}

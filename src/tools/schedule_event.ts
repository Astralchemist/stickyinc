import { z } from "zod";
import { addTask } from "../db.js";
import { toStoredDue } from "../dates.js";

export const scheduleEventSchema = {
  title: z.string().min(1).describe("Event title"),
  start: z
    .string()
    .describe(
      "Start, ISO 8601. With Z or an offset it's exact ('2026-04-24T15:00:00Z'); without one it's the user's local time."
    ),
  end: z.string().optional().describe("Optional end, ISO 8601. Echoed back, not stored."),
  notes: z.string().optional().describe("Optional notes/description"),
};

/**
 * Creates a dated local task. If you want a real Google Calendar event,
 * ask Claude Desktop's built-in Google Calendar connector in the same turn —
 * StickyInc intentionally doesn't ship its own OAuth flow to keep setup
 * friction-free.
 */
export async function handleScheduleEvent(args: {
  title: string;
  start: string;
  end?: string;
  notes?: string;
}) {
  const start = toStoredDue(args.start);
  if (!start) {
    return {
      content: [
        {
          type: "text" as const,
          text: `start "${args.start}" isn't a date/time. Use ISO 8601, e.g. 2026-04-24T15:00:00Z.`,
        },
      ],
      isError: true,
    };
  }
  const text = args.notes ? `${args.title} — ${args.notes}` : args.title;
  const task = addTask(text, start, "calendar");
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Scheduled task #${task.id}: ${args.title} @ ${start}` +
          (args.end ? ` → ${args.end}` : "") +
          `\n(If you want this on your Google Calendar too, ask me in the same ` +
          `turn — I'll use my Google Calendar connector. StickyInc only stores ` +
          `it locally.)`,
      },
    ],
  };
}

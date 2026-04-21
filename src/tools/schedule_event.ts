import { z } from "zod";
import { addTask } from "../db.js";

export const scheduleEventSchema = {
  title: z.string().min(1).describe("Event title"),
  start: z.string().describe("ISO 8601 start datetime, e.g. '2026-04-24T15:00:00Z'"),
  end: z.string().optional().describe("ISO 8601 end datetime (optional)"),
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
  const text = args.notes ? `${args.title} — ${args.notes}` : args.title;
  const task = addTask(text, args.start, "calendar");
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Scheduled task #${task.id}: ${args.title} @ ${args.start}` +
          (args.end ? ` → ${args.end}` : "") +
          `\n(If you want this on your Google Calendar too, ask me in the same ` +
          `turn — I'll use my Google Calendar connector. StickyInc only stores ` +
          `it locally.)`,
      },
    ],
  };
}

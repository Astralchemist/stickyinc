import { z } from "zod";
import { addTask } from "../db.js";
import { createCalendarEvent, isGoogleAuthorized } from "../google.js";

export const scheduleEventSchema = {
  title: z.string().min(1).describe("Event title"),
  start: z.string().describe("ISO 8601 start datetime, e.g. '2026-04-24T15:00:00Z'"),
  end: z.string().optional().describe("ISO 8601 end datetime (optional, defaults to +30 min)"),
  notes: z.string().optional().describe("Optional notes/description"),
};

export async function handleScheduleEvent(args: {
  title: string;
  start: string;
  end?: string;
  notes?: string;
}) {
  const textForTask = args.notes ? `${args.title} — ${args.notes}` : args.title;
  const task = addTask(textForTask, args.start, "calendar");

  if (!isGoogleAuthorized()) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Scheduled StickyInc task #${task.id}: ${args.title} @ ${args.start}` +
            (args.end ? ` → ${args.end}` : "") +
            `\n(Google Calendar not connected — task saved locally only.\n` +
            ` Run \`pnpm stickyinc-auth\` to enable calendar sync.)`,
        },
      ],
    };
  }

  try {
    const event = await createCalendarEvent({
      summary: args.title,
      description: args.notes,
      start: args.start,
      end: args.end,
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `✓ StickyInc #${task.id} + Google Calendar event created.\n` +
            `  ${args.title} @ ${args.start}\n` +
            `  ${event.htmlLink}`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Scheduled StickyInc task #${task.id} locally, but Google Calendar call failed:\n${msg}`,
        },
      ],
      isError: true,
    };
  }
}

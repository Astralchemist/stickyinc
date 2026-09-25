import { z } from "zod";
import { addTask } from "../db.js";
import { describeDue, resolveDue } from "../dates.js";

export const addTaskSchema = {
  text: z.string().min(1).describe("The task text, e.g. 'Call the dentist'"),
  due_at: z
    .string()
    .optional()
    .describe(
      "Optional: when it's due, in the user's own words ('tomorrow', 'Friday 3pm', 'in 2 hours', " +
        "'next week'). Don't work out the date yourself; StickyInc does, in the user's time zone. " +
        "Add am/pm to a bare hour. ISO 8601 works too: with Z or an offset it's exact, without one " +
        "it's local time. No time of day means 09:00 local."
    ),
};

export async function handleAddTask(args: { text: string; due_at?: string }) {
  const due = args.due_at ? resolveDue(args.due_at) : null;
  if (due && !due.at) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `due_at "${args.due_at}" isn't a date StickyInc can read. Try words like ` +
            `"Friday 5pm" or "in 3 days", or ISO 8601 (2026-04-24T17:00).`,
        },
      ],
      isError: true,
    };
  }
  const task = addTask(args.text, due);
  const dueText = due ? `, ${describeDue(due)}` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Added task #${task.id}: ${task.text}${dueText}`,
      },
    ],
  };
}

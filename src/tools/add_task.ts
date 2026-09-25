import { z } from "zod";
import { addTask } from "../db.js";
import { toStoredDue } from "../dates.js";

export const addTaskSchema = {
  text: z.string().min(1).describe("The task text, e.g. 'Call the dentist'"),
  due_at: z
    .string()
    .optional()
    .describe(
      "Optional due date/time, ISO 8601. With Z or an offset it's exact ('2026-04-24T15:00:00Z'); " +
        "without one it's the user's local time ('2026-04-24T15:00'); a date alone means 09:00 local."
    ),
};

export async function handleAddTask(args: { text: string; due_at?: string }) {
  const dueAt = args.due_at ? toStoredDue(args.due_at) : null;
  if (args.due_at && !dueAt) {
    return {
      content: [
        {
          type: "text" as const,
          text: `due_at "${args.due_at}" isn't a date/time. Use ISO 8601, e.g. 2026-04-24T15:00:00Z.`,
        },
      ],
      isError: true,
    };
  }
  const task = addTask(args.text, dueAt);
  const due = task.due_at ? ` (due ${task.due_at})` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Added task #${task.id}: ${task.text}${due}`,
      },
    ],
  };
}

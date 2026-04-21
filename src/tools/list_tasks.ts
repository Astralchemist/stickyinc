import { z } from "zod";
import { countDoneToday, listAllTasks, listOpenTasks } from "../db.js";

export const listTasksSchema = {
  include_completed: z
    .boolean()
    .optional()
    .describe("If true, include completed tasks. Default: false (open tasks only)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max number of rows when include_completed is true. Default: 50."),
};

export async function handleListTasks(args: {
  include_completed?: boolean;
  limit?: number;
}) {
  const tasks = args.include_completed
    ? listAllTasks(args.limit ?? 50)
    : listOpenTasks();

  if (tasks.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No tasks." }],
    };
  }

  const lines = tasks.map((t) => {
    const mark = t.completed_at ? "[x]" : "[ ]";
    const due = t.due_at ? ` — due ${t.due_at}` : "";
    return `${mark} #${t.id} ${t.text}${due}`;
  });

  // Done-today feedback: silently surface what the user has already finished
  // today so Claude's next turn knows the state without being told.
  const doneToday = countDoneToday();
  if (doneToday > 0) {
    lines.push("");
    lines.push(`(Done today: ${doneToday})`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

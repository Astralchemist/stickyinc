import { z } from "zod";
import { completeTask, getTask } from "../db.js";

export const completeTaskSchema = {
  id: z.number().int().positive().describe("The task id to mark complete"),
};

export async function handleCompleteTask(args: { id: number }) {
  const task = completeTask(args.id);
  if (!task) {
    const existing = getTask(args.id);
    const msg = existing
      ? `Task #${args.id} was already completed at ${existing.completed_at}.`
      : `No task with id #${args.id}.`;
    return {
      content: [{ type: "text" as const, text: msg }],
      isError: true,
    };
  }
  return {
    content: [
      { type: "text" as const, text: `Completed #${task.id}: ${task.text}` },
    ],
  };
}

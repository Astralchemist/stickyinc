import { z } from "zod";
import { completeTask } from "../db.js";

export const completeTaskSchema = {
  id: z.number().int().positive().describe("The task id to mark complete"),
};

export async function handleCompleteTask(args: { id: number }) {
  const result = completeTask(args.id);
  if (!result || !result.completed) {
    const msg = result
      ? `Task #${args.id} was already completed at ${result.task.completed_at}.`
      : `No task with id #${args.id}.`;
    return {
      content: [{ type: "text" as const, text: msg }],
      isError: true,
    };
  }
  const { task } = result;
  return {
    content: [
      { type: "text" as const, text: `Completed #${task.id}: ${task.text}` },
    ],
  };
}

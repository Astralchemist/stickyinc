import { z } from "zod";
import { addTask } from "../db.js";

export const addTaskSchema = {
  text: z.string().min(1).describe("The task text, e.g. 'Call the dentist'"),
  due_at: z
    .string()
    .optional()
    .describe("Optional ISO 8601 datetime when this is due, e.g. '2026-04-24T15:00:00Z'"),
};

export async function handleAddTask(args: { text: string; due_at?: string }) {
  const task = addTask(args.text, args.due_at ?? null);
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

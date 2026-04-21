import { z } from "zod";
import { listArchived, listRecentlyCompleted } from "../db.js";

export const listDoneSchema = {
  hours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .optional()
    .describe("Show tasks completed within the last N hours. Default: 24."),
  include_archive: z
    .boolean()
    .optional()
    .describe("Also include older completions (up to 100 rows). Default: false."),
};

export async function handleListDone(args: {
  hours?: number;
  include_archive?: boolean;
}) {
  const hours = args.hours ?? 24;
  const recent = listRecentlyCompleted(hours);
  const older = args.include_archive ? listArchived(hours, 100) : [];

  if (recent.length === 0 && older.length === 0) {
    return { content: [{ type: "text" as const, text: `No tasks completed in the last ${hours}h.` }] };
  }

  const lines: string[] = [];
  if (recent.length > 0) {
    lines.push(`Done in last ${hours}h (${recent.length}):`);
    for (const t of recent) {
      lines.push(`  [x] #${t.id} ${t.text}  — ${t.completed_at}`);
    }
  }
  if (older.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Archive (older, ${older.length} shown):`);
    for (const t of older) {
      lines.push(`  [x] #${t.id} ${t.text}  — ${t.completed_at}`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

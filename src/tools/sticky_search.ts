import { z } from "zod";
import { searchTasks } from "../db.js";
import { describeDue, resolveSince } from "../dates.js";
import type { Task } from "../types.js";

const MAX_RESULTS = 20;

export const stickySearchSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Words to look for in the task or in what the user said when it was added, e.g. 'dentist'. " +
        "Leave out to list by status and date alone."
    ),
  status: z
    .enum(["open", "done", "all"])
    .optional()
    .describe("open (not done yet), done, or all. Default: all."),
  since: z
    .string()
    .optional()
    .describe(
      "Only tasks added since then: the user's words ('3 weeks ago', 'last month', 'September 1') or ISO 8601."
    ),
};

/** SQLite's datetime('now') (UTC, no zone) as local "Thu, Sep 4". */
function addedOn(sqliteUtc: string): string {
  return new Date(sqliteUtc.replace(" ", "T") + "Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "3 weeks ago": how long ago in words, so Claude can say it the same way. */
function ago(sqliteUtc: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(sqliteUtc.replace(" ", "T") + "Z").getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

function describe(t: Task): string {
  const mark = t.completed_at ? "[x]" : "[ ]";
  const from = t.source_client ? ` from ${t.source_client}` : "";
  const due = t.due_at
    ? ` — ${describeDue({ at: t.due_at, phrase: t.due_phrase ?? t.due_at, ref: "" })}`
    : "";
  const line = `${mark} #${t.id} ${t.text} — added ${addedOn(t.created_at)} (${ago(t.created_at)})${from}${due}`;
  return t.source_excerpt ? `${line}\n    “${t.source_excerpt}”` : line;
}

export async function handleStickySearch(args: {
  query?: string;
  status?: "open" | "done" | "all";
  since?: string;
}) {
  const since = args.since ? resolveSince(args.since) : undefined;
  if (args.since && !since) {
    return {
      content: [
        {
          type: "text" as const,
          text: `since "${args.since}" isn't a date StickyInc can read. Try "3 weeks ago", "last month", or 2026-09-01.`,
        },
      ],
      isError: true,
    };
  }

  // One extra row says whether there are more than we show.
  const rows = searchTasks({ query: args.query, status: args.status, since: since ?? undefined, limit: MAX_RESULTS + 1 });
  const what = [
    args.query ? `matching "${args.query}"` : null,
    args.status && args.status !== "all" ? `${args.status}` : null,
    args.since ? `added since ${args.since}` : null,
  ].filter(Boolean).join(", ");

  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: `No tasks${what ? ` ${what}` : ""}.` }] };
  }
  const shown = rows.slice(0, MAX_RESULTS);
  const more = rows.length > MAX_RESULTS ? `\n\n(More than ${MAX_RESULTS} match; narrow the search to see the rest.)` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `${shown.length} task${shown.length === 1 ? "" : "s"}${what ? ` ${what}` : ""}:\n\n${shown.map(describe).join("\n")}${more}`,
      },
    ],
  };
}

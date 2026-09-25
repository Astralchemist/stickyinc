import { z } from "zod";
import { searchTasks } from "../db.js";
import { resolveSince } from "../dates.js";
import { describeTask } from "../format.js";

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
        text: `${shown.length} task${shown.length === 1 ? "" : "s"}${what ? ` ${what}` : ""}:\n\n${shown.map((t) => describeTask(t)).join("\n")}${more}`,
      },
    ],
  };
}

import { z } from "zod";

/** Where a task came from, shown when the user hovers over it in the pane. */
export interface Provenance {
  /** The app it came from, as the user would name it ("Claude Code"). */
  client: string | null;
  /** A pointer back to the source: a transcript message, file, URL, ticket. */
  ref: string | null;
  /** The words it came from, capped at EXCERPT_MAX characters. */
  excerpt: string | null;
}

export const EXCERPT_MAX = 200;
const REF_MAX = 500;

/** The optional `context` argument of the tools that add tasks. */
export const contextSchema = z
  .object({
    excerpt: z
      .string()
      .optional()
      .describe(
        "The user's words this task came from, quoted exactly as they said them, e.g. " +
          "'I really need to call the dentist before Friday'. The pane shows it when they hover " +
          `over the task, so they can see why it's there. Kept to ${EXCERPT_MAX} characters.`
      ),
    ref: z
      .string()
      .optional()
      .describe("Where it came from, if there's a pointer to it: a file path, URL, ticket, or email subject."),
  })
  .optional()
  .describe("Where this task came from. Include it whenever you can: tasks nobody recognizes get deleted.");

/**
 * Whitespace collapsed, cut to `max` characters (not UTF-16 units, so an
 * emoji isn't split) with an ellipsis if it was longer; null if empty.
 */
export function cap(s: string | undefined | null, max: number): string | null {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

// Clients that don't send a display `title` in the MCP handshake.
const CLIENT_NAMES: Record<string, string> = {
  "claude-ai": "Claude Desktop",
  "cursor-vscode": "Cursor",
};

/** The MCP client's name as the user knows it, from its initialize handshake. */
export function clientLabel(info: { name: string; title?: string } | undefined): string | null {
  if (!info) return null;
  return info.title || CLIENT_NAMES[info.name] || info.name;
}

/** Provenance for a task added through an MCP tool. */
export function fromTool(
  client: string | null,
  context: { excerpt?: string; ref?: string } | undefined
): Provenance {
  return {
    client,
    ref: cap(context?.ref, REF_MAX),
    excerpt: cap(context?.excerpt, EXCERPT_MAX),
  };
}

export type ToolContext = z.infer<typeof contextSchema>;

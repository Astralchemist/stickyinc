#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { addTaskSchema, handleAddTask } from "./tools/add_task.js";
import { addTaskNaturalSchema, handleAddTaskNatural } from "./tools/add_task_natural.js";
import { listTasksSchema, handleListTasks } from "./tools/list_tasks.js";
import { completeTaskSchema, handleCompleteTask } from "./tools/complete_task.js";
import { scheduleEventSchema, handleScheduleEvent } from "./tools/schedule_event.js";
import { listDoneSchema, handleListDone } from "./tools/list_done.js";
import { stickySearchSchema, handleStickySearch } from "./tools/sticky_search.js";
import { clientLabel } from "./provenance.js";
import { searchTasks } from "./db.js";
import { morningReview, overdueReview, weeklyCloseout } from "./prompts.js";

const server = new McpServer({
  name: "stickyinc",
  version: "0.5.2",
});

/** The connected app, from the MCP handshake; tasks record it as provenance. */
const client = () => clientLabel(server.server.getClientVersion());

server.registerTool(
  "add_task",
  {
    title: "Add Task",
    description:
      "Add a todo to StickyInc. The user sees it appear in their floating pane, and hovering " +
      "over it shows context.excerpt: quote their words so they can tell where it came from.",
    inputSchema: addTaskSchema,
  },
  (args) => handleAddTask(args, client())
);

server.registerTool(
  "add_task_natural",
  {
    title: "Add Task (natural language)",
    description:
      "Parse a free-text phrase like 'call dentist Friday 3pm' into a task with optional due date, using the configured LLM (Anthropic/OpenRouter/OpenAI).",
    inputSchema: addTaskNaturalSchema,
  },
  (args) => handleAddTaskNatural(args, client())
);

server.registerTool(
  "list_tasks",
  {
    title: "List Tasks",
    description: "List open StickyInc tasks (or all, with include_completed=true).",
    inputSchema: listTasksSchema,
  },
  handleListTasks
);

server.registerTool(
  "complete_task",
  {
    title: "Complete Task",
    description: "Mark a StickyInc task done by id.",
    inputSchema: completeTaskSchema,
  },
  handleCompleteTask
);

server.registerTool(
  "list_done",
  {
    title: "List Done",
    description:
      "List recently completed StickyInc tasks, with optional archive of older completions.",
    inputSchema: listDoneSchema,
  },
  handleListDone
);

server.registerTool(
  "schedule_event",
  {
    title: "Schedule Event",
    description:
      "Save an event as a StickyInc task due at its start time. StickyInc doesn't sync calendars; use a calendar connector for that.",
    inputSchema: scheduleEventSchema,
  },
  (args) => handleScheduleEvent(args, client())
);

server.registerTool(
  "sticky_search",
  {
    title: "Search Tasks",
    description:
      "Search everything the user has put in StickyInc, open and done, by words in the task or in " +
      "what they said when it was added, optionally only since a date. Use it to remind them what " +
      "they committed to and when, e.g. \"you said you'd call the dentist three weeks ago\". " +
      "Returns up to 20 tasks, best match first.",
    inputSchema: stickySearchSchema,
  },
  handleStickySearch
);

// Canned prompts (src/prompts.ts): the user's tasks, fetched the way
// sticky_search fetches them, with a request that ends in an action list.
const openTasks = () => searchTasks({ status: "open", limit: 500 });
const asPrompt = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

server.registerPrompt(
  "morning_review",
  {
    title: "Morning review",
    description: "Go through today's StickyInc list (overdue, due today, this week) and end with an action list for today.",
  },
  () => asPrompt(morningReview(openTasks()))
);

server.registerPrompt(
  "overdue",
  {
    title: "Overdue",
    description: "Decide what to do about each overdue StickyInc task (do now, reschedule, or drop), ending with an action list.",
  },
  () => asPrompt(overdueReview(openTasks()))
);

server.registerPrompt(
  "weekly_closeout",
  {
    title: "Weekly close-out",
    description: "Review the week in StickyInc (done, slipped, due next) and end with an action list for next week.",
  },
  () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const done = searchTasks({ status: "done", completedSince: weekAgo, limit: 200 });
    return asPrompt(weeklyCloseout(openTasks(), done));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

#!/usr/bin/env node
import { runWatcher } from "./watcher.js";

const args = process.argv.slice(2);
const opts = {
  includeAssistant: args.includes("--assistant") || args.includes("-a"),
  includeUser: !args.includes("--no-user"),
  intervalMs: (() => {
    const i = args.findIndex((a) => a === "--interval" || a === "-i");
    if (i >= 0 && args[i + 1]) return Math.max(500, Number(args[i + 1]) || 3000);
    return 3000;
  })(),
  verbose: !args.includes("--quiet") && !args.includes("-q"),
};

runWatcher(opts).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

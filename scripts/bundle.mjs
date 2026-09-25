// Bundle the MCP server and the passive watcher into single files with no
// node_modules, which the pane ships and runs with the user's own `node`
// (see bundle.resources in pane/src-tauri/tauri.conf.json). They're also the
// npm package's bins, so `npx stickyinc` installs nothing else.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "info" };
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/bundle/stickyinc-mcp.mjs" });
await build({ ...common, entryPoints: ["src/watch-cli.ts"], outfile: "dist/bundle/stickyinc-watch.mjs" });

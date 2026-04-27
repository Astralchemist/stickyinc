import { spawn } from "node:child_process";
import type { ChatOptions, ChatResult, LLMProvider } from "./types.js";
import { whichBinary } from "./which.js";

/**
 * Locate the `claude` CLI on PATH. Returns the absolute path, or null if
 * Claude Code isn't installed. Sync because PATH is effectively static for
 * the lifetime of the process, and resolveLLMProvider() is itself sync.
 */
export function findClaudeBinary(): string | null {
  return whichBinary("claude");
}

interface ClaudeCodeConfig {
  binary: string;
  model?: string;
}

/**
 * Shells out to the user's local `claude -p` (Claude Code print mode).
 * Requests run under the user's Claude Max / Claude Code subscription —
 * no API key needed on our side, no token harvesting, no ToS grey area.
 *
 * Tradeoff: each call spawns a subprocess (~500ms–1s of startup), which
 * is fine for interactive quick-add and the passive-extraction daemon,
 * but not suitable for tight loops. Callers that need sub-100ms latency
 * should configure a direct API provider (Anthropic/OpenRouter) instead.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = "claude-code";
  readonly model: string;
  private binary: string;

  constructor(cfg: ClaudeCodeConfig) {
    this.binary = cfg.binary;
    this.model = cfg.model ?? "haiku";
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const prompt = mergePrompt(opts);
    const args = ["-p", "--output-format", "text"];
    if (this.model) args.push("--model", this.model);

    return new Promise<ChatResult>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (out += chunk));
      child.stderr.on("data", (chunk: string) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          const stderrSnip = err.trim().slice(0, 400);
          const stdoutSnip = out.trim().slice(0, 400);
          reject(
            new Error(
              `claude -p exited ${code}: ${stderrSnip || stdoutSnip || "(no output)"}`,
            ),
          );
          return;
        }
        resolve({
          content: out.trim(),
          model: this.model,
          provider: this.name,
        });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/**
 * `claude -p` takes a single prompt string, not a message sequence. Both
 * StickyInc callers use the shape (system + one user turn), so we flatten
 * system → user content with a blank line between them. The existing JSON
 * extraction in add_task_natural / watcher tolerates leading prose or
 * fenced output, so no response-format coercion is needed here.
 */
function mergePrompt(opts: ChatOptions): string {
  const parts: string[] = [];
  if (opts.system) parts.push(opts.system);
  for (const m of opts.messages) {
    if (m.role === "user") parts.push(m.content);
    else parts.push(`[previous assistant reply]\n${m.content}`);
  }
  return parts.join("\n\n");
}

import { spawn } from "node:child_process";
import type { ChatOptions, ChatResult, LLMProvider } from "./types.js";
import { whichBinary } from "./which.js";

/**
 * Locate the `gemini` CLI (Google Gemini CLI) on PATH. Returns the
 * absolute path, or null if it's not installed.
 */
export function findGeminiBinary(): string | null {
  return whichBinary("gemini");
}

interface GeminiConfig {
  binary: string;
  model?: string;
}

/**
 * Shells out to the user's local `gemini -p` (Google Gemini CLI, print mode).
 * Requests run under the user's Google account — Gemini Advanced quota if
 * they have it, free tier otherwise. No API key on our side.
 *
 * Subprocess overhead is ~1s per call, same tradeoff as claude-code / codex.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  private binary: string;
  private explicitModel: string | null;

  constructor(cfg: GeminiConfig) {
    this.binary = cfg.binary;
    this.model = cfg.model ?? "gemini-default";
    this.explicitModel = cfg.model ?? null;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const prompt = mergePrompt(opts);
    const args: string[] = [];
    if (this.explicitModel) args.push("--model", this.explicitModel);
    args.push("-p", prompt);

    return new Promise<ChatResult>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
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
              `gemini -p exited ${code}: ${stderrSnip || stdoutSnip || "(no output)"}`,
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
    });
  }
}

function mergePrompt(opts: ChatOptions): string {
  const parts: string[] = [];
  if (opts.system) parts.push(opts.system);
  for (const m of opts.messages) {
    if (m.role === "user") parts.push(m.content);
    else parts.push(`[previous assistant reply]\n${m.content}`);
  }
  return parts.join("\n\n");
}

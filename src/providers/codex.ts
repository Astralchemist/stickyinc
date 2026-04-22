import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ChatOptions, ChatResult, LLMProvider } from "./types.js";

/**
 * Locate the `codex` CLI (OpenAI Codex) on PATH. Returns the absolute path,
 * or null if it's not installed. Sync for the same reason findClaudeBinary
 * is sync: PATH is static for the process lifetime.
 */
export function findCodexBinary(): string | null {
  const paths = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of paths) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, "codex" + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

interface CodexConfig {
  binary: string;
  model?: string;
}

/**
 * Shells out to the user's local `codex exec` (OpenAI Codex CLI).
 * Requests run under the user's ChatGPT Plus / Pro / Team subscription —
 * no OpenAI API key on our side. Subprocess overhead is ~1s per call;
 * fine for interactive quick-add and the passive-extraction daemon, not
 * suitable for tight loops.
 *
 * We capture Codex's final assistant message via `--output-last-message`
 * (a temp file), which is stable across Codex versions — parsing
 * status-interleaved stdout is brittle.
 */
export class CodexProvider implements LLMProvider {
  readonly name = "codex";
  readonly model: string;
  private binary: string;
  private explicitModel: string | null;

  constructor(cfg: CodexConfig) {
    this.binary = cfg.binary;
    this.model = cfg.model ?? "chatgpt-default";
    this.explicitModel = cfg.model ?? null;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const prompt = mergePrompt(opts);
    const tmpDir = mkdtempSync(join(tmpdir(), "stickyinc-codex-"));
    const outFile = join(tmpDir, "last.txt");

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
    ];
    if (this.explicitModel) args.push("--model", this.explicitModel);
    args.push(prompt);

    const cleanup = () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

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
      child.on("error", (e) => {
        cleanup();
        reject(e);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          cleanup();
          const stderrSnip = err.trim().slice(0, 400);
          const stdoutSnip = out.trim().slice(0, 400);
          reject(
            new Error(
              `codex exec exited ${code}: ${stderrSnip || stdoutSnip || "(no output)"}`,
            ),
          );
          return;
        }
        let content = "";
        try {
          content = readFileSync(outFile, "utf8").trim();
        } catch {
          content = out.trim();
        }
        cleanup();
        resolve({
          content,
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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Resolve a CLI name to an absolute path on disk, or null if it isn't
 * installed. Used by every subscription provider (claude / codex / gemini).
 *
 * Two-tier lookup: the standard PATH walk first, then on macOS only a login
 * shell fallback. Apps launched from Finder/Dock/Spotlight don't inherit the
 * shell PATH from ~/.zshrc / ~/.bashrc — they get a stripped
 * `/usr/bin:/bin:/usr/sbin:/sbin` and miss user-installed binaries under
 * ~/.npm-global, /opt/homebrew, ~/.local, etc. Linux GUI launchers usually
 * inherit PATH; Windows doesn't have this problem.
 */
export function whichBinary(name: string): string | null {
  const paths = (process.env.PATH ?? "").split(delimiter);
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of paths) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }

  if (process.platform !== "darwin") return null;
  if (!NAME_PATTERN.test(name)) return null;

  try {
    const result = spawnSync("/bin/sh", ["-lc", `command -v ${name}`], {
      timeout: 1000,
      encoding: "utf8",
    });
    if (result.status === 0) {
      const resolved = (result.stdout ?? "").trim();
      if (resolved.length > 0) return resolved;
    }
  } catch {
    // best-effort; fall through to null
  }
  return null;
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

const NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Directories CLI installers commonly use that a GUI-launched process's PATH
 * lacks. Checked directly so the common cases don't need a shell at all.
 */
function wellKnownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"), // Claude Code's native installer, codex, pipx, uv
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
  ];
}

/**
 * Resolve a CLI name to an absolute path on disk, or null if it isn't
 * installed. Used by every subscription provider (claude / codex / gemini).
 *
 * Apps launched from Finder/Dock/Spotlight get a stripped
 * `/usr/bin:/bin:/usr/sbin:/sbin` PATH, so after the PATH walk we check the
 * usual install dirs, then (macOS) ask the user's own shell as a login +
 * interactive shell — that is what reads ~/.zprofile and ~/.zshrc, where
 * Homebrew, nvm, asdf and installers add to PATH. (`/bin/sh -l` reads
 * neither.) Linux GUI launchers usually inherit PATH; Windows doesn't have
 * this problem.
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

  if (process.platform === "win32") return null;
  for (const dir of wellKnownDirs()) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }

  if (process.platform !== "darwin") return null;
  if (!NAME_PATTERN.test(name)) return null;

  try {
    const shell = userInfo().shell || process.env.SHELL || "/bin/zsh";
    const result = spawnSync(shell, ["-ilc", `command -v ${name}`], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Interactive rc files can print banners; the answer is the last line
    // that is an existing absolute path (aliases and functions don't count).
    const lines = (result.stdout ?? "").split("\n").map((l) => l.trim());
    for (const line of lines.reverse()) {
      if (line.startsWith("/") && existsSync(line)) return line;
    }
  } catch {
    // best-effort; fall through to null
  }
  return null;
}

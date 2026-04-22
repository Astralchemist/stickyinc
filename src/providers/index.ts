import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai.js";
import { ClaudeCodeProvider, findClaudeBinary } from "./claude_code.js";
import { CodexProvider, findCodexBinary } from "./codex.js";
import { GeminiProvider, findGeminiBinary } from "./gemini.js";
import { probeLocalProvider } from "./local.js";
import type { LLMProvider } from "./types.js";

export type { ChatMessage, ChatOptions, ChatResult, LLMProvider } from "./types.js";

const CONFIG_PATH = join(homedir(), ".stickyinc", "llm.json");

interface LLMConfig {
  provider:
    | "anthropic"
    | "openrouter"
    | "openai"
    | "compat"
    | "claude-code"
    | "codex"
    | "gemini"
    | "local";
  model?: string;
  api_key?: string;
  base_url?: string;
  extra_headers?: Record<string, string>;
}

function readConfigFile(): LLMConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LLMConfig;
  } catch {
    return null;
  }
}

let cached: LLMProvider | null | undefined;

/**
 * Resolve an LLM provider from (in priority order):
 *   1. ~/.stickyinc/llm.json           — explicit `provider` field wins
 *   2. OPENROUTER_API_KEY              — OpenRouter
 *   3. ANTHROPIC_API_KEY               — Anthropic direct
 *   4. OPENAI_API_KEY                  — OpenAI direct
 *   5. `claude`  CLI on PATH           — Claude Code subscription
 *   6. `codex`   CLI on PATH           — ChatGPT subscription via Codex
 *   7. `gemini`  CLI on PATH           — Google account (Gemini Advanced/free)
 *   8. localhost :11434 or :1234       — Ollama / LM Studio (local, free)
 *
 * Cached for the lifetime of the process so repeated callers don't re-probe
 * localhost each time. Returns null if nothing above is available.
 */
export async function resolveLLMProvider(): Promise<LLMProvider | null> {
  if (cached !== undefined) return cached;
  cached = await resolveInternal();
  return cached;
}

async function resolveInternal(): Promise<LLMProvider | null> {
  const cfg = readConfigFile();

  if (cfg) {
    switch (cfg.provider) {
      case "anthropic": {
        const key = cfg.api_key ?? process.env.ANTHROPIC_API_KEY;
        if (!key) return null;
        return new AnthropicProvider({ api_key: key, model: cfg.model, base_url: cfg.base_url });
      }
      case "openrouter": {
        const key = cfg.api_key ?? process.env.OPENROUTER_API_KEY;
        if (!key) return null;
        return new OpenAICompatProvider({
          api_key: key,
          model: cfg.model ?? "anthropic/claude-3.5-haiku",
          base_url: cfg.base_url ?? "https://openrouter.ai/api/v1",
          provider_label: "openrouter",
          extra_headers: {
            "HTTP-Referer": "https://github.com/Astralchemist/stickyinc",
            "X-Title": "StickyInc",
            ...(cfg.extra_headers ?? {}),
          },
        });
      }
      case "openai": {
        const key = cfg.api_key ?? process.env.OPENAI_API_KEY;
        if (!key) return null;
        return new OpenAICompatProvider({
          api_key: key,
          model: cfg.model ?? "gpt-4o-mini",
          base_url: cfg.base_url ?? "https://api.openai.com/v1",
          provider_label: "openai",
        });
      }
      case "compat": {
        if (!cfg.api_key || !cfg.model || !cfg.base_url) return null;
        return new OpenAICompatProvider({
          api_key: cfg.api_key,
          model: cfg.model,
          base_url: cfg.base_url,
          provider_label: "compat",
          extra_headers: cfg.extra_headers,
        });
      }
      case "claude-code": {
        const binary = findClaudeBinary();
        if (!binary) return null;
        return new ClaudeCodeProvider({ binary, model: cfg.model });
      }
      case "codex": {
        const binary = findCodexBinary();
        if (!binary) return null;
        return new CodexProvider({ binary, model: cfg.model });
      }
      case "gemini": {
        const binary = findGeminiBinary();
        if (!binary) return null;
        return new GeminiProvider({ binary, model: cfg.model });
      }
      case "local": {
        return probeLocalProvider(cfg.model);
      }
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    return new OpenAICompatProvider({
      api_key: process.env.OPENROUTER_API_KEY,
      model: process.env.STICKYINC_MODEL ?? "anthropic/claude-3.5-haiku",
      base_url: "https://openrouter.ai/api/v1",
      provider_label: "openrouter",
      extra_headers: {
        "HTTP-Referer": "https://github.com/Astralchemist/stickyinc",
        "X-Title": "StickyInc",
      },
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({
      api_key: process.env.ANTHROPIC_API_KEY,
      model: process.env.STICKYINC_MODEL,
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAICompatProvider({
      api_key: process.env.OPENAI_API_KEY,
      model: process.env.STICKYINC_MODEL ?? "gpt-4o-mini",
      base_url: "https://api.openai.com/v1",
      provider_label: "openai",
    });
  }

  // Zero-config fallbacks — whatever subscription the user already pays for,
  // or a local server they're already running. Order: Claude (StickyInc's
  // primary persona) → Codex (ChatGPT) → Gemini (Google) → local (Ollama/LM).
  const claudeBin = findClaudeBinary();
  if (claudeBin) {
    return new ClaudeCodeProvider({ binary: claudeBin, model: process.env.STICKYINC_MODEL });
  }
  const codexBin = findCodexBinary();
  if (codexBin) {
    return new CodexProvider({ binary: codexBin, model: process.env.STICKYINC_MODEL });
  }
  const geminiBin = findGeminiBinary();
  if (geminiBin) {
    return new GeminiProvider({ binary: geminiBin, model: process.env.STICKYINC_MODEL });
  }
  const local = await probeLocalProvider(process.env.STICKYINC_MODEL);
  if (local) return local;

  return null;
}

export { CONFIG_PATH as LLM_CONFIG_PATH };

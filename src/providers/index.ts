import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export type { ChatMessage, ChatOptions, ChatResult, LLMProvider } from "./types.js";

const CONFIG_PATH = join(homedir(), ".stickyinc", "llm.json");

interface LLMConfig {
  provider: "anthropic" | "openrouter" | "openai" | "compat";
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

/**
 * Resolve an LLM provider from (in priority order):
 *   1. ~/.stickyinc/llm.json
 *   2. OPENROUTER_API_KEY   — OpenRouter (default model: anthropic/claude-3.5-haiku)
 *   3. ANTHROPIC_API_KEY    — Anthropic direct
 *   4. OPENAI_API_KEY       — OpenAI direct
 *
 * Returns null if nothing is configured (LLM features fail with a clear message).
 */
export function resolveLLMProvider(): LLMProvider | null {
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

  return null;
}

export { CONFIG_PATH as LLM_CONFIG_PATH };

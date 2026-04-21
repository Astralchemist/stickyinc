import type { ChatOptions, ChatResult, LLMProvider } from "./types.js";

interface OpenAICompatConfig {
  api_key: string;
  model: string;
  base_url: string;
  provider_label?: string;
  extra_headers?: Record<string, string>;
}

/**
 * Works with any OpenAI-compatible endpoint:
 * - OpenAI         (api.openai.com/v1)
 * - OpenRouter     (openrouter.ai/api/v1)           ← cheap routed models
 * - Together/Groq/Fireworks/DeepInfra/vLLM/Ollama   (OpenAI-compatible)
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private extraHeaders: Record<string, string>;

  constructor(cfg: OpenAICompatConfig) {
    this.apiKey = cfg.api_key;
    this.model = cfg.model;
    this.baseUrl = cfg.base_url.replace(/\/+$/, "");
    this.name = cfg.provider_label ?? "openai";
    this.extraHeaders = cfg.extra_headers ?? {};
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const messages = [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      ...opts.messages,
    ];
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: opts.max_tokens ?? 1024,
    };
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;
    if (opts.response_format === "json") body.response_format = { type: "json_object" };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${this.name} API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      model?: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: data.choices[0]?.message.content ?? "",
      model: data.model ?? this.model,
      provider: this.name,
      usage: data.usage
        ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
        : undefined,
    };
  }
}

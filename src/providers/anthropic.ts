import type { ChatOptions, ChatResult, LLMProvider } from "./types.js";

interface AnthropicConfig {
  api_key: string;
  model?: string;
  base_url?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.api_key;
    this.model = cfg.model ?? "claude-haiku-4-5-20251001";
    this.baseUrl = cfg.base_url ?? "https://api.anthropic.com";
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.max_tokens ?? 1024,
      messages: opts.messages,
    };
    if (opts.system) body.system = opts.system;
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      content: text,
      model: data.model,
      provider: this.name,
      usage: { input: data.usage.input_tokens, output: data.usage.output_tokens },
    };
  }
}

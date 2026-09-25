export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  system?: string;
  messages: ChatMessage[];
  response_format?: "json" | "text";
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: string;
  usage?: { input: number; output: number };
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(opts: ChatOptions): Promise<ChatResult>;
}

/**
 * Upper bound for one chat call, HTTP or subprocess. Without it a hung
 * provider stalls the watcher loop and the add_task_natural tool call
 * forever. Generous because CLI providers (codex especially) can take
 * tens of seconds on a cold start. Override with STICKYINC_LLM_TIMEOUT_MS
 * (e.g. for a large local model on CPU).
 */
export const CHAT_TIMEOUT_MS = Number(process.env.STICKYINC_LLM_TIMEOUT_MS) || 90_000;

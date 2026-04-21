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

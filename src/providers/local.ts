import { OpenAICompatProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

type LocalKind = "ollama" | "lm-studio";

interface LocalEndpoint {
  url: string;
  kind: LocalKind;
}

// Probed in order; first one that answers wins.
const LOCAL_ENDPOINTS: LocalEndpoint[] = [
  { url: "http://127.0.0.1:11434", kind: "ollama" },
  { url: "http://127.0.0.1:1234", kind: "lm-studio" },
];

/**
 * Probe localhost for a running OpenAI-compatible LLM server (Ollama on
 * :11434, LM Studio on :1234). Returns a ready-to-use provider wired to
 * the first endpoint that answers with at least one installed model, or
 * null if nothing responds.
 *
 * Short per-endpoint timeout so the probe doesn't block process startup
 * when the user has no local server running. The returned provider uses
 * the first installed model; callers can pin a different one via
 * STICKYINC_MODEL or ~/.stickyinc/llm.json.
 */
export async function probeLocalProvider(
  overrideModel?: string,
): Promise<LLMProvider | null> {
  for (const ep of LOCAL_ENDPOINTS) {
    const model = await probe(ep);
    if (model) {
      return new OpenAICompatProvider({
        api_key: "local",
        model: overrideModel ?? model,
        base_url: `${ep.url}/v1`,
        provider_label: ep.kind,
      });
    }
  }
  return null;
}

async function probe(ep: LocalEndpoint): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    if (ep.kind === "ollama") {
      const r = await fetch(`${ep.url}/api/tags`, { signal: controller.signal });
      if (!r.ok) return null;
      const data = (await r.json()) as { models?: { name?: string }[] };
      return data.models?.[0]?.name ?? null;
    }
    // lm-studio (and generic OpenAI-compat) — /v1/models lists loaded models
    const r = await fetch(`${ep.url}/v1/models`, { signal: controller.signal });
    if (!r.ok) return null;
    const data = (await r.json()) as { data?: { id?: string }[] };
    return data.data?.[0]?.id ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

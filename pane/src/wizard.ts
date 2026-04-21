import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type StepName = "welcome" | "provider" | "claude" | "watcher" | "done";
const ORDER: StepName[] = ["welcome", "provider", "claude", "watcher", "done"];

type Provider = "anthropic" | "openrouter" | "openai" | "compat";

interface LLMConfig {
  provider: Provider;
  api_key: string;
  base_url?: string;
  model?: string;
}

interface ClaudeDiff {
  state: "new" | "same" | "conflict";
  existing?: string;
  proposed: string;
  pretty: string;
}

const state = {
  current: "welcome" as StepName,
  llm: null as LLMConfig | null,
  claudeDiff: null as ClaudeDiff | null,
  claudeResolution: "replace" as "replace" | "skip" | "edit",
};

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing: ${sel}`);
  return el as HTMLElement;
}

function goto(step: StepName): void {
  document.querySelectorAll<HTMLElement>("section.step").forEach((el) => {
    el.hidden = el.dataset.step !== step;
  });

  const idx = ORDER.indexOf(step);
  document.querySelectorAll<HTMLElement>(".dot").forEach((el) => {
    const iEl = ORDER.indexOf(el.dataset.dot as StepName);
    el.classList.toggle("active", iEl === idx);
    el.classList.toggle("done", iEl < idx);
  });

  state.current = step;

  if (step === "claude") void loadClaudeDiff();
}

function provider(): Provider {
  const sel = document.querySelector<HTMLInputElement>('input[name="provider"]:checked');
  return (sel?.value as Provider) ?? "anthropic";
}

function refreshProviderFields(): void {
  const p = provider();
  const baseUrl = document.querySelector<HTMLElement>('[data-field="baseUrl"]');
  const model = document.querySelector<HTMLElement>('[data-field="model"]');
  if (baseUrl) baseUrl.hidden = p !== "compat";
  if (model) model.hidden = p === "anthropic";

  const note = $("#provider-note");
  const messages: Record<Provider, string> = {
    anthropic: 'No key? <a href="#" data-link="https://console.anthropic.com/">Sign up at Anthropic →</a>',
    openrouter: 'No key? <a href="#" data-link="https://openrouter.ai/keys">Get one free from OpenRouter →</a>',
    openai: 'No key? <a href="#" data-link="https://platform.openai.com/api-keys">Get one from OpenAI →</a>',
    compat: 'Any OpenAI-compatible endpoint works — Ollama, vLLM, Groq, Together, Fireworks.',
  };
  note.innerHTML = messages[p];
}

async function validateAndContinue(): Promise<void> {
  const p = provider();
  const keyInput = $("#llm-key") as HTMLInputElement;
  const baseUrl = ($("#llm-base-url") as HTMLInputElement).value.trim();
  const model = ($("#llm-model") as HTMLInputElement).value.trim();
  const key = keyInput.value.trim();

  const out = $("#validate-out");
  out.hidden = false;
  out.className = "validate checking";
  out.textContent = "Checking key…";

  const cfg: LLMConfig = {
    provider: p,
    api_key: key,
    ...(baseUrl && { base_url: baseUrl }),
    ...(model && { model }),
  };

  try {
    const result = await invoke<{ ok: boolean; model: string; detail?: string }>(
      "wizard_validate_llm_key",
      { cfg }
    );
    if (!result.ok) {
      out.className = "validate err";
      out.textContent = result.detail ?? "Key rejected by the provider.";
      return;
    }
    out.className = "validate ok";
    out.textContent = `Key works. Responded as ${result.model}.`;
    await invoke("wizard_save_llm_config", { cfg });
    state.llm = cfg;
    setTimeout(() => goto("claude"), 600);
  } catch (err) {
    out.className = "validate err";
    out.textContent = err instanceof Error ? err.message : String(err);
  }
}

function renderDiff(diff: ClaudeDiff): void {
  $("#claude-state").textContent =
    diff.state === "new" ? "not registered yet"
    : diff.state === "same" ? "already registered"
    : "conflicts with existing entry";
  $("#claude-diff").innerHTML = diff.pretty;

  const confirm = $("#claude-confirm") as HTMLButtonElement;
  const conflict = $("#claude-conflict");
  const actions = $("#claude-actions");

  if (diff.state === "same") {
    confirm.textContent = "Already set — continue →";
  } else if (diff.state === "conflict") {
    conflict.hidden = false;
    actions.hidden = true;
  } else {
    conflict.hidden = true;
    actions.hidden = false;
    confirm.textContent = "Add this entry";
  }
}

async function loadClaudeDiff(): Promise<void> {
  $("#claude-state").textContent = "Loading…";
  $("#claude-diff").textContent = "";
  try {
    const diff = await invoke<ClaudeDiff>("wizard_diff_claude_json");
    state.claudeDiff = diff;
    renderDiff(diff);
  } catch (err) {
    $("#claude-state").textContent = "error";
    $("#claude-diff").textContent = err instanceof Error ? err.message : String(err);
  }
}

async function registerClaude(resolution: "add" | "replace" | "skip"): Promise<void> {
  if (resolution === "skip") {
    goto("watcher");
    return;
  }
  try {
    await invoke("wizard_register_mcp", { resolution });
    goto("watcher");
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
}

async function finish(watcherOn: boolean): Promise<void> {
  try {
    await invoke("wizard_set_watcher_enabled", { enabled: watcherOn });
    await invoke("wizard_mark_complete");
  } catch {
    /* non-fatal */
  }
  goto("done");
}

function bind(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach((el) => {
    el.addEventListener("change", refreshProviderFields);
  });
  refreshProviderFields();

  $("#validate-next").addEventListener("click", () => void validateAndContinue());

  document.querySelectorAll<HTMLElement>("[data-go]").forEach((el) => {
    el.addEventListener("click", () => goto(el.dataset.go as StepName));
  });

  $("#claude-confirm").addEventListener("click", () => {
    const diff = state.claudeDiff;
    if (!diff) return;
    if (diff.state === "same") {
      goto("watcher");
      return;
    }
    void registerClaude("add");
  });

  document.querySelectorAll<HTMLElement>("[data-resolve]").forEach((el) => {
    el.addEventListener("click", () => {
      const r = el.dataset.resolve;
      if (r === "skip") void registerClaude("skip");
      else if (r === "replace") void registerClaude("replace");
      else if (r === "edit") {
        goto("provider");
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-watcher]").forEach((el) => {
    el.addEventListener("click", () => finish(el.dataset.watcher === "on"));
  });

  $("#finish").addEventListener("click", () => {
    void invoke("wizard_close");
  });

  // External links open in system browser
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("[data-link]");
    if (a) {
      e.preventDefault();
      const url = (a as HTMLElement).dataset.link;
      if (url) void openUrl(url);
    }
  });
}

bind();
goto("welcome");

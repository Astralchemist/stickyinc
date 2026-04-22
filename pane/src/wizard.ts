import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type StepName = "welcome" | "provider" | "claude" | "watcher" | "done";
const ORDER: StepName[] = ["welcome", "provider", "claude", "watcher", "done"];

type Provider =
  | "anthropic"
  | "openrouter"
  | "openai"
  | "compat"
  | "claude-code"
  | "codex"
  | "gemini"
  | "local";

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

interface DetectedLocal {
  kind: "ollama" | "lm-studio";
  url: string;
  first_model: string;
}

interface SubscriptionDetection {
  claude_code: boolean;
  codex: boolean;
  gemini: boolean;
  local: DetectedLocal | null;
}

const state = {
  current: "welcome" as StepName,
  llm: null as LLMConfig | null,
  claudeDiff: null as ClaudeDiff | null,
  claudeResolution: "replace" as "replace" | "skip" | "edit",
  detected: null as SubscriptionDetection | null,
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

  if (step === "provider") void onEnterProviderStep();
  if (step === "claude") void loadClaudeDiff();
}

/* ─── provider step: subscription detection + BYOK toggle ──────────────── */

async function onEnterProviderStep(): Promise<void> {
  // Detect once per wizard session; the result can't change while the wizard
  // is open (user can't install a CLI from inside the app).
  if (state.detected === null) {
    try {
      state.detected = await invoke<SubscriptionDetection>("wizard_detect_subscriptions");
    } catch {
      state.detected = { claude_code: false, codex: false, gemini: false, local: null };
    }
  }

  const cards = buildDetectedCards(state.detected);
  const list = $("#detected-list");
  list.innerHTML = "";
  for (const card of cards) list.appendChild(card);

  if (cards.length > 0) {
    showBlock("detected");
  } else {
    showBlock("byok");
  }
}

function showBlock(which: "detected" | "byok"): void {
  const detectedWrap = $("#detected-wrap");
  const byokWrap = $("#byok-wrap");
  const toggleByok = $("#toggle-byok");
  const toggleDetected = $("#toggle-detected");
  const validateBtn = $("#validate-next");

  if (which === "detected") {
    detectedWrap.hidden = false;
    byokWrap.hidden = true;
    // Only show "switch to BYOK" link when detected options actually exist.
    toggleByok.hidden = !state.detected || !hasAnyDetected(state.detected);
    toggleDetected.hidden = true;
    validateBtn.hidden = true;
  } else {
    detectedWrap.hidden = true;
    byokWrap.hidden = false;
    toggleByok.hidden = true;
    toggleDetected.hidden = !state.detected || !hasAnyDetected(state.detected);
    validateBtn.hidden = false;
    refreshProviderFields();
  }
}

function hasAnyDetected(d: SubscriptionDetection): boolean {
  return d.claude_code || d.codex || d.gemini || d.local !== null;
}

function buildDetectedCards(d: SubscriptionDetection): HTMLElement[] {
  const cards: HTMLElement[] = [];
  if (d.claude_code) {
    cards.push(makeCard("claude-code", "Claude Code", "Signed in · bills to your Claude Max / Pro"));
  }
  if (d.codex) {
    cards.push(makeCard("codex", "OpenAI Codex CLI", "Signed in · bills to your ChatGPT Plus / Pro / Team"));
  }
  if (d.gemini) {
    cards.push(makeCard("gemini", "Gemini CLI", "Signed in · bills to your Google account"));
  }
  if (d.local) {
    const name = d.local.kind === "ollama" ? "Ollama" : "LM Studio";
    cards.push(
      makeCard("local", `${name} — local`, `${d.local.first_model} · free, offline, no cloud call`),
    );
  }
  return cards;
}

function makeCard(provider: Provider, title: string, sub: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "detected-card";
  btn.dataset.provider = provider;
  btn.innerHTML = `
    <span class="detected-check" aria-hidden="true">✓</span>
    <span class="detected-body">
      <span class="detected-title"></span>
      <span class="detected-sub"></span>
    </span>
    <span class="detected-arrow" aria-hidden="true">→</span>
  `;
  // Avoid innerHTML for user-visible text; keep XSS-safe even for our own strings.
  (btn.querySelector(".detected-title") as HTMLElement).textContent = title;
  (btn.querySelector(".detected-sub") as HTMLElement).textContent = sub;
  btn.addEventListener("click", () => void pickDetected(provider));
  return btn;
}

async function pickDetected(provider: Provider): Promise<void> {
  const cfg: LLMConfig = { provider, api_key: "" };
  // For local, pin the detected model so the runtime picks the same one.
  if (provider === "local" && state.detected?.local) {
    cfg.model = state.detected.local.first_model;
  }
  try {
    await invoke("wizard_save_llm_config", { cfg });
    state.llm = cfg;
    goto("claude");
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
}

/* ─── BYOK flow (existing) ─────────────────────────────────────────────── */

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
  const messages: Partial<Record<Provider, string>> = {
    anthropic: 'No key? <a href="#" data-link="https://console.anthropic.com/">Sign up at Anthropic →</a>',
    openrouter: 'No key? <a href="#" data-link="https://openrouter.ai/keys">Get one free from OpenRouter →</a>',
    openai: 'No key? <a href="#" data-link="https://platform.openai.com/api-keys">Get one from OpenAI →</a>',
    compat: 'Any OpenAI-compatible endpoint works — Ollama, vLLM, Groq, Together, Fireworks.',
  };
  note.innerHTML = messages[p] ?? "";
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
      { cfg },
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

/* ─── claude.json diff + registration (unchanged) ─────────────────────── */

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

/* ─── bindings ─────────────────────────────────────────────────────────── */

function bind(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach((el) => {
    el.addEventListener("change", refreshProviderFields);
  });

  $("#validate-next").addEventListener("click", () => void validateAndContinue());

  $("#toggle-byok").addEventListener("click", (e) => {
    e.preventDefault();
    showBlock("byok");
  });
  $("#toggle-detected").addEventListener("click", (e) => {
    e.preventDefault();
    showBlock("detected");
  });

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

import { invoke } from "@tauri-apps/api/core";

const input = document.getElementById("input") as HTMLInputElement;
const hint = document.getElementById("hint") as HTMLSpanElement;
const originalHint = hint.innerHTML;

async function close(): Promise<void> {
  try {
    await invoke("close_quickadd");
  } catch {
    /* window already closing */
  }
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text) return;
  try {
    const task = (await invoke("add_task_quickadd", { text })) as { id: number; text: string };
    hint.innerHTML = `<span class="flash">✓ added #${task.id}</span>`;
    input.value = "";
    setTimeout(() => close(), 450);
  } catch (err) {
    hint.textContent = String(err);
    setTimeout(() => (hint.innerHTML = originalHint), 2500);
  }
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void submit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void close();
  }
});

window.addEventListener("blur", () => {
  // Close if user clicks elsewhere
  void close();
});

input.focus();

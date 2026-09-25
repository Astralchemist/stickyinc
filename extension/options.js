import { PORT } from "./clip.js";

const code = document.getElementById("code");
const status = document.getElementById("status");

function show(text, ok) {
  status.textContent = text;
  status.className = ok ? "ok" : "err";
}

async function test() {
  const pairingCode = code.value.trim();
  if (!pairingCode) return show("Paste the pairing code first.", false);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`, {
      headers: { Authorization: `Bearer ${pairingCode}` },
    });
    if (res.ok) show("Connected. Right-click any page to stack it.", true);
    else if (res.status === 401) show("StickyInc didn't accept that code. Copy it again from Settings.", false);
    else show(`StickyInc answered with an error (${res.status}).`, false);
  } catch {
    show("Couldn't reach StickyInc. Is the app running?", false);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ pairingCode: code.value.trim() });
  await test();
});
document.getElementById("test").addEventListener("click", test);

chrome.storage.local.get("pairingCode").then(({ pairingCode }) => {
  if (pairingCode) code.value = pairingCode;
});

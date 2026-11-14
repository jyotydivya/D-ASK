const $ = (id) => document.getElementById(id);
async function origin() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); try { return new URL(t.url).origin + "/*"; } catch { return null; } }
async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  const o = await origin();
  const has = o ? await chrome.permissions.contains({ origins: [o] }) : false;
  $("s").textContent = `Connected to D-ASK: ${s.connected ? "yes" : "no"}${s.lastError && !s.connected ? ` (${s.lastError})` : ""}\nAuthorized by you in the HUD: ${s.authorized ? "yes" : "no"}\nThis site: ${o ?? "not a web page"} — ${has ? "allowed" : "not allowed"}`;
}
$("site").onclick = async () => { const o = await origin(); if (o) await chrome.permissions.request({ origins: [o] }); refresh(); };
$("drop").onclick = async () => { const o = await origin(); if (o) await chrome.permissions.remove({ origins: [o] }); refresh(); };
$("re").onclick = async () => { await chrome.runtime.sendMessage({ type: "reconnect" }); setTimeout(refresh, 500); };
refresh();

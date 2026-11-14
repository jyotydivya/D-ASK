// D-ASK Browser Control: service worker.
// Security model (2026-11-14):
//  * The ONLY command channel is the native-messaging port to the D-ASK host ("com.dask.chrome"), which Chrome launches for this
//    extension id only and which relays to the D-ASK daemon over an OS-protected named pipe. There is no externally_connectable entry,
//    no web-accessible resource and no debugging port: web pages cannot send commands.
//  * Commands are accepted only while the daemon has an AUTHORIZED session (the user approved "Let D-ASK control your Chrome" in the
//    HUD). Every command carries that session id; "revoke" (Emergency Stop, the user, or D-ASK shutting down) clears it immediately.
//  * Page access needs a host permission for that site: localhost is built in (local pages), every other site is granted by the user
//    from this extension's popup (least privilege). Tab titles/URLs and navigation need no host permission.
//  * Nothing here reads cookies, passwords, autofill data or browsing history, and password / payment-card fields are never filled.

const HOST = "com.dask.chrome";
let port = null;
let session = null;          // authorized session id from the daemon, or null
let lastError = "";

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    lastError = String(e);
    port = null;
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    lastError = chrome.runtime.lastError?.message ?? "disconnected";
    port = null;
    session = null;          // a new connection always starts unauthorized
  });
  post({ event: "hello", extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
}

function post(msg) {
  try { port?.postMessage(msg); } catch { /* port closed */ }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("dask-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "dask-keepalive") connect(); });
connect();

async function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, cmd, args = {} } = msg;
  const reply = (ok, body) => post(ok ? { id, ok: true, result: body } : { id, ok: false, error: body });
  try {
    if (cmd === "authorize") { session = typeof args.session === "string" && args.session.length >= 32 ? args.session : null; return reply(!!session, session ? { authorized: true } : "bad session"); }
    if (cmd === "revoke") { session = null; return reply(true, { revoked: true }); }
    if (cmd === "status") return reply(true, await status());
    if (!session || msg.session !== session) return reply(false, "not_authorized: D-ASK is not authorized to control this Chrome right now.");
    const handler = HANDLERS[cmd];
    if (!handler) return reply(false, `unknown command ${String(cmd).slice(0, 40)}`);
    reply(true, await handler(args));
  } catch (e) {
    reply(false, String(e && e.message ? e.message : e).slice(0, 500));
  }
}

async function status() {
  const tabs = await chrome.tabs.query({});
  const perms = await chrome.permissions.getAll();
  return { connected: !!port, authorized: !!session, tabCount: tabs.length, grantedOrigins: perms.origins ?? [], extensionVersion: chrome.runtime.getManifest().version };
}

const tabInfo = (t) => ({ tabId: t.id, windowId: t.windowId, title: t.title ?? "", url: t.url ?? t.pendingUrl ?? "", active: !!t.active, status: t.status });

function waitComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); try { resolve(tabInfo(await chrome.tabs.get(tabId))); } catch { resolve(null); } };
    const listener = (id, change) => { if (id === tabId && change.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete" && t.url && t.url !== "about:blank") finish(); }).catch(finish);
  });
}

const allowedUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:"; } catch { return false; } };

async function hasAccess(tabId) {
  const t = await chrome.tabs.get(tabId);
  try { const origin = new URL(t.url).origin + "/*"; return { ok: await chrome.permissions.contains({ origins: [origin] }), origin, url: t.url }; }
  catch { return { ok: false, origin: "", url: t.url }; }
}

async function inPage(tabId, func, args) {
  const access = await hasAccess(tabId);
  if (!access.ok) throw new Error(`no_site_access: D-ASK has no access to ${access.origin || "this page"} yet. Open it, click the D-ASK extension icon and choose "Allow on this site".`);
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [args] });
  return res?.result;
}

const HANDLERS = {
  async listTabs() { return (await chrome.tabs.query({})).map(tabInfo); },
  async openTab({ url, active = true }) {
    if (!allowedUrl(url)) throw new Error("only http(s) addresses can be opened");
    // Chrome may be running with no window (background apps): then a new window is opened for the tab.
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const t = windows.length ? await chrome.tabs.create({ url, active }) : (await chrome.windows.create({ url, focused: true })).tabs[0];
    return await waitComplete(t.id);
  },
  async navigate({ tabId, url }) {
    if (!allowedUrl(url)) throw new Error("only http(s) addresses can be opened");
    await chrome.tabs.update(tabId, { url });
    await new Promise((r) => setTimeout(r, 150));
    return await waitComplete(tabId);
  },
  async activateTab({ tabId }) {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return tabInfo(await chrome.tabs.get(tabId));
  },
  async closeTab({ tabId }) { await chrome.tabs.remove(tabId); return { closed: tabId }; },
  async readPage({ tabId }) { return await inPage(tabId, PAGE.read, {}); },
  async probe({ tabId, target }) { return await inPage(tabId, PAGE.probe, { target }); },
  async click({ tabId, target, fingerprint }) {
    const before = tabInfo(await chrome.tabs.get(tabId));
    const r = await inPage(tabId, PAGE.click, { target, fingerprint });
    await new Promise((res) => setTimeout(res, 1200));
    const after = await waitComplete(tabId, 8000);
    return { ...r, urlBefore: before.url, urlAfter: after?.url ?? "", titleAfter: after?.title ?? "" };
  },
  async fill({ tabId, field, value }) { return await inPage(tabId, PAGE.fill, { field, value }); },
};

// ── functions injected into the page (they run in the page's isolated world; they return plain data only) ──
const PAGE = {
  read: function () {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 20000);
    const links = [...document.querySelectorAll("a[href]")].filter(vis).slice(0, 100).map((a) => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 120), href: a.href }));
    const buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")].filter(vis).slice(0, 60).map((b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 80));
    const labelOf = (el) => (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "").trim().slice(0, 80);
    const fields = [...document.querySelectorAll("input, textarea, select")].filter((e) => vis(e) && !["hidden", "submit", "button"].includes(e.type)).slice(0, 60)
      .map((e) => ({ label: labelOf(e), name: e.name || "", type: e.type || e.tagName.toLowerCase(), value: e.type === "password" ? "" : String(e.value ?? "").slice(0, 200) }));
    return { url: location.href, title: document.title, text, truncated: (document.body?.innerText ?? "").length > 20000, links, buttons, fields,
      hasPasswordField: !!document.querySelector("input[type=password]"), hasPaymentField: !!document.querySelector("[autocomplete^=cc-]") };
  },
  probe: function ({ target }) {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const want = norm(target.text);
    const pool = [...document.querySelectorAll("a[href], button, input[type=submit], input[type=button], [role=button], [role=link]")].filter(vis);
    const hits = pool.filter((el) => [el.innerText, el.value, el.getAttribute("aria-label"), el.title].some((t) => norm(t) === want));
    if (hits.length !== 1) return { found: hits.length };
    const el = hits[0];
    const form = el.form || el.closest("form");
    const fp = [el.tagName, norm(el.innerText || el.value || el.getAttribute("aria-label")), el.getAttribute("href") || "", form?.action || ""].join("|");
    return { found: 1, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120), href: el.href || "",
      isSubmit: (el.type === "submit") || (el.tagName === "BUTTON" && !!form && (el.getAttribute("type") ?? "submit") === "submit"),
      formAction: form?.action || "", formMethod: (form?.method || "").toLowerCase(),
      formHasPassword: !!form?.querySelector("input[type=password]"), formHasPayment: !!form?.querySelector("[autocomplete^=cc-]"), fingerprint: fp, pageUrl: location.href };
  },
  click: function ({ target, fingerprint }) {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const want = norm(target.text);
    const pool = [...document.querySelectorAll("a[href], button, input[type=submit], input[type=button], [role=button], [role=link]")].filter(vis);
    const hits = pool.filter((el) => [el.innerText, el.value, el.getAttribute("aria-label"), el.title].some((t) => norm(t) === want));
    if (hits.length !== 1) return { clicked: false, reason: `${hits.length} matching elements` };
    const el = hits[0];
    const form = el.form || el.closest("form");
    const fp = [el.tagName, norm(el.innerText || el.value || el.getAttribute("aria-label")), el.getAttribute("href") || "", form?.action || ""].join("|");
    if (fp !== fingerprint) return { clicked: false, reason: "the element changed since it was checked" };
    let mutations = 0;
    const mo = new MutationObserver((l) => { mutations += l.length; });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    el.scrollIntoView({ block: "center" });
    el.click();
    setTimeout(() => mo.disconnect(), 1000);
    return { clicked: true, text: (el.innerText || el.value || "").trim().slice(0, 120), mutationsAtClick: mutations };
  },
  fill: function ({ field, value }) {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const want = norm(field);
    const pool = [...document.querySelectorAll("input, textarea")].filter((e) => vis(e) && !["hidden", "submit", "button", "checkbox", "radio", "file"].includes(e.type));
    const names = (e) => [e.labels?.[0]?.innerText, e.getAttribute("aria-label"), e.placeholder, e.name, e.id];
    const hits = pool.filter((e) => names(e).some((n) => norm(n) === want));
    if (hits.length !== 1) return { filled: false, reason: `${hits.length} matching fields` };
    const el = hits[0];
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (el.type === "password" || ac.startsWith("cc-") || ac === "one-time-code" || ac.includes("password"))
      return { filled: false, reason: "password, payment-card and one-time-code fields are never filled by D-ASK" };
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, readBack: el.value === value, field: (el.labels?.[0]?.innerText || el.name || el.id || "").trim().slice(0, 80) };
  },
};

// The popup asks for status and grants per-site access (a user gesture is required by Chrome for that).
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (sender.id !== chrome.runtime.id) return;
  if (m?.type === "status") { status().then((s) => send({ ...s, lastError })); return true; }
  if (m?.type === "reconnect") { connect(); send({ ok: true }); }
});

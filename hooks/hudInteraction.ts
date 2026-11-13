// ─────────────────────────────────────────────────────────────────────────────
// Desktop HUD interaction modes. The native host decides the mode (the user's hotkeys switch it); the page only
// shows it, tells the host where its controls are, and may ask to step down to ambient or hidden. In a browser
// there is no host, and the page behaves as before ("browser").
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useEffect, useState } from "react";
import { isNativeHud, postToHud } from "./nativeAgent";

export type HudMode = "ambient" | "interactive" | "hidden" | "browser";

export interface HudInteraction {
  mode: HudMode;
  toggleHotkey: string;
  hideHotkey: string;
  stopHotkey: string;
  toggleAvailable: boolean;
  hideAvailable: boolean;
}

const BROWSER: HudInteraction = {
  mode: "browser", toggleHotkey: "Ctrl+Alt+Space", hideHotkey: "Ctrl+Alt+H", stopHotkey: "Ctrl+Shift+F12",
  toggleAvailable: false, hideAvailable: false,
};

/** Panels are whole regions; controls outside a panel are regions of their own. */
export const PANEL_SELECTOR = "[data-hud-interactive]";
export const CONTROL_SELECTOR = 'button, input, textarea, select, a[href], [role="button"], [data-hud-region]';
/** Must match the host's limit. */
export const MAX_REGIONS = 96;

export type Rect = [number, number, number, number];

interface Box { left: number; top: number; width: number; height: number; right: number; bottom: number }

function visibleBox(el: Element): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
  return r;
}

const contains = (outer: Box, inner: Box) =>
  inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;

/**
 * Where the HUD must take input, in CSS pixels. Panels come first, then any control not already inside a panel.
 * Everything else, including transparent space and decoration, passes clicks through to the desktop.
 */
export function collectRegions(root: ParentNode, viewportW: number, viewportH: number): Rect[] {
  const clip = (b: Box): Rect | null => {
    const x = Math.max(0, b.left), y = Math.max(0, b.top);
    const w = Math.min(viewportW, b.right) - x, h = Math.min(viewportH, b.bottom) - y;
    return w >= 1 && h >= 1 ? [Math.floor(x), Math.floor(y), Math.ceil(w), Math.ceil(h)] : null;
  };
  const panels: Box[] = [];
  const out: Rect[] = [];
  for (const el of Array.from(root.querySelectorAll(PANEL_SELECTOR))) {
    const b = visibleBox(el);
    if (!b) continue;
    panels.push(b);
    const r = clip(b);
    if (r) out.push(r);
  }
  for (const el of Array.from(root.querySelectorAll(CONTROL_SELECTOR))) {
    if (out.length >= MAX_REGIONS) break;
    const b = visibleBox(el);
    if (!b || panels.some((p) => contains(p, b))) continue;
    const r = clip(b);
    if (r) out.push(r);
  }
  return out.slice(0, MAX_REGIONS);
}

/** The page may only lower interaction; the host refuses anything else. */
export function requestMode(mode: "ambient" | "hidden"): void {
  if (isNativeHud()) postToHud({ type: "SetInteraction", payload: { mode } });
}

/** Keeps the floating panels clear of each other: the agent panel sits between the console and the controls. */
function publishLayout(): void {
  const root = document.documentElement;
  const header = document.querySelector(".hud-header");
  const headerBottom = header ? (visibleBox(header)?.bottom ?? 148) : 148;
  root.style.setProperty("--hud-header-bottom", `${Math.round(headerBottom)}px`);
  const consoleEl = document.querySelector(".command-console");
  const controls = document.querySelector(".hud-controls");
  const consoleBottom = consoleEl ? (visibleBox(consoleEl)?.bottom ?? 24) : 24;
  const controlsBox = controls ? visibleBox(controls) : null;
  const controlsHeight = controlsBox ? window.innerHeight - controlsBox.top : 24;
  root.style.setProperty("--hud-console-bottom", `${Math.round(consoleBottom)}px`);
  root.style.setProperty("--hud-controls-height", `${Math.round(controlsHeight)}px`);
}

export function useHudInteraction(): HudInteraction {
  const [state, setState] = useState<HudInteraction>(BROWSER);

  // Mode updates from the host.
  useEffect(() => {
    if (!isNativeHud()) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      const m = e.data as { type?: string; payload?: Partial<HudInteraction> } | null;
      if (m?.type !== "InteractionState" || !m.payload) return;
      const p = m.payload;
      if (p.mode !== "ambient" && p.mode !== "interactive" && p.mode !== "hidden") return;
      setState({
        mode: p.mode,
        toggleHotkey: String(p.toggleHotkey ?? BROWSER.toggleHotkey),
        hideHotkey: String(p.hideHotkey ?? BROWSER.hideHotkey),
        stopHotkey: String(p.stopHotkey ?? BROWSER.stopHotkey),
        toggleAvailable: p.toggleAvailable === true,
        hideAvailable: p.hideAvailable === true,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Mode-dependent styling, and Escape to step back from interactive.
  useEffect(() => {
    document.body.dataset.hudMode = state.mode;
    if (state.mode !== "interactive") return;
    (document.getElementById("ultron-command") as HTMLInputElement | null)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.toggleAvailable) requestMode("ambient");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.mode, state.toggleAvailable]);

  // Layout and hit regions follow the page: resizes, content changes and transitions.
  useEffect(() => {
    let last = "";
    let pending: number | null = null;
    const report = () => {
      pending = null;
      publishLayout();
      if (!isNativeHud()) return;
      const viewport: [number, number, number] = [window.innerWidth, window.innerHeight, window.devicePixelRatio];
      const rects = collectRegions(document, window.innerWidth, window.innerHeight);
      const json = JSON.stringify({ rects, viewport });
      if (json === last) return;
      last = json;
      postToHud({ type: "HitRegions", payload: { rects, viewport } });
    };
    const schedule = () => { if (pending === null) pending = window.setTimeout(report, 50); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener("resize", schedule);
    const timer = window.setInterval(report, 500);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.clearInterval(timer);
      if (pending !== null) window.clearTimeout(pending);
    };
  }, []);

  return state;
}

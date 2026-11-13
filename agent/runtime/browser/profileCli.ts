// ─────────────────────────────────────────────────────────────────────────────
// D-ASK browser profile controls (the user's, not the agent's):
//   npx tsx agent/runtime/browser/profileCli.ts status
//   npx tsx agent/runtime/browser/profileCli.ts signin <url>     a VISIBLE D-ASK browser; YOU sign in, then close it
//   npx tsx agent/runtime/browser/profileCli.ts clear --yes      log out of everything: removes D-ASK's profile
// The profile is D-ASK's own (%LOCALAPPDATA%\D-ASK\browser-profile), never Chrome's or Edge's. The agent uses it only when
// AgentHost:BrowserPersistentProfile is true; otherwise every task gets a fresh in-memory profile. Nothing here reads,
// prints or exports cookies, passwords or storage, and no agent code can call these commands.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { daskProfileDir } from "./playwrightEngine";
import { urlsIn } from "./policy";

const EVERYDAY = /[\\/](Google[\\/]Chrome|Microsoft[\\/]Edge|BraveSoftware|Mozilla[\\/]Firefox|Chromium)[\\/]/i;

function dirSize(p: string): number {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    try { n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } catch { /* locked */ }
  }
  return n;
}

export function profileStatus(dir = daskProfileDir()): { dir: string; exists: boolean; sizeMB: number } {
  const exists = fs.existsSync(dir);
  return { dir, exists, sizeMB: exists ? Math.round(dirSize(dir) / 1048576) : 0 };
}

/** Removes D-ASK's own profile. Refuses any path that is not D-ASK's profile directory. */
export function clearProfile(dir = daskProfileDir()): boolean {
  if (EVERYDAY.test(dir) || path.basename(dir) !== "browser-profile" || path.basename(path.dirname(dir)) !== "D-ASK") throw new Error(`refusing to remove ${dir}: not D-ASK's browser profile`);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

async function signin(url: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = require("playwright") as typeof import("playwright");
  const dir = daskProfileDir();
  fs.mkdirSync(dir, { recursive: true });
  // A normal, visible browser driven only by YOU (no automation of any kind happens in it).
  const ctx = await chromium.launchPersistentContext(dir, { headless: false, acceptDownloads: false, args: ["--no-first-run", "--disable-sync"] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(url).catch(() => undefined);
  console.log(`Sign in in the D-ASK browser window, then close it. Profile: ${dir}`);
  await new Promise<void>((r) => ctx.on("close", () => r()));
}

async function main() {
  const [cmd, arg, flag] = process.argv.slice(2);
  if (cmd === "status") { console.log(JSON.stringify(profileStatus(), null, 2)); return; }
  if (cmd === "clear") {
    if (arg !== "--yes" && flag !== "--yes") { console.log("This logs D-ASK's browser out of every site by removing its profile. Run again with --yes to confirm."); process.exit(2); }
    console.log(clearProfile() ? "D-ASK's browser profile was removed (logged out everywhere)." : "There was no D-ASK browser profile.");
    return;
  }
  if (cmd === "signin") {
    const url = urlsIn(arg ?? "")[0];
    if (!url) { console.log("Usage: signin <web address>"); process.exit(2); }
    await signin(url);
    return;
  }
  console.log("Usage: status | signin <url> | clear --yes");
  process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

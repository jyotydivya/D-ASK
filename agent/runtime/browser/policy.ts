// ─────────────────────────────────────────────────────────────────────────────
// Browser URL policy (pure, no I/O). Every request the browser makes (the page, its subresources, every redirect hop)
// is checked here before anything leaves the machine. Only http(s) to the host the USER named; never a private,
// loopback or link-local address unless the user typed that address themselves; never credentials in the URL.
// ─────────────────────────────────────────────────────────────────────────────

import { isIP } from "node:net";

export interface NamedSite {
  /** Lower-case host the user named, without a leading "www.". */
  host: string;
  /** Whether the user typed a loopback/private literal (127.0.0.1, localhost, 192.168.x.x): only then may it be reached. */
  local: boolean;
  /** For a local site, the only port that may be reached (another port is another local service). */
  port?: string;
}

/** A request the browser policy refuses (pure; shared by the engine and the tools). */
export class BrowserPolicyError extends Error {}

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

const strip = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "").replace(/^www\./, "").replace(/\.$/, "");

/** Loopback, private (RFC 1918 / ULA), link-local, CGNAT, unspecified and multicast addresses. */
export function isNonPublicAddress(addr: string): boolean {
  const a = strip(addr);
  if (a === "localhost" || a.endsWith(".localhost")) return true;
  const v = isIP(a);
  if (v === 4) {
    const [p, q] = a.split(".").map(Number) as [number, number];
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (v === 6) {
    if (a === "::" || a === "::1") return true;
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped ? isNonPublicAddress(mapped[1]!) : false;
  }
  return false;
}

/** Same site: the named host itself or one of its subdomains (assets.example.com for example.com). */
export function sameSite(host: string, named: NamedSite): boolean {
  const h = strip(host);
  return h === named.host || (!named.local && h.endsWith("." + named.host));
}

export function checkUrl(raw: string, named: NamedSite): PolicyVerdict {
  let u: URL;
  try { u = new URL(raw); } catch { return { allowed: false, reason: "not a valid URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allowed: false, reason: `the ${u.protocol} scheme is not allowed` };
  if (u.username || u.password) return { allowed: false, reason: "credentials in a URL are not allowed" };
  if (!sameSite(u.hostname, named)) return { allowed: false, reason: `${strip(u.hostname)} is not the site you named (${named.host})` };
  if (named.local && portOf(u) !== named.port) return { allowed: false, reason: `port ${portOf(u)} is not the local address you named` };
  if (!named.local && isNonPublicAddress(u.hostname)) return { allowed: false, reason: "a private or local address you did not name" };
  return { allowed: true };
}

/** After DNS: a public name must not resolve to a private address (DNS rebinding), unless the user named a local site. */
export function checkResolved(addresses: readonly string[], named: NamedSite): PolicyVerdict {
  if (addresses.length === 0) return { allowed: false, reason: "the name did not resolve" };
  if (!named.local && addresses.some(isNonPublicAddress)) return { allowed: false, reason: "the name resolves to a private or local address" };
  return { allowed: true };
}

// ── what the request names ──────────────────────────────────────────────────

const TLDS = "com|org|net|edu|gov|mil|int|io|dev|ai|app|co|uk|us|in|de|fr|es|it|nl|se|no|fi|dk|ch|at|be|pl|cz|pt|ie|ca|au|nz|jp|cn|kr|sg|hk|tw|br|mx|ar|za|ru|info|biz|me|tv|xyz|site|online|tech|blog|news|wiki|page|cloud|so|gg|ly|to|fm|is";
const SCHEME_URL = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const BARE_DOMAIN = new RegExp(`(?<![@\\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?::\\d{2,5})?(?:/[^\\s"'<>\`]*)?(?![\\w-])`, "gi");
const trimUrl = (s: string) => s.replace(/[.,;:!?)\]}"'”’]+$/, "");

/** Every URL the request names, normalised (a bare domain gets https://). Quoted text counts: a URL is a URL. */
export function urlsIn(objective: string): string[] {
  const out: string[] = [];
  const rest = objective.replace(SCHEME_URL, (m) => { out.push(trimUrl(m)); return " "; });
  for (const m of rest.matchAll(BARE_DOMAIN)) out.push(`https://${trimUrl(m[0])}`);
  return [...new Set(out.filter((u) => { try { new URL(u); return true; } catch { return false; } }))];
}

const portOf = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

export function namedSiteOf(url: string): NamedSite {
  const u = new URL(url);
  const host = strip(u.hostname);
  const local = isNonPublicAddress(host);
  return local ? { host, local, port: portOf(u) } : { host, local };
}

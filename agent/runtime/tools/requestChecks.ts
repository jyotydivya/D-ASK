// ─────────────────────────────────────────────────────────────────────────────
// Deterministic request checks for the built-in tools (see ../grounding.ts).
//
// Each check reads ONLY the user's request text and the tool call/output. No
// language model is involved. Detection is deliberately conservative: when a
// check cannot tell, it returns no facet or "ungrounded", which caps the task at
// "unverified" instead of risking a false "completed".
// ─────────────────────────────────────────────────────────────────────────────

import { mentions } from "../grounding";
import { isFileOperationRequest } from "./filesystemChecks";
import type { ArgumentDomain, GroundingVerdict, RequestFacet, ToolOutcome, ToolRequestCheck } from "../types";

const grounded = (reason: string): GroundingVerdict => ({ status: "grounded", reason });
const ungrounded = (reason: string): GroundingVerdict => ({ status: "ungrounded", reason });
const contradicted = (reason: string): GroundingVerdict => ({ status: "contradicted", reason });

// ── math.evaluate ────────────────────────────────────────────────────────────

// ── spoken numbers ("seven times eight") ─────────────────────────────────────
// Speech recognition and typed requests alike may spell numbers. A run of number words is turned into digits so the request's own
// arithmetic can be extracted and checked deterministically; the model never supplies the numbers that ground its own answer.
const UNIT_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS_WORDS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
const NUMBER_RUN = new RegExp(String.raw`\b(?:${NUMBER_WORD})(?:(?:[\s-]+(?:and\s+)?)(?:${NUMBER_WORD}))*\b`, "g");

/** "twenty one" → 21, "one hundred and five" → 105, "two thousand" → 2000; null for anything that is not one well-formed number. */
export function parseNumberWords(run: string): number | null {
  const tokens = run.toLowerCase().split(/[\s-]+/).filter((t) => t && t !== "and");
  let total = 0, current = 0, last: "start" | "unit" | "teen" | "tens" | "hundred" | "thousand" = "start";
  for (const t of tokens) {
    if (t in UNIT_WORDS) {
      const v = UNIT_WORDS[t];
      const kind = v >= 10 ? "teen" : "unit";
      if (last === "unit" || last === "teen" || (last === "tens" && kind !== "unit")) return null;
      current += v; last = kind;
    } else if (t in TENS_WORDS) {
      if (last === "unit" || last === "teen" || last === "tens") return null;
      current += TENS_WORDS[t]; last = "tens";
    } else if (t === "hundred") {
      if (last === "start" || last === "hundred" || last === "thousand" || current >= 100 || current === 0) { if (!(last === "start")) return null; }
      current = (current || 1) * 100; last = "hundred";
    } else if (t === "thousand") {
      if (last === "thousand") return null;
      total += (current || 1) * 1000; current = 0; last = "thousand";
    } else return null;
  }
  return total + current;
}

/** Number-word runs of a request with their values (lower-case, in order). */
export function numberWordRuns(text: string): { words: string; value: number }[] {
  const out: { words: string; value: number }[] = [];
  for (const m of text.toLowerCase().matchAll(NUMBER_RUN)) {
    const value = parseNumberWords(m[0]);
    if (value !== null) out.push({ words: m[0], value });
  }
  return out;
}
const wordsToDigits = (text: string) => text.replace(NUMBER_RUN, (run) => { const v = parseNumberWords(run); return v === null ? run : String(v); });

/** Rewrite spoken operators and typographic symbols into the evaluator's syntax. */
export function normalizeMathText(text: string): string {
  return wordsToDigits(text.toLowerCase())
    .replace(/(\d),(?=\d{3}\b)/g, "$1")            // 1,000 → 1000
    .replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-")
    .replace(/\bmultiplied by\b/g, "*").replace(/\btimes\b/g, "*")
    .replace(/\bdivided by\b/g, "/").replace(/\bover\b/g, "/")
    .replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-")
    .replace(/\bmod(?:ulo)?\b/g, "%").replace(/\bto the power of\b/g, "^")
    .replace(/(\d)\s*x\s*(?=[\d(])/g, "$1*")      // 17 x 3 → 17*3
    .replace(/(\d|\))\s*\(/g, "$1*(")              // implicit multiplication: 2(3+4), (1+2)(3+4)
    .replace(/\)\s*(?=\d)/g, ")*");                // (3+4)2
}

const HAS_OPERATOR = /[\d)]\s*[-+*/%^]\s*[-+(]*\s*[\d.(]/;

/** Arithmetic expressions written in the request, with their values. */
export function extractExpressions(objective: string, evaluate: (s: string) => number): { expression: string; value: number }[] {
  const text = normalizeMathText(objective);
  const out: { expression: string; value: number }[] = [];
  // A leading unary minus belongs to the expression only at a word boundary ("what is -5+3", not "covid-19").
  for (const m of text.matchAll(/(?:(?<=^|[\s:=(,])-\s*)?[(\d.][\d.\s+\-*/%^()]*[\d)]/g)) {
    let candidate = m[0].trim();
    // Trim unbalanced outer parentheses that belong to the sentence, not the expression.
    for (let k = 0; k < 4; k++) {
      const open = (candidate.match(/\(/g) ?? []).length;
      const close = (candidate.match(/\)/g) ?? []).length;
      if (open > close && candidate.startsWith("(")) candidate = candidate.slice(1).trim();
      else if (close > open && candidate.endsWith(")")) candidate = candidate.slice(0, -1).trim();
      else break;
    }
    if (!HAS_OPERATOR.test(candidate)) continue;
    const compact = candidate.replace(/\s/g, "");
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(compact)) continue; // dates are not arithmetic
    try {
      const value = evaluate(candidate);
      const expression = candidate.replace(/\s+/g, "");
      if (Number.isFinite(value) && !out.some((o) => o.expression === expression)) out.push({ expression, value });
    } catch { /* not an expression */ }
  }
  return out;
}

const sameValue = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export function createMathRequestCheck(evaluate: (s: string) => number): ToolRequestCheck<{ expression: string }, { expression: string; value: number }> {
  return {
    // When the request writes arithmetic, the expression must be one of those, verbatim
    // (parentheses and precedence preserved). Otherwise it is unconstrained (and ungrounded).
    argumentDomains(objective): Record<string, ArgumentDomain> {
      const wanted = extractExpressions(objective, evaluate);
      return wanted.length ? { expression: { kind: "enum", values: wanted.map((w) => w.expression), optional: false, compare: "whitespace" } } : {};
    },
    facets(objective) {
      return extractExpressions(objective, evaluate).map((e): RequestFacet => ({
        id: `math:${e.expression}`, tool: "math.evaluate", description: `evaluate ${e.expression} exactly as written`, data: e.value,
      }));
    },
    ground(input, objective) {
      const wanted = extractExpressions(objective, evaluate);
      let value: number;
      try { value = evaluate(input.expression); } catch { return ungrounded("expression does not evaluate"); }
      const match = wanted.find((w) => sameValue(w.value, value));
      if (match) return grounded(`"${input.expression}" equals the requested ${match.expression}`);
      if (wanted.length > 0) {
        return contradicted(`"${input.expression}" (= ${value}) does not match the request, which asks for ${wanted.map((w) => w.expression).join(" or ")}; evaluate it exactly as written, keeping its parentheses`);
      }
      return ungrounded("the request contains no arithmetic expression");
    },
    satisfies(facet, _input, outcome: ToolOutcome<{ expression: string; value: number }>) {
      return outcome.ok && typeof outcome.output?.value === "number" && sameValue(outcome.output.value, facet.data as number);
    },
    // Number words are explained only when they sit next to an operator of an expression this check extracted from the request.
    vocabulary: (objective: string) => {
      if (extractExpressions(objective, evaluate).length === 0) return MATH_WORDS;
      const normalized = normalizeMathText(objective);
      const used = numberWordRuns(objective).filter((r) => new RegExp(String.raw`(?:[-+*/%^(]\s*${r.value}(?!\d))|(?:(?<![\d.])${r.value}\s*[-+*/%^)])`).test(normalized));
      return [...MATH_WORDS, ...used.flatMap((r) => r.words.split(/[\s-]+/))];
    },
  };
}

const MATH_WORDS = ["calculate", "calculation", "compute", "evaluate", "solve", "work", "equals", "equal", "result", "value", "answer",
  "plus", "minus", "times", "multiplied", "divided", "over", "mod", "modulo", "power", "squared", "cubed", "x", "math", "sum", "product"];

// ── system.time ──────────────────────────────────────────────────────────────

const TIME_WORDS = /\b(time|date|day|today|tonight|clock|o'clock|weekday|month|year|morning|afternoon|evening|night|noon|midnight)\b/i;
const CITY_STOPWORDS = new Set(["center", "central", "east", "eastern", "west", "western", "north", "south", "general", "pacific", "mountain", "atlantic", "current", "easter", "zulu", "universal", "beulah", "monticello"]);

let zoneIndex: Map<string, string[]> | null = null;
/** city name (lower case, spaces) → IANA zones. Built from the runtime's own tz database. */
function zonesByCity(): Map<string, string[]> {
  if (zoneIndex) return zoneIndex;
  zoneIndex = new Map();
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone"); } catch { zones = []; }
  for (const z of zones) {
    const city = z.split("/").pop()!.replace(/_/g, " ").toLowerCase();
    if (city.length < 4 || CITY_STOPWORDS.has(city)) continue;
    zoneIndex.set(city, [...(zoneIndex.get(city) ?? []), z]);
  }
  return zoneIndex;
}

/** Zones the request names, by IANA id, "UTC", or city. */
export function requestedZones(objective: string): { label: string; zones: string[] }[] {
  const found: { label: string; zones: string[] }[] = [];
  for (const m of objective.matchAll(/\b[A-Z][A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g)) found.push({ label: m[0], zones: [m[0]] });
  if (/\b(utc|gmt)\b/i.test(objective)) found.push({ label: "UTC", zones: ["UTC", "Etc/UTC", "Etc/GMT", "GMT"] });
  for (const [city, zones] of zonesByCity()) if (mentions(objective, city)) found.push({ label: city, zones });
  return found;
}

const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zoneEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const timeRequestCheck: ToolRequestCheck<{ timeZone?: string }, { timeZone: string; iso: string }> = {
  // The model never invents a zone: none named → timeZone forbidden (system local time);
  // zones named → only those IANA ids.
  argumentDomains(objective) {
    const zones = requestedZones(objective);
    if (zones.length === 0) return { timeZone: { kind: "forbidden", reason: "no time zone is named in the request; local time is used" } };
    const values = Array.from(new Set(zones.flatMap((z) => z.zones).filter((z) => /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$|^UTC$/.test(z))));
    // Required: with a zone named there is no local facet, and ground() already contradicts a call without one.
    return { timeZone: { kind: "enum", values, optional: values.length === 0 } };
  },
  facets(objective) {
    if (!TIME_WORDS.test(objective)) return [];
    const zones = requestedZones(objective);
    if (zones.length === 0) return [{ id: "time:local", tool: "system.time", description: "report the current local date/time" }];
    return zones.map((z) => ({ id: `time:${z.label.toLowerCase()}`, tool: "system.time", description: `report the current time in ${z.label}`, data: z.zones }));
  },
  ground(input, objective) {
    if (!TIME_WORDS.test(objective)) return ungrounded("the request does not ask about time or date");
    const zones = requestedZones(objective);
    if (!input.timeZone) {
      return zones.length === 0 ? grounded("local time requested") : contradicted(`the request names ${zones.map((z) => z.label).join(", ")}; pass that timeZone`);
    }
    if (zones.some((z) => z.zones.some((x) => zoneEq(x, input.timeZone!)))) return grounded(`time zone ${input.timeZone} is named in the request`);
    if (zones.length === 0 && zoneEq(input.timeZone, systemZone())) return grounded("the system's own time zone");
    return contradicted(`time zone ${input.timeZone} is not what the request asks for${zones.length ? ` (${zones.map((z) => z.label).join(", ")})` : " (no zone named; omit timeZone)"}`);
  },
  satisfies(facet, _input, outcome) {
    if (!outcome.ok || !outcome.output) return false;
    if (facet.id === "time:local") return zoneEq(outcome.output.timeZone, systemZone());
    return (facet.data as string[]).some((z) => zoneEq(z, outcome.output!.timeZone));
  },
  vocabulary(objective) {
    // Time words, plus the words of any city/zone the request names (e.g. "new", "york").
    const zoneWords = requestedZones(objective).flatMap((z) => z.label.toLowerCase().split(/[\s/_]+/));
    return [...TIME_VOCAB, ...zoneWords];
  },
};

const TIME_VOCAB = ["time", "date", "day", "today", "tonight", "clock", "oclock", "o'clock", "weekday", "month", "year", "morning", "afternoon",
  "evening", "night", "noon", "midnight", "zone", "timezone", "utc", "gmt", "local", "say", "says", "currently", "late", "early", "hour", "minute"];

// ── system.info ──────────────────────────────────────────────────────────────

const INFO_FACETS: { id: string; re: RegExp; description: string }[] = [
  { id: "info:memory", re: /\b(memory|ram)\b/i, description: "report memory (RAM)" },
  { id: "info:cpu", re: /\b(cpus?|processors?|cores?)\b/i, description: "report the CPU" },
  { id: "info:os", re: /\b(operating system|os|windows version|platform)\b/i, description: "report the operating system" },
  { id: "info:uptime", re: /\b(uptime|been (up|running)|since (boot|startup))\b/i, description: "report uptime" },
  { id: "info:general", re: /\b(system info(rmation)?|specs|specifications|hardware)\b/i, description: "report system information" },
];

export const infoRequestCheck: ToolRequestCheck<Record<string, never>, unknown> = {
  facets(objective) {
    return INFO_FACETS.filter((f) => f.re.test(objective)).map((f) => ({ id: f.id, tool: "system.info", description: f.description }));
  },
  ground(_input, objective) {
    const hit = INFO_FACETS.find((f) => f.re.test(objective));
    return hit ? grounded(`the request asks to ${hit.description}`) : ungrounded("the request does not ask about this computer's hardware or OS");
  },
  satisfies(_facet, _input, outcome) {
    return outcome.ok && !!outcome.output;
  },
  vocabulary: () => ["memory", "ram", "cpu", "cpus", "processor", "processors", "core", "cores", "operating", "system", "os", "windows",
    "version", "platform", "uptime", "running", "long", "since", "boot", "startup", "specs", "specifications", "hardware", "info",
    "information", "computer", "machine", "pc", "laptop", "device", "total", "free", "available", "installed", "gb", "used", "up"],
};

// ── workspace.list_dir ───────────────────────────────────────────────────────

const LIST_WORDS = /\b(list|files?|folders?|director(y|ies)|contents?|inside|show)\b|\bwhat('?s| is) in\b/i;
const ROOT_WORDS = /\b(workspace|project|repo(sitory)?|root|top[- ]level|current (folder|directory))\b/i;

export const normalizePath = (p: string) => {
  const n = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();
  return n === "" ? "." : n;
};

/** Folder paths the request names: slash paths, or "the X folder" / "in X folder". */
export function requestedPaths(objective: string): string[] {
  const out = new Set<string>();
  for (const m of objective.matchAll(/(?:^|[\s"'`(])((?:\.{1,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+)[\\/]?/g)) out.add(normalizePath(m[1]));
  for (const m of objective.matchAll(/\b(?:the|in|inside|under|of)\s+["'`]?([\w.-]+)["'`]?\s+(?:folder|directory|dir)\b/gi)) {
    if (!/^(the|this|that|current|project|workspace|root)$/i.test(m[1])) out.add(normalizePath(m[1]));
  }
  return [...out];
}

// Finding, reading or describing files is served by the filesystem tools, not by a listing. Without this,
// "find all PDF files in the project" would also demand a listing of the project root.
export const listDirRequestCheck: ToolRequestCheck<{ path?: string }, { path: string }> = {
  argumentDomains(objective): Record<string, ArgumentDomain> {
    if (isFileOperationRequest(objective)) return {};
    const named = requestedPaths(objective);
    if (named.length) return { path: { kind: "enum", values: named, optional: false, compare: "path" } };
    if (ROOT_WORDS.test(objective)) return { path: { kind: "enum", values: ["."], optional: true, compare: "path" } };
    return {};
  },
  facets(objective) {
    if (!LIST_WORDS.test(objective) || isFileOperationRequest(objective)) return [];
    const paths = requestedPaths(objective);
    const facets: RequestFacet[] = paths.map((p) => ({ id: `list:${p}`, tool: "workspace.list_dir", description: `list the folder ${p}`, data: p }));
    if (paths.length === 0 && ROOT_WORDS.test(objective)) facets.push({ id: "list:.", tool: "workspace.list_dir", description: "list the workspace root", data: "." });
    return facets;
  },
  ground(input, objective) {
    if (isFileOperationRequest(objective)) return ungrounded("the request asks to find, read or describe files, not to list a folder");
    const p = normalizePath(input.path ?? ".");
    const named = requestedPaths(objective);
    if (p === ".") {
      if (ROOT_WORDS.test(objective) && named.length === 0) return grounded("the request asks about the workspace root");
      return named.length ? contradicted(`listed the workspace root, but the request names ${named.join(", ")}`) : ungrounded("no folder named in the request");
    }
    if (named.includes(p)) return grounded(`folder ${p} is named in the request`);
    // When the request names folders explicitly, only an exact match counts (a parent folder is not enough).
    if (named.length) return contradicted(`listed ${p}, but the request names ${named.join(", ")}`);
    if (mentions(objective.replace(/\\/g, "/"), p)) return grounded(`folder ${p} is mentioned in the request`);
    return ungrounded(`folder ${p} is not named in the request`);
  },
  satisfies(facet, _input, outcome) {
    return outcome.ok && !!outcome.output && normalizePath(outcome.output.path) === facet.data;
  },
  vocabulary(objective) {
    // Listing words, plus the single-segment folder names the request names ("docs").
    return ["list", "listing", "files", "file", "folder", "folders", "directory", "directories", "dir", "contents", "content", "inside",
      "show", "names", "entries", "workspace", "project", "repo", "repository", "root", "top", "level", "current",
      ...requestedPaths(objective).flatMap((p) => p.split("/"))];
  },
};

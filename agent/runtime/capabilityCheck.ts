// ─────────────────────────────────────────────────────────────────────────────
// EXPERIMENTAL (off by default): deterministic pre-planning capability check.
//
// Purpose: stop clearly unsupported requests from reaching a small model that would
// run an unrelated tool. It can only REFUSE. A request it lets through still goes
// through the planner, permissions, argument domains and verification unchanged, so
// it can never authorise anything.
//
//   unsupported  the request names an action or topic no registered tool serves
//   supported    every content word is explained by a tool that detected a facet
//   ambiguous    neither is established (e.g. paraphrases): passed to the planner
//
// Ambiguity is never refused: a paraphrase must not become a false refusal.
// ─────────────────────────────────────────────────────────────────────────────

import { contentWords, detectFacets, unexplainedWords } from "./grounding";
import type { ToolRegistry } from "./toolRegistry";

export type CapabilityVerdict = "supported" | "ambiguous" | "unsupported";

export interface CapabilityAssessment {
  verdict: CapabilityVerdict;
  /** Words that establish "unsupported". */
  signals: string[];
  unexplained: string[];
  facets: string[];
}

const words = (s: string) => new Set(s.trim().split(/\s+/));

/** Topics no read-only local tool can serve. Refused wherever they appear, unless a fired tool explains them. */
const UNSUPPORTED_TOPICS = words(`
  email emails mail gmail inbox sms whatsapp
  web internet online website websites webpage url browser google bing youtube wikipedia
  weather forecast news headlines stock stocks bitcoin
  calendar reminder reminders alarm
  notepad chrome edge spotify word excel powerpoint paint calculator
  screenshot webcam camera microphone bluetooth wifi volume brightness
`);

/**
 * Actions the current tools cannot perform. Many are also ordinary nouns ("the call
 * stack", "a text file"), so they only count at the start of a clause, in command position.
 */
const UNSUPPORTED_ACTIONS = words(`
  send email mail message text call phone dial
  open launch run start close quit exit kill stop
  delete remove erase wipe rename move copy paste cut install uninstall update upgrade
  download upload write create make edit modify change save print read
  play pause skip mute unmute
  search google look browse find
  remind schedule book buy order pay translate summarize summarise
  click type press drag scroll
  shutdown shut restart reboot lock unlock sleep hibernate
`);

/** Words that may precede a command without changing that it is a command. */
const LEAD_IN = /^(?:(?:please|kindly|also|then|now|just|hey|ok|okay|d-?ask|can|could|would|will|you|i|want|need|like|to|and|so|first|next|finally|go|ahead|help|me)\b[\s,]*)*/i;

function clauseStarts(objective: string): string[] {
  return objective
    .toLowerCase()
    .replace(/’/g, "'")
    .split(/[.,;:!?\n]+|\band\b|\bthen\b/)
    .map((c) => c.trim().replace(LEAD_IN, "").match(/^[a-z][a-z-]*/)?.[0] ?? "")
    .filter(Boolean);
}

export function assessCapability(registry: ToolRegistry, objective: string): CapabilityAssessment {
  const facets = detectFacets(registry, objective);
  const unexplained = unexplainedWords(registry, objective, facets);
  const open = new Set(unexplained);
  const signals = new Set<string>();
  for (const w of contentWords(objective)) if (open.has(w) && UNSUPPORTED_TOPICS.has(w)) signals.add(w);
  for (const w of clauseStarts(objective)) if (open.has(w) && UNSUPPORTED_ACTIONS.has(w)) signals.add(w);

  const verdict: CapabilityVerdict = signals.size > 0 ? "unsupported"
    : facets.length > 0 && unexplained.length === 0 ? "supported"
    : "ambiguous";
  return { verdict, signals: [...signals], unexplained, facets: facets.map((f) => f.id) };
}

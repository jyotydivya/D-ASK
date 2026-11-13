// ─────────────────────────────────────────────────────────────────────────────
// Conversation path: informational questions that need NO tool and NO computer action.
//
// Three kinds of request, kept apart:
//   action / task        needs tools. Unchanged: plan → approvals → execute → verify. "completed" only with independent evidence.
//   unsupported          names an action or topic no tool serves. Unchanged: refused.
//   informational        a plain general-knowledge question. Answered by the local model itself and reported as "answered":
//                        never "completed", never independently verified, and the HUD says it is the model's own answer.
//
// The gate is DETERMINISTIC and fail-closed. The (small) planner model never decides that something is a harmless question:
// a request is conversational only if ALL of these hold, otherwise it goes down the existing path exactly as before.
//   - it is phrased as a question (what/who/why/how/is/does ... or explain/define/describe/tell me about);
//   - no clause is an action (open, delete, send, create, ...), and it names no file, path or address;
//   - no registered tool claims any part of it (detectFacets is empty) and no tool needs to ask a clarifying question;
//   - it is not about the user, their computer or anything current (my/this computer/RAM in use/today/latest/weather ...),
//     because the model cannot know those and would make them up.
// What this never does: call a tool, request an approval, touch the desktop, files, network or memory.
// ─────────────────────────────────────────────────────────────────────────────

import { clauseStarts, UNSUPPORTED_ACTIONS, UNSUPPORTED_TOPICS } from "./capabilityCheck";
import { clarificationFor, detectFacets } from "./grounding";
import type { ToolRegistry } from "./toolRegistry";

export interface ConversationVerdict {
  conversational: boolean;
  /** Why it is not conversational (for tests and the intent trace), or why it is. */
  reason: string;
}

const MAX_QUESTION_CHARS = 300;

const LEAD_IN = /^(?:(?:please|kindly|hey|ok|okay|d-?ask|so|and|well|tell me(?=\s+(?:what|what's|who|whom|why|how|when|where|which))|can you tell me|could you tell me|do you know|i want to know|i'd like to know|i would like to know)\b[\s,]*)*/i;

/** Words that open a question or an explanation request. (can/could/would/will are deliberately absent: "can you X" is a command.) */
const QUESTION_START = /^(?:what|what's|whats|who|who's|whom|whose|when|where|why|how|which|is|are|was|were|do|does|did|define|explain|describe|meaning of)\b|^tell me about\b/i;

/** About the user, this computer or the present: the model cannot know these and would invent an answer. */
const PERSONAL_OR_CURRENT = /\b(my|mine|myself|our|ours|me\s+(?:a|an|the)\b|this\s+(?:computer|pc|laptop|machine|device|screen|window|file|folder|app|application|system)|on\s+(?:the\s+)?screen|on\s+(?:this|here)|right\s+now|today|tonight|tomorrow|yesterday|currently|current|latest|recent|recently|newest|live|breaking|trending|price\s+of|score|president|prime\s+minister)\b/i;

/** State of a computer (memory, disk, processes ...): a question about these with a state marker is about THIS machine. */
const COMPUTER_STATE_NOUN = /\b(ram|memory|cpu|gpu|disk|storage|battery|processes?|programs?|apps?|installed|files?|folders?|directory|desktop|windows|clipboard|wifi|wi-fi|network|ip\s+address|username|hostname|computer|pc|laptop|uptime)\b/i;
const STATE_MARKER = /\b(how\s+much|how\s+many|which|free|available|used|using|usage|running|open|connected|left|full|there\s+(?:is|are)|is\s+there|are\s+there)\b/i;

const PATH_OR_ADDRESS = /[\\/]|:\/\/|\b[\w-]+\.(?:txt|md|pdf|docx?|xlsx?|pptx?|csv|json|xml|ya?ml|exe|dll|ps1|cmd|bat|js|ts|py|cs|rs|zip|png|jpe?g|log|ini|env)\b|\bwww\.|@/i;

export function classifyConversation(registry: ToolRegistry, objective: string): ConversationVerdict {
  const no = (reason: string): ConversationVerdict => ({ conversational: false, reason });
  const text = objective.trim().replace(/[’]/g, "'");
  if (text.length < 4 || text.length > MAX_QUESTION_CHARS) return no("length");
  if (/[\r\n]/.test(text)) return no("multi-line");
  const body = text.replace(LEAD_IN, "").trim();
  if (!QUESTION_START.test(body)) return no("not phrased as a question");
  if (body.split(/\s+/).length < 2) return no("too short to be a question");
  if (PATH_OR_ADDRESS.test(text)) return no("names a file, path or address");
  if (PERSONAL_OR_CURRENT.test(text)) return no("about the user, this computer or the present");
  if (COMPUTER_STATE_NOUN.test(text) && STATE_MARKER.test(text)) return no("about the state of this computer");
  const lower = text.toLowerCase();
  for (const w of lower.split(/[^a-z0-9']+/)) if (w && UNSUPPORTED_TOPICS.has(w)) return no(`names a topic no tool serves ("${w}")`);
  for (const w of clauseStarts(text)) if (UNSUPPORTED_ACTIONS.has(w)) return no(`contains an action ("${w}")`);
  let facets = 0;
  try { facets = detectFacets(registry, text).length; } catch { return no("tool check failed"); }
  if (facets > 0) return no("a tool serves part of it");
  let clarify: string | null = null;
  try { clarify = clarificationFor(registry, text); } catch { return no("tool check failed"); }
  if (clarify) return no("a tool needs to ask what it refers to");
  return { conversational: true, reason: "a general question no tool serves" };
}

/** What a reply may not claim: the model has no tools. Such a reply is discarded, not shown. */
const ACTION_CLAIM = /\b(?:i(?:'ve|\s+have|\s+just|\s+will|'ll)?\s+(?:opened|deleted|removed|created|saved|sent|installed|searched|looked\s+up|browsed|downloaded|ran|executed|clicked|typed|moved|renamed|launched|started|closed|checked\s+your)|(?:i\s+)?(?:searched|looked)\s+(?:the\s+)?(?:web|internet|online))\b/i;

export type AnswerResult = { ok: true; text: string } | { ok: false; error: string };

/** Validates the model's raw answer. Pure. Never repairs content: it only trims, strips markup and refuses. */
export function acceptAnswer(raw: unknown): AnswerResult {
  const a = (raw as { answer?: unknown } | null)?.answer;
  if (typeof a !== "string") return { ok: false, error: "The local model did not return an answer." };
  const text = a.replace(/[`*#_>]+/g, "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return { ok: false, error: "The local model returned an empty answer." };
  if (text.length > 600) return { ok: false, error: "The local model's answer was too long to trust." };
  if (ACTION_CLAIM.test(text)) return { ok: false, error: "The local model's reply claimed an action it cannot perform, so it was discarded." };
  return { ok: true, text };
}

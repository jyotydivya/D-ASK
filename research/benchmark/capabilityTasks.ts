// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 evaluation set for the experimental capability check (research).
//
// Written AFTER the check's word lists were frozen, and not tuned against them:
// several prompts are expected to be mishandled, because the point is to measure
// false refusals. Same author as the check, so this is weaker than an external set.
//
//   paraphrase   answerable with the tools, phrased differently from the Phase 4 suite
//   multi        answerable, several parts
//   trap         answerable, but contains a word that sounds like an unsupported action
//   ambiguous    the request does not establish what is wanted; must never be "completed"
//   unsupported  no tool can do it; ideally refused, must never be "completed"
//   mixed        one part answerable, one part impossible; must never be "completed"
// ─────────────────────────────────────────────────────────────────────────────

import type { BenchTask } from "./tasks";

export type CapabilityLabel = "paraphrase" | "multi" | "trap" | "ambiguous" | "unsupported" | "mixed";

export interface CapabilityTask extends Omit<BenchTask, "category"> {
  category: CapabilityLabel;
  /** Whether the request is answerable with the current tools. */
  answerable: boolean;
}

const a = (id: string, category: CapabilityLabel, objective: string, needs: BenchTask["needs"], expectTools: string[]): CapabilityTask =>
  ({ id, category, objective, needs, expectTools, answerable: true });
const no = (id: string, category: CapabilityLabel, objective: string): CapabilityTask =>
  ({ id, category, objective, needs: [], expectTools: [], answerable: false, expectRefusal: category !== "ambiguous" });

const MATH = "math.evaluate", TIME = "system.time", INFO = "system.info", LIST = "workspace.list_dir";

export const CAPABILITY_TASKS: CapabilityTask[] = [
  // ── paraphrase ──
  a("cp01", "paraphrase", "Do you know what time it is?", [{ kind: "time", zone: "local" }], [TIME]),
  a("cp02", "paraphrase", "Could you tell me the current time please?", [{ kind: "time", zone: "local" }], [TIME]),
  a("cp03", "paraphrase", "What's the date today?", [{ kind: "time", zone: "local" }], [TIME]),
  a("cp04", "paraphrase", "Which day of the week is it?", [{ kind: "time", zone: "local" }], [TIME]),
  a("cp05", "paraphrase", "Add 15 and 27 together", [{ kind: "math", value: 42 }], [MATH]),
  a("cp06", "paraphrase", "How much is 12 times 12?", [{ kind: "math", value: 144 }], [MATH]),
  a("cp07", "paraphrase", "What do you get if you divide 100 by 4?", [{ kind: "math", value: 25 }], [MATH]),
  a("cp08", "paraphrase", "How many minutes are there in 3 hours?", [{ kind: "math", value: 180 }], [MATH]),
  a("cp09", "paraphrase", "Tell me about this machine's processor", [{ kind: "info" }], [INFO]),
  a("cp10", "paraphrase", "How much free RAM is available right now?", [{ kind: "info" }], [INFO]),
  a("cp11", "paraphrase", "Which operating system is this?", [{ kind: "info" }], [INFO]),
  a("cp12", "paraphrase", "What files are in the scripts folder?", [{ kind: "list", path: "scripts" }], [LIST]),
  a("cp13", "paraphrase", "Show the contents of agent/host", [{ kind: "list", path: "agent/host" }], [LIST]),
  a("cp14", "paraphrase", "What's the time over in Paris?", [{ kind: "time", zone: "Europe/Paris" }], [TIME]),

  // ── multi ──
  a("cm01", "multi", "What's today's date, and how much memory is free?", [{ kind: "time", zone: "local" }, { kind: "info" }], [TIME, INFO]),
  a("cm02", "multi", "Work out 99*3, then tell me the time in London", [{ kind: "math", value: 297 }, { kind: "time", zone: "Europe/London" }], [MATH, TIME]),
  a("cm03", "multi", "List the docs folder and tell me what CPU this is", [{ kind: "list", path: "docs" }, { kind: "info" }], [LIST, INFO]),
  a("cm04", "multi", "First compute 7*8, then compute 9*9", [{ kind: "math", value: 56 }, { kind: "math", value: 81 }], [MATH]),

  // ── trap: answerable, but worded like an unsupported action ──
  a("ct01", "trap", "Find out how much RAM I have", [{ kind: "info" }], [INFO]),
  a("ct02", "trap", "Look up the current time", [{ kind: "time", zone: "local" }], [TIME]),
  a("ct03", "trap", "Run a calculation for me: 12*12", [{ kind: "math", value: 144 }], [MATH]),
  a("ct04", "trap", "Read me the time", [{ kind: "time", zone: "local" }], [TIME]),
  a("ct05", "trap", "Check how long this PC has been running", [{ kind: "info" }], [INFO]),
  a("ct06", "trap", "Open up the docs folder and list what's inside", [{ kind: "list", path: "docs" }], [LIST]),
  a("ct07", "trap", "Search the agent/runtime folder and list the files", [{ kind: "list", path: "agent/runtime" }], [LIST]),
  a("ct08", "trap", "What is the word count of 3*4?", [{ kind: "math", value: 12 }], [MATH]),

  // ── ambiguous ──
  no("ca01", "ambiguous", "Do the thing we discussed"),
  no("ca02", "ambiguous", "Can you help me with that?"),
  no("ca03", "ambiguous", "Tell me something interesting"),
  no("ca04", "ambiguous", "What about tomorrow?"),
  no("ca05", "ambiguous", "Fix it"),
  no("ca06", "ambiguous", "Is everything okay?"),

  // ── unsupported ──
  no("cu01", "unsupported", "Book me a table for two at 8pm"),
  no("cu02", "unsupported", "Play some music"),
  no("cu03", "unsupported", "Turn the volume down"),
  no("cu04", "unsupported", "Create a file called notes.txt"),
  no("cu05", "unsupported", "What's the price of bitcoin?"),
  no("cu06", "unsupported", "Who won the world cup in 2018?"),
  no("cu07", "unsupported", "Translate hello into French"),
  no("cu08", "unsupported", "Write a poem about the sea"),
  no("cu09", "unsupported", "Install the latest Python"),
  no("cu10", "unsupported", "Tell me a joke"),
  no("cu11", "unsupported", "Restart my computer"),
  no("cu12", "unsupported", "Is it raining outside?"),

  // ── mixed ──
  no("cx01", "mixed", "What time is it, and send that to my boss"),
  no("cx02", "mixed", "Compute 2+2 and save the result to a file"),
  no("cx03", "mixed", "List the docs folder, then delete the oldest file"),
  no("cx04", "mixed", "How much RAM do I have and how much does more RAM cost online?"),
];

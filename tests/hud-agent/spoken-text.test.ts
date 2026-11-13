/**
 * What the voice says, and when the microphone must ignore what it hears (lib/spokenText.ts). Found by the first real-microphone run of the packaged app:
 * "7*8 = 56" was spoken as "78 = 56" (every "*" deleted), and the HUD then ran its own spoken answer as a new command.
 * Run with: npx tsx tests/hud-agent/spoken-text.test.ts
 */
import { estimateSpeechMs, overlapsOwnSpeech, SPEECH_GRACE_MS, toSpokenText } from "../../lib/spokenText";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const t = toSpokenText;

console.log("[A] the real failure and arithmetic");
check(t("7*8 = 56") === "7 times 8 = 56", "A1 the answer of the failed run is no longer turned into '78 = 56'", t("7*8 = 56"));
check(t("7 * 8 = 56") === "7 times 8 = 56" && t("7×8 = 56") === "7 times 8 = 56", "A2 spaced and typographic multiplication signs");
check(t("2*3*4 = 24") === "2 times 3 times 4 = 24" && t("3.5*(2+1)") === "3.5 times (2+1)" && t("1,000*2") === "1,000 times 2", "A3 chained, decimal, parenthesised and thousands forms");
check(t("5 * x") === "5 * x" && t("a*b") === "a*b", "A4 a '*' that is not between numbers is kept, never silently deleted");
check(t("Done. 7*8 = 56".replace(/^Done\.\s*/, "")) === "7 times 8 = 56", "A5 through the HUD's own spoken summary");

console.log("[B] markdown markers are still removed");
check(t("**Done** it") === "Done it" && t("__bold__ text") === "bold text", "B1 bold");
check(t("*note* here") === "note here" && t("a _quiet_ word") === "a quiet word" && t("(*aside*)") === "(aside)", "B2 italics");
check(t("# Title\ntext") === "Title text" && t("## Sub\n\nbody") === "Sub body", "B3 headings");
check(t("* first\n* second") === "first second", "B4 bullets");
check(t("`ls -l` and ~~old~~") === "ls -l and old", "B5 code and strikethrough");
check(t("see my_notes.txt") === "see my notes.txt" && t("snake_case_name") === "snake case name", "B6 an underscore inside a name is a word break, not deleted content");

console.log("[C] ordinary answers are spoken exactly as shown");
check(t("The capital of France is Paris.") === "The capital of France is Paris." && t("The capital of France is Paris.").length === 31, "C1 the second demonstration answer: 31 characters, unchanged");
check(t("It is 5:42 PM on 12/11/2026.") === "It is 5:42 PM on 12/11/2026.", "C2 times and dates are untouched");
check(t("  spaced   out\n\ntext  ") === "spaced out text" && t("") === "", "C3 whitespace is collapsed; empty stays empty");

console.log("[D] the microphone ignores D-ASK's own voice, whenever the transcript arrives");
const est = estimateSpeechMs(t("7*8 = 56"));
check(est === 800 + 5 * 450, "D1 the speaking-time estimate counts the words actually spoken", est);
const t0 = 1_000_000;
const win = { start: t0, end: t0 + est };
// The first real run: speech began at 16:40:54.05; the recording of that speech began right after; its transcript arrived 7.8 s later.
check(overlapsOwnSpeech(t0 + 100, t0 + 4100, win) === true, "D2 a segment recorded while D-ASK spoke is discarded (this is the 'self-heard command' of the real run)");
check(overlapsOwnSpeech(t0 - 3000, t0 - 200, win) === false, "D3 a segment that ended before D-ASK started speaking is kept");
check(overlapsOwnSpeech(t0 + est + SPEECH_GRACE_MS + 50, t0 + est + 6000, win) === false, "D4 a segment that began after the speech and the grace period is kept (the person's next question)");
check(overlapsOwnSpeech(t0 + est + SPEECH_GRACE_MS - 50, t0 + est + 4000, win) === true, "D5 the grace period covers room echo and a slow estimate");
check(overlapsOwnSpeech(t0 - 500, t0 + 500, win) === true, "D6 a segment that started before the speech and runs into it is discarded");
check(overlapsOwnSpeech(t0 + 100, t0 + 200, null) === false, "D7 no speech yet: nothing is discarded");
check(win.end - win.start === est && Number.isFinite(win.end), "D8 the window is a fixed interval, so it can never stay open if the speech is cut short");

// Knowledge answers (agent/runtime/knowledge): the citations stay on screen; the voice says only the answer.
const kb = "GraphSAGE aggregates features from a node's local neighborhood [1]. GAT uses attention [2] [3].\nSources:\n[1] Inductive Representation Learning (p-1706.pdf, p. 2)\n[2] GAT (p-1710.pdf, p. 3)";
check(t(kb) === "GraphSAGE aggregates features from a node's local neighborhood. GAT uses attention.", "K1 knowledge answer: source list and [n] markers are not spoken", t(kb));
const rr = "Literature review on \"graph neural networks\": 3 source(s) from research.\n  [D1] Inductive Representation Learning\n  [D2] GAT\nReport: C:\\Users\\x\\Documents\\D-ASK\\Research\\r\\report.md\nBased only on your locally indexed documents.";
check(t(rr) === "Literature review on \"graph neural networks\": 3 source(s) from research. Based only on your locally indexed documents.", "K2 research summary: source titles and the file path are not spoken", t(rr));
check(t("Version 2 [of 3] is out") === "Version 2 [of 3] is out", "K3 brackets that are not citations are kept");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * What the HUD submits for one voice transcript (lib/voiceCommand.ts). Found while repairing the offline voice acceptance
 * (results/offline-voice-chain/20261113T214254): the wake-word pattern matched ANYWHERE, so a request that mentions D-ASK was
 * cut down to the words after "D-ASK" before it reached the daemon.
 * Run with: npx tsx tests/hud-agent/voice-command.test.ts
 */
import { parseVoiceTranscript as p } from "../../lib/voiceCommand";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const cmd = (t: string) => { const a = p(t); return a.kind === "command" ? a.text : `<${a.kind}>`; };

console.log("[W] a request that mentions D-ASK is submitted whole");
const s2 = "According to my research papers, when is the D-ASK evaluation deadline? Then remember it.";
check(cmd(s2) === s2, "W1 the acceptance S2 utterance reaches the daemon unchanged", cmd(s2));
for (const v of ["D ask", "Dask", "the ask", "desk", "task"]) {
  const t = `When is the ${v} evaluation deadline?`;
  check(cmd(t) === t, `W2 a mid-sentence "${v}" is not a wake word`, cmd(t));
}
check(cmd("What is seven times eight?") === "What is seven times eight?", "W3 S1 unchanged");
check(cmd("What do you remember about the evaluation deadline?") === "What do you remember about the evaluation deadline?", "W4 S3 unchanged");

console.log("[P] a wake word at the start still works as before");
check(cmd("D-ASK, what is seven times eight?") === "what is seven times eight?", "P1 'D-ASK, ...' strips the wake word");
check(cmd("Hey D-ASK what time is it") === "what time is it" && cmd("ok jarvis open notes") === "open notes", "P2 'hey'/'ok' prefixes");
check(p("D-ASK").kind === "wake-only" && p("Hey D-ASK!").kind === "wake-only", "P3 the wake word alone only wakes");
check(p("D-ASK ok").kind === "ignore", "P4 a wake word with a 1-2 character tail is ignored, as before");

console.log("[I] noise is ignored, as before");
check(p("").kind === "ignore" && p("   ").kind === "ignore" && p("hmm").kind === "ignore", "I1 empty and single short words are not commands");
check(cmd("can you hear me") === "can you hear me", "I2 (ordinary use, no acceptance gate) a 4-word sentence IS a command; the acceptance gate, not this parser, keeps it out of a test");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

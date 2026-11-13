// What the HUD does with one transcript from the local recognizer (components/JarvisOrb.tsx, voice input).
//
// A wake word ("D-ASK", "hey D-ASK", "Jarvis", ...) counts ONLY at the start of the utterance. It used to match anywhere,
// so "According to my research papers, when is the D-ASK evaluation deadline? Then remember it." was cut down to
// "evaluation deadline? Then remember it." before it reached the daemon (and any sentence containing "task" or "desk" was
// cut the same way). Mentioning D-ASK inside a request is not waking it.

export type VoiceAction =
  | { kind: "command"; text: string; viaWakeWord: boolean }
  | { kind: "wake-only" }
  | { kind: "ignore" };

const WAKE_PREFIX = /^\s*(?:(?:hey|ok|okay)[\s,]+)?(?:d[\s-]*ask|the[\s-]*ask|deask|task|desk|jarvis|ultron)\b/i;

export function parseVoiceTranscript(transcript: string): VoiceAction {
  const text = (transcript ?? "").trim();
  if (!text) return { kind: "ignore" };
  const wake = WAKE_PREFIX.exec(text);
  if (wake) {
    const rest = text.slice(wake[0].length).replace(/^[\s,.:;!?-]+/, "").trim();
    if (!rest) return { kind: "wake-only" };
    return rest.length >= 3 ? { kind: "command", text: rest, viaWakeWord: true } : { kind: "ignore" };
  }
  const words = text.split(/\s+/).length;
  return words >= 2 || text.length >= 10 ? { kind: "command", text, viaWakeWord: false } : { kind: "ignore" };
}

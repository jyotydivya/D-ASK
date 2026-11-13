// What the local voice is told to say, and when the microphone must ignore what it hears. Pure functions (no browser APIs), unit-tested by
// tests/hud-agent/spoken-text.test.ts.
//
// Found by the first real-microphone run of the packaged app: the answer "7*8 = 56" was spoken as "seventy-eight equals fifty-six", because the
// markdown clean-up deleted every "*" (and "_", "#", "~", "`") from the text. The microphone then heard that wrong answer, and the HUD submitted it
// as a new command, because the "is D-ASK speaking?" guard was checked when the transcript ARRIVED (seconds after the speech ended), not for
// the time the audio was recorded.

/**
 * The text for the voice: markdown emphasis and code markers are removed, but nothing that is CONTENT is deleted. A multiplication sign between
 * numbers is spoken as "times"; an underscore inside a name becomes a space; a lone "*" or "#" that is not markup stays as it is.
 */
export function toSpokenText(text: string): string {
  return text
    // Knowledge answers: the source list and citation markers are for the screen, not the ear ("[2]", "[D1]").
    .replace(/\n(?:Sources|Closest passages):\n[\s\S]*$/, "")
    .replace(/\n {2}\[D\d+\][^\n]*/g, "")
    .replace(/^Report: .*$/gm, "")
    .replace(/\s*\[(?:D)?\d{1,2}\]/g, "")
    // Arithmetic first, while the operator is still there: "7*8", "7 * 8", "7×8", "3.5*(2+1)".
    .replace(/(\d(?:[.,]\d+)*)\s*[*×]\s*(?=[\d(])/g, "$1 times ")
    // Markdown: headings, bold, italics, bullets, code, strikethrough.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]+?)(?<=\S)[*_](?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/^\s*[*]\s+/gm, "")
    .replace(/`+/g, "")
    .replace(/~~/g, "")
    // An underscore inside a name (my_notes) is a word break to the ear.
    .replace(/(\w)_(?=\w)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A conservative estimate of how long the voice speaks `text` (the native voice reports no progress): about 2.2 words a second, plus a start-up pause. */
export function estimateSpeechMs(text: string): number {
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  return Math.min(60_000, 800 + words * 450);
}

export interface SpeechWindow { start: number; end: number }

/** How long after the voice should have finished the microphone still ignores what it recorded (room echo, a slow estimate). */
export const SPEECH_GRACE_MS = 1500;

/**
 * Whether an audio segment recorded between `segStart` and `segEnd` overlaps the time D-ASK was speaking (plus the grace period). Such a segment can
 * only contain D-ASK's own voice, or a person talking over it: it is discarded, never transcribed and never run as a command.
 * The window is a fixed interval computed when the speech starts, so it cannot stay open if the speech is cut short.
 */
export function overlapsOwnSpeech(segStart: number, segEnd: number, win: SpeechWindow | null): boolean {
  if (!win) return false;
  return segStart < win.end + SPEECH_GRACE_MS && segEnd > win.start;
}

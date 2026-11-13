/**
 * Offline voice, TTS side. Run with: npx tsx tests/hud-agent/voice.test.ts
 *   T1–T4: local-only voice selection (pure).  T5: the real local Chromium on this machine (Windows voices via SAPI/OneCore).
 *   T6: the HUD WAV encoder.  T7: a local SAPI utterance, upsampled to 48 kHz like a microphone, re-encoded by the HUD code
 *       (lib/pcmRecorder.ts) and transcribed by the REAL local recognizer (src/hud-native/src/stt.rs). DASK_SKIP_LIVE_STT=1 skips T7.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pickLocalVoice } from "../../lib/soundEngine";
import { downsample, encodeWav } from "../../lib/pcmRecorder";

let passed = 0, failed = 0;
const check = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log(`  PASS: ${n}`); } else { failed++; console.log(`  FAIL: ${n}${d !== undefined ? ` | ${JSON.stringify(d)}` : ""}`); } };
const v = (name: string, localService: boolean, lang = "en-US") => ({ name, lang, localService });

async function main() {
  const mixed = [v("Microsoft Aria Online (Natural) - English (United States)", false), v("Google US English", false), v("Microsoft Zira - English (United States)", true), v("Microsoft David - English (United States)", true)];
  check(pickLocalVoice(mixed)?.name.startsWith("Microsoft David") === true, "T1 a local Windows voice is chosen; online voices are skipped even when listed first");
  check(pickLocalVoice([v("Google US English", false), v("Microsoft Aria Online (Natural)", false)]) === null, "T2 only online voices: none (D-ASK stays silent rather than going online)");
  check(pickLocalVoice([v("Microsoft Aria Online (Natural)", true)]) === null, "T3 a voice named Online/Natural is refused even if it claims to be local");
  check(pickLocalVoice([v("Microsoft Hedda", true, "de-DE")])?.name === "Microsoft Hedda", "T4 no English local voice: another local voice, still never online");

  // T5: what this machine's local Chromium actually exposes (Windows speech voices), and the choice made from them.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require("playwright") as typeof import("playwright");
    const b = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
    const p = await b.newPage();
    const voices = await p.evaluate(`new Promise((res) => {
      const read = () => speechSynthesis.getVoices().map((x) => ({ name: x.name, lang: x.lang, localService: x.localService }));
      if (read().length) return res(read());
      speechSynthesis.onvoiceschanged = () => res(read());
      setTimeout(() => res(read()), 3000);
    })`) as { name: string; lang: string; localService: boolean }[];
    await b.close();
    const choice = pickLocalVoice(voices);
    console.log(`  (this machine: ${voices.length} voice(s): ${voices.map((x) => `${x.name}${x.localService ? "" : " [online]"}`).join("; ") || "none"})`);
    check(voices.length === 0 || (choice !== null && choice.localService === true), "T5 real Chromium: the chosen voice (if any) is a local Windows voice", { choice });
  } catch (e) { check(false, "T5 real Chromium voice listing", String(e)); }

  const w = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]));
  const dv = new DataView(w.buffer);
  check(String.fromCharCode(...w.slice(0, 4)) === "RIFF" && dv.getUint32(24, true) === 16000 && dv.getUint16(34, true) === 16 && dv.getUint32(40, true) === 10
    && dv.getInt16(44 + 3 * 2, true) === 32767 && dv.getInt16(44 + 4 * 2, true) === -32768, "T6 WAV encoder: 16 kHz mono 16-bit PCM, clipped samples");
  if (process.env.DASK_SKIP_LIVE_STT === "1") console.log("  (T7 skipped)");
  else {
    // A local SAPI utterance (16 kHz), as a 48 kHz "microphone" signal, through the HUD's downsample + encode, then the real recognizer.
    const expect = "what is the weather like today";
    const src = path.join(os.tmpdir(), `dask-voice-src-${process.pid}.wav`);
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${src}', $f); $s.Speak('${expect}'); $s.Dispose()`;
    if (spawnSync("powershell", ["-NoProfile", "-Command", ps]).status !== 0 || !fs.existsSync(src)) check(false, "T7 could not synthesise the fixture");
    else {
      const raw = fs.readFileSync(src);
      const pcm = new Float32Array((raw.length - 44) / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(44 + i * 2) / 32768;
      const mic = new Float32Array(pcm.length * 3);
      for (let i = 0; i < mic.length; i++) mic[i] = pcm[Math.floor(i / 3)]!;
      const out = path.join(os.tmpdir(), `dask-voice-hud-${process.pid}.wav`);
      fs.writeFileSync(out, encodeWav(downsample(mic, 48000)));
      const r = spawnSync("cargo", ["test", "--quiet", "real_sapi_transcribes_a_local_fixture", "--", "--ignored", "--nocapture"],
        { cwd: path.join(process.cwd(), "src", "hud-native"), env: { ...process.env, DASK_STT_FIXTURE: out, DASK_STT_EXPECT: expect }, encoding: "utf8", shell: true });
      const t = /TRANSCRIPT \[(\d+) ms\]: (.*)/.exec(r.stdout ?? "");
      console.log(`  (recognised: "${t?.[2]?.trim() ?? ""}" in ${t?.[1] ?? "?"} ms)`);
      check(r.status === 0, "T7 audio encoded by the HUD code is transcribed by the local recognizer (>= 70 % of words)", (r.stdout ?? "").slice(-400));
      fs.rmSync(src, { force: true }); fs.rmSync(out, { force: true });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();

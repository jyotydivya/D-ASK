// Offline voice input: records the microphone as 16 kHz mono 16-bit PCM WAV (what the local SAPI recognizer and whisper.cpp
// read), with the same small surface the HUD used from MediaRecorder (state, start, stop, ondataavailable, onstop, stream).
// Nothing is uploaded anywhere: the WAV goes to the native HUD's /api/stt, transcribed on this computer, then discarded.

export const TARGET_RATE = 16000;
export const MAX_SECONDS = 30;

/** Linear-interpolation downsampling to `to` Hz (mono). */
export function downsample(input: Float32Array, from: number, to = TARGET_RATE): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, input.length - 1), f = x - i0;
    out[i] = input[i0]! * (1 - f) + input[i1]! * f;
  }
  return out;
}

/** 16-bit PCM WAV (RIFF) bytes for mono samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i]!)); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Uint8Array(buf);
}

export class PcmRecorder {
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  private chunks: Float32Array[] = [];
  private length = 0;
  private readonly node: ScriptProcessorNode;

  constructor(readonly stream: MediaStream, private readonly ctx: AudioContext, source: MediaStreamAudioSourceNode) {
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      if (this.state !== "recording") return;
      if (this.length >= ctx.sampleRate * MAX_SECONDS) { this.stop(); return; }
      const ch = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(ch));
      this.length += ch.length;
    };
    source.connect(this.node);
    // A ScriptProcessor only runs while connected to the destination; it outputs silence (nothing is played back).
    this.node.connect(ctx.destination);
  }

  start() { this.chunks = []; this.length = 0; this.state = "recording"; }

  stop() {
    if (this.state !== "recording") return;
    this.state = "inactive";
    const all = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = []; this.length = 0;
    const wav = encodeWav(downsample(all, this.ctx.sampleRate));
    this.ondataavailable?.({ data: new Blob([wav], { type: "audio/wav" }) });
    this.onstop?.();
  }

  dispose() { try { this.node.disconnect(); } catch { /* already */ } }
}

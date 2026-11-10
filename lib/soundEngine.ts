// Web Audio API & Speech Synthesis engine for D-ASK ULTRON HUD

export type ThemeColor = "amber" | "crimson" | "cyan" | "emerald";

class SoundEngine {
  private audioCtx: AudioContext | null = null;
  private muted = false;

  private initContext() {
    if (!this.audioCtx && typeof window !== "undefined") {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      void this.audioCtx.resume();
    }
  }

  public setMuted(muted: boolean) {
    this.muted = muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  /** Sci-Fi System Boot Tone */
  public playBootSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(80, now);
    osc1.frequency.exponentialRampToValueAtTime(440, now + 0.4);
    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.linearRampToValueAtTime(0.3, now + 0.1);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(880, now + 0.15);
    osc2.frequency.exponentialRampToValueAtTime(1760, now + 0.35);
    gain2.gain.setValueAtTime(0.001, now + 0.15);
    gain2.gain.linearRampToValueAtTime(0.15, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.45);
  }

  /** High-tech crisp UI click sound */
  public playClickSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.04);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  /** Hand tracking pinch / lock sound */
  public playLockSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.setValueAtTime(900, now + 0.03);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Wake Word "D-ASK" Activation Sound */
  public playWakeSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(523.25, now); // C5
    osc1.frequency.setValueAtTime(659.25, now + 0.08); // E5
    osc1.frequency.setValueAtTime(783.99, now + 0.16); // G5
    osc1.frequency.setValueAtTime(1046.5, now + 0.24); // C6

    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.linearRampToValueAtTime(0.2, now + 0.05);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);
  }

  /** Device Control Command Execution Sound */
  public playDeviceActionSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.15);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  /** AI thinking / command processing sweep */
  public playProcessSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(350, now);
    osc.frequency.linearRampToValueAtTime(750, now + 0.12);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** Warning / Alert sound */
  public playAlertSound() {
    if (this.muted) return;
    this.initContext();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.setValueAtTime(390, now + 0.1);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  }
}

/**
 * Offline text-to-speech: ONLY voices the browser engine reports as local (Windows SAPI / OneCore voices such as
 * David, Mark, Zira). Online voices ("Natural", "Online", Google) send text to a cloud service and are never used;
 * with no local voice D-ASK stays silent rather than going online.
 */
export function pickLocalVoice(voices: readonly Pick<SpeechSynthesisVoice, "name" | "lang" | "localService">[]): Pick<SpeechSynthesisVoice, "name" | "lang" | "localService"> | null {
  const local = voices.filter((v) => v.localService === true && !/\b(online|natural|google)\b/i.test(v.name));
  const en = local.filter((v) => v.lang.toLowerCase().startsWith("en"));
  return en.find((v) => /\b(david|mark)\b/i.test(v.name)) ?? en[0] ?? local[0] ?? null;
}

/** The native HUD's bridge (WebView2): speech goes to Windows SAPI there (offline by construction). */
function nativeBridge(): { postMessage(m: string): void } | null {
  if (typeof window === "undefined") return null;
  const ipc = (window as unknown as { ipc?: { postMessage?: (m: string) => void } }).ipc;
  return ipc && typeof ipc.postMessage === "function" ? (ipc as { postMessage(m: string): void }) : null;
}

class SpeechEngine {
  private enabled = true;
  private nativeTimer: number | null = null;
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const loadVoices = () => {
        this.voice = pickLocalVoice(window.speechSynthesis.getVoices()) as SpeechSynthesisVoice | null;
      };

      loadVoices();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
      }
    }
  }

  /** Interruption: stops speaking immediately (Emergency Stop, the user starts talking, a new answer). */
  public stop() {
    const native = nativeBridge();
    if (native) { native.postMessage(JSON.stringify({ type: "StopSpeaking" })); if (this.nativeTimer !== null) { clearInterval(this.nativeTimer); this.nativeTimer = null; } }
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  public hasLocalVoice(): boolean { return nativeBridge() !== null || this.voice !== null; }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  public speak(text: string, onBoundary?: (audioLevel: number) => void, onEnd?: () => void) {
    if (!this.enabled || typeof window === "undefined") {
      if (onEnd) onEnd();
      return;
    }
    const cleanText = text
      .replace(/[#*`_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanText) {
      if (onEnd) onEnd();
      return;
    }

    // Native HUD: Windows SAPI in the HUD process (local voices only). It reports no progress, so the orb animation
    // runs for an estimate of the speaking time; stop() ends both at once.
    const native = nativeBridge();
    if (native) {
      this.stop();
      native.postMessage(JSON.stringify({ type: "Speak", payload: { text: cleanText } }));
      const ms = Math.min(60_000, 600 + cleanText.split(" ").length * 380);
      const started = Date.now();
      this.nativeTimer = window.setInterval(() => {
        if (Date.now() - started >= ms) { if (this.nativeTimer !== null) clearInterval(this.nativeTimer); this.nativeTimer = null; if (onBoundary) onBoundary(0); if (onEnd) onEnd(); return; }
        if (onBoundary) onBoundary(0.3 + Math.random() * 0.7);
      }, 80);
      return;
    }

    if (!("speechSynthesis" in window)) {
      if (onEnd) onEnd();
      return;
    }
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.05;
    utterance.pitch = 0.95;

    // Never an online voice: without a local one, nothing is spoken (the default voice could be an online one).
    if (!this.voice) {
      if (onEnd) onEnd();
      return;
    }
    utterance.voice = this.voice;

    let simulateInterval: number | null = null;
    utterance.onstart = () => {
      if (onBoundary) {
        simulateInterval = window.setInterval(() => {
          const randomLevel = 0.3 + Math.random() * 0.7;
          onBoundary(randomLevel);
        }, 80);
      }
    };

    const cleanup = () => {
      if (simulateInterval !== null) {
        clearInterval(simulateInterval);
        simulateInterval = null;
      }
      if (onBoundary) onBoundary(0);
      if (onEnd) onEnd();
    };

    utterance.onend = cleanup;
    utterance.onerror = cleanup;

    window.speechSynthesis.speak(utterance);
  }
}

export const soundFx = new SoundEngine();
export const speechFx = new SpeechEngine();

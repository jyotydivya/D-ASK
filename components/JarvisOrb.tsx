"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi, type TelemetryData } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { soundFx, speechFx, type ThemeColor } from "@/lib/soundEngine";
import DevicePanel from "@/components/DevicePanel";
import type { DeviceInfo } from "@/app/api/devices/route";

type CameraState = "off" | "starting" | "on" | "error";
type VoiceState = "idle" | "listening" | "unsupported" | "error";

type VoiceRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { resultIndex?: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  onend: (() => void) | null;
};

type VoiceRecognitionConstructor = new () => VoiceRecognition;

type CommandEntry = {
  id: string;
  command: string;
  response: string;
  time: string;
};

const COMMAND_HISTORY_KEY = "ultron-command-history";
const MAX_HISTORY_ENTRIES = 8;

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

const THEMES: { key: ThemeColor; label: string; color: string }[] = [
  { key: "amber", label: "AMBER", color: "#ffaa30" },
  { key: "crimson", label: "CRIMSON", color: "#ff2244" },
  { key: "cyan", label: "CYAN", color: "#00e5ff" },
  { key: "emerald", label: "EMERALD", color: "#00ff88" },
];

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const voiceRecognitionRef = useRef<VoiceRecognition | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const wakeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<CommandEntry[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [aiThinking, setAiThinking] = useState(false);
  const [wakeActive, setWakeActive] = useState(false);

  // Device Link State
  const [activeDevice, setActiveDevice] = useState<DeviceInfo | null>(null);
  const [hasPhysicalDevice, setHasPhysicalDevice] = useState(false);
  const [deviceExecuting, setDeviceExecuting] = useState(false);

  // Telemetry & Customizations
  const [currentTheme, setCurrentTheme] = useState<ThemeColor>("amber");
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    rotXDeg: 0,
    rotYDeg: 0,
    zoomDist: 5.5,
    fps: 60,
    particleCount: 3950,
  });

  // Poll connected devices from API
  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      const data = (await res.json()) as { activeDevice?: DeviceInfo; hasPhysicalDevice?: boolean };
      if (data.activeDevice) {
        setActiveDevice(data.activeDevice);
      }
      setHasPhysicalDevice(!!data.hasPhysicalDevice);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    void fetchDevices();
    const interval = setInterval(fetchDevices, 2500);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  // Execute Device Action Command (Physical Real Device Control)
  const controlDevice = useCallback(
    async (action: string, payload?: { targetApp?: string; searchQuery?: string; deviceIp?: string; pinCode?: string }) => {
      setDeviceExecuting(true);
      soundFx.playDeviceActionSound();
      try {
        const savedPin = window.localStorage.getItem("ultron-device-pin") || undefined;
        const res = await fetch("/api/devices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            pinCode: payload?.pinCode || savedPin,
            ...payload,
          }),
        });

        let data: { result?: string; error?: string; activeDevice?: DeviceInfo } = {};
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: `SERVER RESPONSE ERROR (${res.status}): ${text.slice(0, 100)}` };
        }

        if (data.activeDevice) setActiveDevice(data.activeDevice);
        if (!res.ok || data.error) {
          soundFx.playAlertSound();
          return data.error || `FAILED TO EXECUTE ${action.toUpperCase()} ON PHONE`;
        }
        return data.result || `EXECUTED ${action.toUpperCase()} ON YOUR PHONE`;
      } catch (err) {
        soundFx.playAlertSound();
        const msg = err instanceof Error ? err.message : String(err);
        return `ERROR: ${msg}`;
      } finally {
        setDeviceExecuting(false);
      }
    },
    [],
  );

  // Boot scene & sound
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = createOrbScene(container);
    sceneRef.current = scene;

    soundFx.playBootSound();

    const telemInterval = setInterval(() => {
      if (sceneRef.current) {
        setTelemetry(sceneRef.current.getTelemetry());
      }
    }, 150);

    return () => {
      clearInterval(telemInterval);
      trackerRef.current?.stop();
      trackerRef.current = null;
      voiceRecognitionRef.current?.stop();
      voiceRecognitionRef.current = null;
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close();
      }
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", currentTheme);
    sceneRef.current?.setTheme(currentTheme);
  }, [currentTheme]);

  useEffect(() => {
    const savedHistory = window.localStorage.getItem(COMMAND_HISTORY_KEY);
    if (!savedHistory) return;

    try {
      const parsed = JSON.parse(savedHistory) as CommandEntry[];
      if (Array.isArray(parsed)) setHistory(parsed.slice(0, MAX_HISTORY_ENTRIES));
    } catch {
      window.localStorage.removeItem(COMMAND_HISTORY_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  const changeTheme = useCallback((theme: ThemeColor) => {
    setCurrentTheme(theme);
    sceneRef.current?.setTheme(theme);
    if (theme === "crimson") {
      soundFx.playAlertSound();
    } else {
      soundFx.playProcessSound();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const muted = soundFx.toggleMute();
    setIsMuted(muted);
  }, []);

  const toggleSpeech = useCallback(() => {
    const enabled = speechFx.toggle();
    setIsSpeechEnabled(enabled);
    if (enabled) soundFx.playClickSound();
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
    soundFx.playClickSound();
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);
    soundFx.playProcessSound();

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
      soundFx.playLockSound();
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
      soundFx.playAlertSound();
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const speakResponse = useCallback(
    (text: string) => {
      if (!isSpeechEnabled) return;
      speechFx.speak(
        text,
        (level) => {
          setAudioLevel(level);
          sceneRef.current?.setAudioLevel(level);
        },
        () => {
          setAudioLevel(0);
          sceneRef.current?.setAudioLevel(0);
        },
      );
    },
    [isSpeechEnabled],
  );

  const addHistoryEntry = useCallback(
    (commandText: string, response: string) => {
      const entry: CommandEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        command: commandText,
        response,
        time: new Intl.DateTimeFormat("en", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date()),
      };
      setHistory((current) => [entry, ...current].slice(0, MAX_HISTORY_ENTRIES));
      speakResponse(response);
    },
    [speakResponse],
  );

  const askAssistant = useCallback(
    async (prompt: string) => {
      setAiThinking(true);
      soundFx.playProcessSound();
      try {
        const response = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt }),
        });
        const data = (await response.json()) as { reply?: string; error?: string };
        const replyText = data.reply ?? data.error ?? "D-ASK DID NOT RETURN A RESPONSE.";
        addHistoryEntry("D-ASK", replyText);
      } catch {
        addHistoryEntry("D-ASK", "CONNECTION FAILED · CHECK LOCAL SERVER.");
      } finally {
        setAiThinking(false);
      }
    },
    [addHistoryEntry],
  );

  // Command Execution (Orb HUD & Device Controls)
  const runCommand = useCallback(
    async (rawCommand: string) => {
      soundFx.playClickSound();
      const normalized = rawCommand
        .trim()
        .toLowerCase()
        .replace(/[.!?,;:]+$/g, "")
        .replace(/\s+/g, " ");
      if (!normalized) return;

      if (normalized === "clear" || normalized === "clear history") {
        setHistory([]);
        setCommand("");
        return;
      }

      let response: string;

      // Device Control Commands
      if (normalized.includes("open youtube") || normalized === "youtube") {
        response = await controlDevice("launch_app", { targetApp: "youtube" });
      } else if (normalized.includes("open instagram") || normalized === "instagram") {
        response = await controlDevice("launch_app", { targetApp: "instagram" });
      } else if (normalized.includes("open camera") || normalized === "camera") {
        response = await controlDevice("launch_app", { targetApp: "camera" });
      } else if (normalized.includes("unlock phone") || normalized.includes("unlock device") || normalized === "unlock") {
        response = await controlDevice("unlock");
      } else if (normalized.includes("lock phone") || normalized.includes("lock device")) {
        response = await controlDevice("lock");
      } else if (normalized.includes("go home") || normalized === "home") {
        response = await controlDevice("go_home");
      } else if (normalized.includes("take screenshot") || normalized === "screenshot") {
        response = await controlDevice("take_screenshot");
      } else if (normalized.includes("volume up") || normalized === "vol+") {
        response = await controlDevice("volume_up");
      } else if (normalized.includes("volume down") || normalized === "vol-") {
        response = await controlDevice("volume_down");
      } else if (normalized.includes("search youtube for")) {
        const query = rawCommand.replace(/.*search youtube for/i, "").trim();
        response = await controlDevice("search_youtube", { searchQuery: query });
      } else if (normalized === "device status" || normalized === "connected devices") {
        response = activeDevice && activeDevice.status === "CONNECTED"
          ? `DEVICE ${activeDevice.name} IS CONNECTED VIA ${activeDevice.connectionType} · BATTERY: ${activeDevice.batteryLevel}%`
          : "NO PHYSICAL PHONE CONNECTED VIA ADB OR BLUETOOTH.";
      }
      // Orb UI Commands
      else if (normalized === "help" || normalized === "commands") {
        response = "COMMANDS: STATUS, OPEN YOUTUBE, UNLOCK PHONE, TAKE SCREENSHOT, RED ALERT, CYAN, AMBER, EMERALD, MUTE, SPEECH, CLEAR";
      } else if (normalized === "status" || normalized === "system check") {
        response = camera === "on"
          ? `${status.hands} HAND(S) DETECTED · MODE: ${MODE_LABEL[status.mode]} · ZOOM: ${telemetry.zoomDist}x · FPS: ${telemetry.fps}`
          : `D-ASK ONLINE · CORE: ACTIVE · ZOOM: ${telemetry.zoomDist}x · FPS: ${telemetry.fps}`;
      } else if (normalized === "zoom in" || normalized === "zoom +") {
        sceneRef.current?.zoomIn();
        response = "VISUAL CORE MAGNIFIED";
      } else if (normalized === "zoom out" || normalized === "zoom -") {
        sceneRef.current?.zoomOut();
        response = "VISUAL CORE RETRACTED";
      } else if (normalized === "reset" || normalized === "reset view") {
        sceneRef.current?.resetView();
        response = "VIEW RECALIBRATED";
      } else if (normalized === "red alert" || normalized === "alert" || normalized === "crimson") {
        changeTheme("crimson");
        response = "RED ALERT ENGAGED · WARNING PROTOCOLS ACTIVE";
      } else if (normalized === "cyan" || normalized === "blue" || normalized === "arc mode") {
        changeTheme("cyan");
        response = "ARC REACTOR CYAN FREQUENCY ENGAGED";
      } else if (normalized === "amber" || normalized === "gold" || normalized === "ultron") {
        changeTheme("amber");
        response = "STANDARD ULTRON AMBER MATRIX ACTIVE";
      } else if (normalized === "emerald" || normalized === "green" || normalized === "matrix") {
        changeTheme("emerald");
        response = "STEALTH EMERALD MATRIX ENGAGED";
      } else if (normalized === "mute" || normalized === "unmute") {
        toggleMute();
        response = soundFx.isMuted() ? "AUDIO SOUND EFFECTS MUTED" : "AUDIO SOUND EFFECTS UNMUTED";
      } else if (normalized === "speech" || normalized === "speech on" || normalized === "speech off") {
        toggleSpeech();
        response = speechFx.isEnabled() ? "D-ASK VOICE OUTPUT ENABLED" : "D-ASK VOICE OUTPUT MUTED";
      } else if (normalized === "gestures on" || normalized === "enable gestures") {
        if (trackerRef.current) response = "GESTURE TRACKING ALREADY ACTIVE";
        else {
          void startGestures();
          response = "INITIALIZING GESTURE TRACKING";
        }
      } else if (normalized === "gestures off" || normalized === "disable gestures") {
        if (!trackerRef.current) response = "GESTURE TRACKING ALREADY STANDBY";
        else {
          stopGestures();
          response = "GESTURE TRACKING STANDBY";
        }
      } else {
        addHistoryEntry(rawCommand.trim().toUpperCase(), "D-ASK IS PROCESSING YOUR REQUEST...");
        setCommand("");
        void askAssistant(rawCommand.trim());
        return;
      }

      addHistoryEntry(rawCommand.trim().toUpperCase(), response);
      setCommand("");
    },
    [activeDevice, addHistoryEntry, askAssistant, camera, changeTheme, controlDevice, startGestures, status, stopGestures, telemetry.fps, telemetry.zoomDist, toggleMute, toggleSpeech],
  );

  // Trigger wake-word test manually
  const triggerWakeWord = useCallback(() => {
    soundFx.playWakeSound();
    setWakeActive(true);
    if (wakeTimeoutRef.current) clearTimeout(wakeTimeoutRef.current);
    wakeTimeoutRef.current = setTimeout(() => setWakeActive(false), 5000);
    addHistoryEntry("WAKE WORD DETECTED", "YES BOSS? D-ASK IS ONLINE AND LISTENING...");
  }, [addHistoryEntry]);

  // Voice Recognition with Mic Audio Visualizer Hook & Network Error Suppression
  const toggleVoiceInput = useCallback(async () => {
    soundFx.playClickSound();
    if (voiceRecognitionRef.current) {
      voiceRecognitionRef.current.stop();
      voiceRecognitionRef.current = null;
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
      setVoiceState("idle");
      setAudioLevel(0);
      return;
    }

    const voiceWindow = window as Window & {
      SpeechRecognition?: VoiceRecognitionConstructor;
      webkitSpeechRecognition?: VoiceRecognitionConstructor;
    };
    const Recognition = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceState("unsupported");
      addHistoryEntry("VOICE INPUT", "VOICE RECOGNITION IS NOT SUPPORTED IN THIS BROWSER");
      return;
    }

    // 1. Explicitly request real microphone permission
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // Setup Web Audio Analyser to convert real mic volume to audioLevel
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const checkVolume = () => {
        if (!micStreamRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const normalized = Math.min(1, avg / 128);
        setAudioLevel(normalized);
        sceneRef.current?.setAudioLevel(normalized);
        requestAnimationFrame(checkVolume);
      };
      checkVolume();
    } catch {
      setVoiceState("error");
      addHistoryEntry("VOICE INPUT", "MICROPHONE PERMISSION DENIED · ALLOW MIC ACCESS");
      return;
    }

    // 2. Initialize Web Speech Recognition Engine with interim streaming
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const startIdx = event.resultIndex ?? 0;
      for (let i = startIdx; i < event.results.length; i++) {
        const item = event.results[i];
        if (!item) continue;
        const transcript = item[0]?.transcript?.trim();
        if (!transcript) continue;

        const isFinal = (item as unknown as { isFinal?: boolean }).isFinal;

        // Phonetic wake-word regex pattern
        const wakeMatch = /(?:^|\b)(?:d[\s-]*ask|the[\s-]*ask|deask|task|desk|hey[\s-]*d[\s-]*ask|jarvis|ultron)\b/i.exec(transcript);

        if (wakeMatch && wakeMatch.index !== undefined) {
          soundFx.playWakeSound();
          setWakeActive(true);
          if (wakeTimeoutRef.current) clearTimeout(wakeTimeoutRef.current);
          wakeTimeoutRef.current = setTimeout(() => setWakeActive(false), 5000);

          const requestedCommand = transcript
            .slice(wakeMatch.index + wakeMatch[0].length)
            .replace(/^[\s,.:;!?-]+/, "")
            .trim();

          if (requestedCommand && isFinal) {
            void runCommand(requestedCommand);
          } else if (!requestedCommand && isFinal) {
            addHistoryEntry("D-ASK WAKE WORD", "YES BOSS? D-ASK IS ONLINE AND LISTENING...");
          }
        } else if (wakeActive && isFinal) {
          void runCommand(transcript);
        }
      }
    };

    recognition.onerror = (event) => {
      const errStr = event.error ? String(event.error).toUpperCase() : "ERROR";
      if (errStr === "NO-SPEECH" || errStr === "NETWORK") {
        return;
      }
      setVoiceState("error");
    };

    recognition.onend = () => {
      if (voiceRecognitionRef.current !== recognition) {
        setVoiceState((current) => (current === "error" ? "error" : "idle"));
        return;
      }
      window.setTimeout(() => {
        if (voiceRecognitionRef.current !== recognition) return;
        try {
          recognition.start();
        } catch {
          // Retry
        }
      }, 300);
    };

    voiceRecognitionRef.current = recognition;
    setVoiceState("listening");
    soundFx.playWakeSound();
    try {
      recognition.start();
    } catch {
      // Ignore initial start retry
    }
  }, [addHistoryEntry, runCommand, wakeActive]);

  // Keyboard controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          soundFx.playClickSound();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          soundFx.playClickSound();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          soundFx.playClickSound();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          void toggleVoiceInput();
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "s":
        case "S":
          toggleSpeech();
          break;
        case "c":
        case "C": {
          const themes: ThemeColor[] = ["amber", "crimson", "cyan", "emerald"];
          const nextIdx = (themes.indexOf(currentTheme) + 1) % themes.length;
          changeTheme(themes[nextIdx]);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeTheme, currentTheme, toggleGestures, toggleMute, toggleSpeech, toggleVoiceInput]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      {/* Holographic Overlay Layers */}
      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      {/* Screen HUD Corner Brackets */}
      <div className="hud-corner bracket-tl" />
      <div className="hud-corner bracket-tr" />
      <div className="hud-corner bracket-bl" />
      <div className="hud-corner bracket-br" />

      {/* Wake Word Activation Glowing Banner */}
      {wakeActive && (
        <div className="wake-banner" aria-live="assertive">
          <span className="wake-icon">⚡</span>
          <span className="wake-text">WAKE WORD DETECTED // D-ASK LISTENING</span>
        </div>
      )}

      {/* Top Left Title & Telemetry Header */}
      <header className="hud hud-header">
        <div className="hud-title">D-ASK</div>
        <div className="hud-telemetry" aria-label="Orb Telemetry Readout">
          <div><span>PITCH:</span> {telemetry.rotXDeg}°</div>
          <div><span>YAW:</span> {telemetry.rotYDeg}°</div>
          <div><span>ZOOM:</span> {telemetry.zoomDist}x</div>
          <div><span>FPS:</span> {telemetry.fps}</div>
          <div><span>PARTICLES:</span> {telemetry.particleCount}</div>
        </div>
      </header>

      {/* Connected Devices HUD Panel */}
      <DevicePanel
        device={activeDevice}
        hasPhysicalDevice={hasPhysicalDevice}
        onControlDevice={(act, payload) => {
          void (async () => {
            const res = await controlDevice(act, payload);
            addHistoryEntry("DEVICE CONTROL", res);
          })();
        }}
        onRefreshDevices={() => void fetchDevices()}
        isExecuting={deviceExecuting}
      />

      {/* Top Right Main Console */}
      <section className="hud command-console" aria-label="Ultron command console">
        <div className="console-header">
          <span>D-ASK // CORE CONSOLE</span>
          <div className="console-statuses">
            {aiThinking && <span className="ai-state">THINKING</span>}
            <span className="voice-state" data-state={voiceState}>
              {voiceState === "listening" ? "ARMED" : voiceState === "unsupported" ? "VOICE N/A" : voiceState === "error" ? "ERROR" : "VOICE"}
            </span>
            <span className="console-indicator">ONLINE</span>
          </div>
        </div>

        {/* Dynamic 8-Bar Audio Spectrum Equalizer */}
        <div className="audio-equalizer" data-active={voiceState === "listening" || audioLevel > 0}>
          {[0.6, 0.9, 0.4, 1.0, 0.7, 0.5, 0.85, 0.3].map((heightMult, i) => (
            <div
              key={i}
              className="eq-bar"
              style={{
                height: `${Math.max(15, Math.round((audioLevel || (voiceState === "listening" ? 0.4 : 0.15)) * heightMult * 100))}%`,
              }}
            />
          ))}
        </div>

        <form
          className="command-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runCommand(command);
          }}
        >
          <label className="sr-only" htmlFor="ultron-command">Enter a command</label>
          <span className="command-prompt">&gt;_</span>
          <input
            id="ultron-command"
            className="command-input"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="SAY 'D-ASK OPEN YOUTUBE'..."
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="command-submit" aria-label="Run command">RUN</button>
        </form>

        <div className="command-shortcuts" aria-label="Command shortcuts">
          {["STATUS", "OPEN YOUTUBE", "UNLOCK PHONE", "RED ALERT", "HELP"].map((shortcut) => (
            <button key={shortcut} type="button" onClick={() => void runCommand(shortcut)}>{shortcut}</button>
          ))}
          <button
            type="button"
            className="voice-button"
            data-listening={voiceState === "listening"}
            onClick={() => void toggleVoiceInput()}
            aria-pressed={voiceState === "listening"}
          >
            {voiceState === "listening" ? "ARMED (V)" : "ARM VOICE (V)"}
          </button>
          <button
            type="button"
            className="wake-test-button"
            onClick={triggerWakeWord}
            title="Test Wake Word Activation"
          >
            WAKE TEST
          </button>
        </div>

        <div className="command-history" aria-live="polite">
          {history.length === 0 ? (
            <p className="command-empty">SYSTEM INITIALIZED · TYPE A COMMAND OR SAY "D-ASK"</p>
          ) : (
            history.map((entry) => (
              <article key={entry.id} className="history-entry">
                <div><time>{entry.time}</time><span>&gt; {entry.command}</span></div>
                <p style={{ color: entry.response.includes("NO PHYSICAL PHONE") || entry.response.includes("ERROR") || entry.response.includes("FAILED") ? "#ff5533" : "inherit" }}>
                  {entry.response}
                </p>
              </article>
            ))
          )}
        </div>
      </section>

      {/* Bottom Left Controls Hint */}
      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> gestures&nbsp;&nbsp;
            <span className="key">V</span> voice&nbsp;&nbsp;
            <span className="key">C</span> themes&nbsp;&nbsp;
            <span className="key">M</span> mute&nbsp;&nbsp;
            <span className="key">S</span> speech&nbsp;&nbsp;
            <span className="key">R</span> reset
          </div>
        )}
      </div>

      {/* Bottom Right Controls & Webcam HUD */}
      <div className="hud hud-controls">
        {/* Theme Switcher Palette Selector */}
        <div className="theme-selector" aria-label="Color Themes">
          {THEMES.map((th) => (
            <button
              key={th.key}
              type="button"
              className="theme-btn"
              data-active={currentTheme === th.key}
              style={{ "--theme-accent": th.color } as React.CSSProperties}
              onClick={() => changeTheme(th.key)}
              title={`Switch to ${th.label} theme`}
            >
              {th.label}
            </button>
          ))}
        </div>

        {/* Mirrored Camera Preview Panel */}
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}${status.pinchPercent ? ` (${status.pinchPercent}%)` : ""}`
              : "AWAITING HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON (G)" : "GESTURES OFF (G)"}
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={isMuted}
            onClick={toggleMute}
            title="Toggle Sound Effects (M)"
          >
            {isMuted ? "SOUND OFF (M)" : "SOUND ON (M)"}
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={isSpeechEnabled}
            onClick={toggleSpeech}
            title="Toggle Speech TTS (S)"
          >
            {isSpeechEnabled ? "VOICE ON (S)" : "VOICE OFF (S)"}
          </button>
        </div>

        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => { sceneRef.current?.zoomIn(); soundFx.playClickSound(); }} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => { sceneRef.current?.zoomOut(); soundFx.playClickSound(); }} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => { sceneRef.current?.resetView(); soundFx.playClickSound(); }}>
            RESET (R)
          </button>
        </div>
      </div>
    </>
  );
}

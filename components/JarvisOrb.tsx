"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi, type TelemetryData } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { soundFx, speechFx, type ThemeColor } from "@/lib/soundEngine";
import DevicePanel from "@/components/DevicePanel";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";
import { useTask } from "@/hooks/useTask";
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

// ── Local command matcher — handles UI and device commands with NO API call ───
type LocalCommand = {
  command: string;
  theme?: string;
  // device fields
  deviceCommand?: "launch_app" | "lock" | "unlock" | "volume_up" | "volume_down" | "home" | "screenshot" | "search_youtube";
  targetApp?: string;
  searchQuery?: string;
} | null;

// Known apps users might ask for
const APP_ALIASES: Record<string, string> = {
  youtube: "youtube", yt: "youtube",
  instagram: "instagram", insta: "instagram",
  camera: "camera",
  chrome: "chrome", google: "chrome",
  spotify: "spotify",
  maps: "maps", "google maps": "maps",
};

function matchLocalCommand(normalized: string, hasPhone: boolean = false): LocalCommand {
  // ── UI / Orb commands ──────────────────────────────────────────────────────
  if (normalized === "clear" || normalized === "clear history") return { command: "clear" };
  if (normalized.includes("zoom in") || normalized === "zoom +") return { command: "zoom_in" };
  if (normalized.includes("zoom out") || normalized === "zoom -") return { command: "zoom_out" };
  if (normalized.includes("reset view") || normalized === "reset") return { command: "reset_view" };
  if (normalized.includes("mute") && !normalized.includes("unmute")) return { command: "mute" };
  if (normalized.includes("unmute")) return { command: "unmute" };
  if (normalized.includes("speech on") || normalized.includes("voice on")) return { command: "speech_on" };
  if (normalized.includes("speech off") || normalized.includes("voice off")) return { command: "speech_off" };
  if (normalized.includes("gesture") && normalized.includes("on")) return { command: "gestures_on" };
  if (normalized.includes("gesture") && normalized.includes("off")) return { command: "gestures_off" };
  for (const { key } of THEMES) {
    if (normalized.includes(`theme ${key}`) || normalized.includes(`${key} theme`) || normalized === key) {
      return { command: "theme", theme: key };
    }
  }

  // ── Device commands (zero API calls needed) ────────────────────────────────
  // Only intercept device commands if a physical phone is actually connected or explicitly targeted
  const mentionsPhone = /\b(phone|android|mobile)\b/.test(normalized);
  if (!hasPhone && !mentionsPhone) {
    return null;
  }

  // Lock
  if (/\b(lock|sleep)\b.*\b(phone|device|screen)?\b/.test(normalized) && !normalized.includes("unlock")) {
    return { command: "device", deviceCommand: "lock" };
  }
  // Unlock
  if (/\b(unlock|wake up|wake)\b.*\b(phone|device|screen)?\b/.test(normalized)) {
    return { command: "device", deviceCommand: "unlock" };
  }
  // Volume up
  if (/\b(volume up|vol up|increase volume|louder)\b/.test(normalized)) {
    return { command: "device", deviceCommand: "volume_up" };
  }
  // Volume down
  if (/\b(volume down|vol down|decrease volume|quieter|lower volume)\b/.test(normalized)) {
    return { command: "device", deviceCommand: "volume_down" };
  }
  // Home button
  if (/\b(go home|press home|home button|home screen)\b/.test(normalized)) {
    return { command: "device", deviceCommand: "home" };
  }
  // Screenshot
  if (/\b(take screenshot|screenshot|screen cap|screen capture)\b/.test(normalized)) {
    return { command: "device", deviceCommand: "screenshot" };
  }
  // YouTube search: "search youtube for X" / "youtube search X" / "play X on youtube"
  const ytSearch = normalized.match(/(?:search youtube for|youtube search|search for|play)\s+(.+?)(?:\s+on youtube)?$/);
  if (ytSearch && (normalized.includes("youtube") || normalized.includes("search"))) {
    const query = ytSearch[1]!.trim();
    if (query.length > 1) return { command: "device", deviceCommand: "search_youtube", searchQuery: query };
  }
  // Launch app: "open X" / "launch X" / "start X"
  // Reject generic words that mean nothing ("launch app", "open application", etc.)
  const JUNK_APP_NAMES = new Set(["app", "application", "the app", "it", "that", "this", "the"]);
  const launchMatch = normalized.match(/^(?:open|launch|start|run)\s+(.+)$/);
  if (launchMatch) {
    const appName = launchMatch[1]!.trim();
    if (!JUNK_APP_NAMES.has(appName) && appName.length > 1) {
      const resolved = APP_ALIASES[appName] ?? appName;
      return { command: "device", deviceCommand: "launch_app", targetApp: resolved };
    }
  }

  return null;
}


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
  // Debounce: prevent the same command from firing twice within 5 seconds
  const lastCommandRef = useRef<{ text: string; time: number } | null>(null);
  // TTS echo guard: true while D-ASK is speaking — suppresses mic input
  const isSpeakingRef = useRef<boolean>(false);
  
  // Groq STT Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isRecordingRef = useRef(false);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<CommandEntry[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [aiThinking, setAiThinking] = useState(false);
  const [wakeActive, setWakeActive] = useState(false);

  // ── Agentic Task System ──────────────────────────────────────────────────
  // Callbacks update history ONCE when the task terminates
  const taskCallbacksRef = useRef({
    onComplete: (response: string) => {
      setAiThinking(false);
      // Replace the ⏳ placeholder with the real result
      setHistory((current) => {
        const updated = [...current];
        const idx = updated.findIndex((e) => e.response.startsWith("⏳"));
        if (idx >= 0) updated[idx] = { ...updated[idx]!, response };
        else updated.unshift({ id: `done-${Date.now()}`, command: "TASK", response, time: new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit" }) });
        return updated;
      });
      soundFx.playLockSound();
    },
    onFail: (error: string) => {
      setAiThinking(false);
      setHistory((current) => {
        const updated = [...current];
        const idx = updated.findIndex((e) => e.response.startsWith("⏳"));
        const msg = `✗ ${error}`;
        if (idx >= 0) updated[idx] = { ...updated[idx]!, response: msg };
        else updated.unshift({ id: `fail-${Date.now()}`, command: "TASK", response: msg, time: new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit" }) });
        return updated;
      });
      soundFx.playAlertSound();
    },
  });

  const {
    isActive: taskActive,
    orbState,
    lastMessage: taskMessage,
    events: taskEvents,
    nodes: taskNodes,
    progressPct,
    taskId: activeTaskId,
    submitTask,
    cancelTask,
  } = useTask({
    onComplete: (response) => taskCallbacksRef.current.onComplete(response),
    onFail: (error) => taskCallbacksRef.current.onFail(error),
  });

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
            broadcastAll: true,
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
      // Set speaking guard: suppresses mic input while D-ASK is talking
      isSpeakingRef.current = true;
      speechFx.speak(
        text,
        (level) => {
          setAudioLevel(level);
          sceneRef.current?.setAudioLevel(level);
        },
        () => {
          setAudioLevel(0);
          sceneRef.current?.setAudioLevel(0);
          // Re-enable mic input 1.2 seconds after speech ends
          setTimeout(() => { isSpeakingRef.current = false; }, 1200);
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

  // ── Command routing ───────────────────────────────────────────────────────
  // 1. Pure local UI commands (zoom/theme/mute) → handled instantly, no API.
  // 2. Device / simple AI commands → /api/assistant (ONE Gemini call).
  // 3. Complex multi-step tasks → orchestrator (future).
  const askAssistant = useCallback(
    async (prompt: string) => {
      // Guard: don't submit a new task while one is already in progress
      if (aiThinking || taskActive) return;
      soundFx.playProcessSound();
      const normalized = prompt.trim().toLowerCase();

      // Fast-path: pure orb/UI commands handled locally (device commands only if phone connected)
      const localOrbCommand = matchLocalCommand(normalized, hasPhysicalDevice);
      if (localOrbCommand) {
        switch (localOrbCommand.command) {
          case "theme":
            if (localOrbCommand.theme) changeTheme(localOrbCommand.theme as ThemeColor);
            addHistoryEntry(prompt.toUpperCase(), `THEME SET: ${localOrbCommand.theme?.toUpperCase()}`);
            return;
          case "zoom_in":
            sceneRef.current?.zoomIn();
            addHistoryEntry(prompt.toUpperCase(), "ZOOM IN");
            return;
          case "zoom_out":
            sceneRef.current?.zoomOut();
            addHistoryEntry(prompt.toUpperCase(), "ZOOM OUT");
            return;
          case "reset_view":
            sceneRef.current?.resetView();
            addHistoryEntry(prompt.toUpperCase(), "VIEW RESET");
            return;
          case "mute":
            if (!soundFx.isMuted()) toggleMute();
            addHistoryEntry(prompt.toUpperCase(), "SOUND MUTED");
            return;
          case "unmute":
            if (soundFx.isMuted()) toggleMute();
            addHistoryEntry(prompt.toUpperCase(), "SOUND ENABLED");
            return;
          case "speech_on":
            if (!isSpeechEnabled) toggleSpeech();
            addHistoryEntry(prompt.toUpperCase(), "VOICE SYNTHESIS ENABLED");
            return;
          case "speech_off":
            if (isSpeechEnabled) toggleSpeech();
            addHistoryEntry(prompt.toUpperCase(), "VOICE SYNTHESIS DISABLED");
            return;
          case "gestures_on":
            if (!trackerRef.current) void startGestures();
            addHistoryEntry(prompt.toUpperCase(), "GESTURE TRACKING ENABLED");
            return;
          case "gestures_off":
            if (trackerRef.current) stopGestures();
            addHistoryEntry(prompt.toUpperCase(), "GESTURE TRACKING DISABLED");
            return;
          case "clear":
            setHistory([]);
            setCommand("");
            return;

          // ── Device commands — zero API calls ─────────────────────────────
          case "device": {
            const dc = localOrbCommand.deviceCommand;
            if (!dc) return;
            addHistoryEntry(prompt.toUpperCase(), `⏳ ${dc.replace(/_/g, " ").toUpperCase()}...`);
            let result: string;
            try {
              if (dc === "launch_app") {
                result = await controlDevice("launch_app", { targetApp: localOrbCommand.targetApp ?? "" });
              } else if (dc === "search_youtube") {
                result = await controlDevice("search_youtube", { searchQuery: localOrbCommand.searchQuery ?? "" });
              } else {
                result = await controlDevice(dc, {});
              }
            } catch (e) {
              result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
            }
            setHistory((current) => {
              const u = [...current];
              const i = u.findLastIndex((e) => e.command === prompt.toUpperCase());
              if (i >= 0) u[i] = { ...u[i]!, response: result };
              return u;
            });
            soundFx.playLockSound();
            return;
          }
        }
      }

      // Lightweight path: /api/assistant (ONE Gemini call — only for unknown/conversational input)
      setAiThinking(true);
      addHistoryEntry(prompt.toUpperCase(), "⏳ D-ASK PROCESSING...");

      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt.trim() }),
        });

        const data = await res.json() as {
          reply: string;
          actionType: "device" | "orb" | "task" | "none";
          actionCommand?: string;
          actionPayload?: { targetApp?: string; theme?: string; searchQuery?: string };
        };

        // Orb-level AI commands
        if (data.actionType === "orb" && data.actionCommand) {
          switch (data.actionCommand) {
            case "theme": if (data.actionPayload?.theme) changeTheme(data.actionPayload.theme as ThemeColor); break;
            case "zoom_in": sceneRef.current?.zoomIn(); break;
            case "zoom_out": sceneRef.current?.zoomOut(); break;
            case "reset_view": sceneRef.current?.resetView(); break;
            case "mute": if (!soundFx.isMuted()) toggleMute(); break;
            case "unmute": if (soundFx.isMuted()) toggleMute(); break;
            case "speech_on": if (!isSpeechEnabled) toggleSpeech(); break;
            case "speech_off": if (isSpeechEnabled) toggleSpeech(); break;
          }
          setHistory((current) => {
            const u = [...current];
            const i = u.findIndex((e) => e.response.startsWith("⏳"));
            if (i >= 0) u[i] = { ...u[i]!, response: data.reply || "COMMAND EXECUTED" };
            return u;
          });
          setAiThinking(false);
          return;
        }

        // Device commands directly (no orchestrator)
        if (data.actionType === "device" && data.actionCommand) {
          setHistory((current) => {
            const u = [...current];
            const i = u.findIndex((e) => e.response.startsWith("⏳"));
            if (i >= 0) u[i] = { ...u[i]!, response: data.reply || "⏳ EXECUTING ON DEVICE..." };
            return u;
          });
          const payload = data.actionPayload ?? {};
          let deviceResult: string;
          if (data.actionCommand === "launch_app" && payload.targetApp) {
            deviceResult = await controlDevice("launch_app", { targetApp: payload.targetApp });
          } else if (data.actionCommand === "search_youtube" && payload.searchQuery) {
            deviceResult = await controlDevice("search_youtube", { searchQuery: payload.searchQuery });
          } else {
            deviceResult = await controlDevice(data.actionCommand, {});
          }
          setHistory((current) => {
            const u = [...current];
            const i = u.findLastIndex((e) => e.command === prompt.toUpperCase());
            if (i >= 0) u[i] = { ...u[i]!, response: deviceResult };
            return u;
          });
          soundFx.playLockSound();
          setAiThinking(false);
          return;
        }

        // Orchestrator task (complex PC actions, files, browsing, etc)
        if (data.actionType === "task") {
          const reply = data.reply || "INITIALIZING PROTOCOL...";
          setHistory((current) => {
            const u = [...current];
            const i = u.findIndex((e) => e.response.startsWith("⏳"));
            if (i >= 0) u[i] = { ...u[i]!, response: reply };
            return u;
          });
          speakResponse(reply);
          // Pass the original prompt to the orchestrator
          void submitTask(prompt);
          // Don't setAiThinking(false) yet, the useTask hook handles its own loading state (taskActive)
          return;
        }

        // Conversation
        const reply = data.reply || "ACKNOWLEDGED.";
        setHistory((current) => {
          const u = [...current];
          const i = u.findIndex((e) => e.response.startsWith("⏳"));
          if (i >= 0) u[i] = { ...u[i]!, response: reply };
          return u;
        });
        speakResponse(reply);
        setAiThinking(false);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setHistory((current) => {
          const u = [...current];
          const i = u.findIndex((e) => e.response.startsWith("⏳"));
          if (i >= 0) u[i] = { ...u[i]!, response: `ERROR: ${msg}` };
          return u;
        });
        soundFx.playAlertSound();
        setAiThinking(false);
      }
    },
    [addHistoryEntry, aiThinking, taskActive, changeTheme, controlDevice, isSpeechEnabled, speakResponse, startGestures, stopGestures, toggleMute, toggleSpeech, submitTask],
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

      // Debounce: ignore if the exact same command ran within the last 5 seconds
      const now = Date.now();
      if (
        lastCommandRef.current &&
        lastCommandRef.current.text === normalized &&
        now - lastCommandRef.current.time < 5000
      ) {
        return;
      }
      lastCommandRef.current = { text: normalized, time: now };

      if (normalized === "clear" || normalized === "clear history") {
        setHistory([]);
        setCommand("");
        return;
      }

      setCommand("");
      void askAssistant(rawCommand.trim());
    },
    [askAssistant],
  );

  // Trigger wake-word test manually
  const triggerWakeWord = useCallback(() => {
    soundFx.playWakeSound();
    setWakeActive(true);
    if (wakeTimeoutRef.current) clearTimeout(wakeTimeoutRef.current);
    wakeTimeoutRef.current = setTimeout(() => setWakeActive(false), 5000);
    addHistoryEntry("WAKE WORD DETECTED", "YES BOSS? D-ASK IS ONLINE AND LISTENING...");
  }, [addHistoryEntry]);

  // Voice Recognition via Groq Whisper + VAD
  const toggleVoiceInput = useCallback(async () => {
    soundFx.playClickSound();
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      micStreamRef.current = null;
      setVoiceState("idle");
      setAudioLevel(0);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return;
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        
        // Skip tiny blips
        if (blob.size < 3000) return;

        setCommand("Processing audio...");
        try {
          const formData = new FormData();
          formData.append('file', blob);
          const res = await fetch('/api/stt', { method: 'POST', body: formData });
          if (res.ok) {
            const data = await res.json();
            const transcript = data.text?.trim();
            if (transcript) {
              setCommand(transcript);
              const wakeMatch = /(?:^|\b)(?:d[\s-]*ask|the[\s-]*ask|deask|task|desk|hey[\s-]*d[\s-]*ask|jarvis|ultron)\b/i.exec(transcript);
              if (!isSpeakingRef.current) {
                if (wakeMatch && wakeMatch.index !== undefined) {
                  soundFx.playWakeSound();
                  setWakeActive(true);
                  if (wakeTimeoutRef.current) clearTimeout(wakeTimeoutRef.current);
                  wakeTimeoutRef.current = setTimeout(() => setWakeActive(false), 5000);
                  const requestedCommand = transcript.slice(wakeMatch.index + wakeMatch[0].length).replace(/^[\s,.:;!?-]+/, "").trim();
                  if (requestedCommand && requestedCommand.length >= 3) {
                    void runCommand(requestedCommand);
                  } else if (!requestedCommand) {
                    addHistoryEntry("D-ASK WAKE WORD", "YES BOSS? D-ASK IS ONLINE AND LISTENING...");
                  }
                } else {
                  const wordCount = transcript.split(/\s+/).length;
                  if (wordCount >= 2 || transcript.length >= 10) {
                    void runCommand(transcript);
                  }
                }
              }
            } else {
              setCommand("");
            }
          } else {
             setCommand("ERROR: STT Failed");
          }
        } catch (e) {
          console.error("STT Error", e);
        }
      };

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

        if (normalized > 0.05) {
          if (!isRecordingRef.current) {
            isRecordingRef.current = true;
            if (mediaRecorderRef.current?.state === "inactive") {
              mediaRecorderRef.current.start();
            }
          }
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            isRecordingRef.current = false;
            if (mediaRecorderRef.current?.state === "recording") {
              mediaRecorderRef.current.stop();
            }
          }, 1500);
        }

        requestAnimationFrame(checkVolume);
      };
      checkVolume();
      
      setVoiceState("listening");
      soundFx.playWakeSound();

    } catch (err) {
      console.error(err);
      setVoiceState("error");
      addHistoryEntry("VOICE INPUT", "MICROPHONE PERMISSION DENIED · ALLOW MIC ACCESS");
      return;
    }
  }, [addHistoryEntry, runCommand]);

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

      {/* ── Agentic Task Status Panel ─────────────────────────────────── */}
      <AgentStatusPanel
        isActive={taskActive}
        orbState={orbState}
        lastMessage={taskMessage}
        events={taskEvents}
        nodes={taskNodes}
        progressPct={progressPct}
        taskId={activeTaskId}
        onCancel={cancelTask}
      />
    </>
  );
}

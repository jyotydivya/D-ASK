// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Proactive Engine — Context-aware, time-aware AI-initiated conversation
// Ported from Mark-LV actions/proactive.py
// Decides WHEN to speak unprompted and builds a context-rich prompt.
// ─────────────────────────────────────────────────────────────────────────────

import { backgroundMonitorService } from "./backgroundMonitor";

type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
type ContextFocus = "monitors" | "system" | "time" | "greeting" | "productivity";

export class ProactiveEngine {
  private minSilenceMs: number;      // Minimum silence before triggering
  private cooldownMs: number;         // Minimum gap between triggers
  private lastTriggered: number = 0;  // timestamp of last trigger
  private rotation: number = 0;       // Cycles through context focus areas

  constructor(minSilenceMs = 15 * 60 * 1000, cooldownMs = 20 * 60 * 1000) {
    this.minSilenceMs = minSilenceMs; // 15 minutes of silence
    this.cooldownMs = cooldownMs;     // 20 minutes between messages
  }

  /**
   * Should the proactive engine fire?
   * Returns true if user has been silent long enough and cooldown has elapsed.
   */
  shouldTrigger(lastUserActivityTimestamp: number): boolean {
    const now = Date.now();
    return (
      (now - lastUserActivityTimestamp) >= this.minSilenceMs &&
      (now - this.lastTriggered) >= this.cooldownMs
    );
  }

  /**
   * Mark that we triggered, to reset the cooldown.
   */
  markTriggered(): void {
    this.lastTriggered = Date.now();
  }

  /**
   * Build a context-rich prompt for the LLM based on time-of-day,
   * monitored topics, and rotation focus.
   */
  buildContextPrompt(recentHistory: string[] = []): string {
    const now = new Date();
    const timeOfDay = this.getTimeOfDay(now);
    const focus = this.getRotatedFocus();

    const parts: string[] = [];

    // Time context
    parts.push(`Current time: ${now.toLocaleTimeString()} (${timeOfDay})`);

    // Focus-specific context
    switch (focus) {
      case "monitors": {
        const alerts = backgroundMonitorService.drainAlerts();
        if (alerts.length > 0) {
          const alertText = alerts.map(a =>
            `Topic "${a.topic}": ${a.headlines.slice(0, 3).join("; ")}`
          ).join("\n");
          parts.push(`Monitored topic updates:\n${alertText}`);
        } else {
          const topics = backgroundMonitorService.listTopics();
          if (topics.topics.length > 0) {
            parts.push(`Active monitors: ${topics.topics.join(", ")}`);
          }
        }
        break;
      }

      case "time": {
        const day = now.toLocaleDateString("en-US", { weekday: "long" });
        parts.push(`It's ${day} ${timeOfDay}.`);
        if (timeOfDay === "morning") parts.push("Consider a brief morning briefing.");
        if (timeOfDay === "evening") parts.push("Maybe wrap up or set reminders for tomorrow.");
        break;
      }

      case "greeting": {
        const greetings: Record<TimeOfDay, string> = {
          morning: "Good morning! Ready to start the day?",
          afternoon: "Good afternoon. How's the day going?",
          evening: "Good evening. Anything left to handle before winding down?",
          night: "Still up? Let me know if you need anything.",
        };
        parts.push(greetings[timeOfDay]);
        break;
      }

      case "system": {
        parts.push("You could check on system status or resource usage.");
        break;
      }

      case "productivity": {
        if (timeOfDay === "morning") {
          parts.push("Would you like me to check the news or weather?");
        } else if (timeOfDay === "afternoon") {
          parts.push("Need help with any tasks or research?");
        } else {
          parts.push("Anything else before we wrap up for the day?");
        }
        break;
      }
    }

    // Recent history context (last few interactions)
    if (recentHistory.length > 0) {
      parts.push(`Recent context: ${recentHistory.slice(-3).join(" → ")}`);
    }

    this.rotation = (this.rotation + 1) % 5;

    return parts.join("\n");
  }

  private getTimeOfDay(now: Date): TimeOfDay {
    const hour = now.getHours();
    if (hour >= 5 && hour < 12) return "morning";
    if (hour >= 12 && hour < 17) return "afternoon";
    if (hour >= 17 && hour < 21) return "evening";
    return "night";
  }

  private getRotatedFocus(): ContextFocus {
    const focuses: ContextFocus[] = [
      "monitors", "time", "greeting", "system", "productivity"
    ];
    return focuses[this.rotation % focuses.length];
  }

  /**
   * Update silence and cooldown settings.
   */
  configure(minSilenceMs: number, cooldownMs: number): void {
    this.minSilenceMs = minSilenceMs;
    this.cooldownMs = cooldownMs;
  }
}

export const proactiveEngine = new ProactiveEngine();

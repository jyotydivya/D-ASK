// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Background Monitor — User-configured topic watching
// Ported from Mark-LV actions/background_monitor.py
// Checks DuckDuckGo news periodically for user-defined topics.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import path from "path";
import fs from "fs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MonitorTopic {
  slug: string;
  topic: string;
  addedAt: string;
  lastChecked: string | null;
  seenHashes: string[];      // MD5 hashes of already-seen headlines
}

export interface MonitorAlert {
  topic: string;
  headlines: string[];
  timestamp: Date;
}

// ── Blocked Categories (never monitor) ────────────────────────────────────────
// Same blocklist from Mark-LV — no crypto, no gambling.

const BLOCKED_WORDS = new Set([
  "bitcoin", "ethereum", "dogecoin", "solana", "binance",
  "nft", "blockchain", "defi", "altcoin", "memecoin",
  "crypto", "cryptocurrency", "gambling", "casino",
]);

function isBlocked(topic: string): boolean {
  const lower = topic.toLowerCase();
  return [...BLOCKED_WORDS].some(word => lower.includes(word));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slug(topic: string): string {
  return topic.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40)
    .replace(/^_|_$/g, "");
}

function titleHash(title: string): string {
  return crypto.createHash("md5").update(title).digest("hex").slice(0, 12);
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Store monitors in a JSON file alongside the memory DB.

const MONITORS_PATH = path.join(process.cwd(), ".d-ask-monitors.json");

function loadMonitors(): Record<string, MonitorTopic> {
  try {
    if (fs.existsSync(MONITORS_PATH)) {
      return JSON.parse(fs.readFileSync(MONITORS_PATH, "utf-8"));
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {};
}

function saveMonitors(monitors: Record<string, MonitorTopic>): void {
  fs.writeFileSync(MONITORS_PATH, JSON.stringify(monitors, null, 2), "utf-8");
}

// ── Service ───────────────────────────────────────────────────────────────────

export class BackgroundMonitorService {
  private checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingAlerts: MonitorAlert[] = [];

  constructor(checkIntervalMs: number = 30 * 60 * 1000) { // Default: 30 minutes
    this.checkIntervalMs = checkIntervalMs;
  }

  /**
   * Add a topic to monitor.
   */
  addTopic(topic: string): { success: boolean; message: string } {
    if (isBlocked(topic)) {
      return { success: false, message: `Topic "${topic}" is blocked.` };
    }

    const monitors = loadMonitors();
    const s = slug(topic);

    if (monitors[s]) {
      return { success: false, message: `Already monitoring "${topic}".` };
    }

    monitors[s] = {
      slug: s,
      topic,
      addedAt: new Date().toISOString(),
      lastChecked: null,
      seenHashes: [],
    };

    saveMonitors(monitors);
    return { success: true, message: `Now monitoring: "${topic}"` };
  }

  /**
   * Remove a topic from monitoring.
   */
  removeTopic(topic: string): { success: boolean; message: string } {
    const monitors = loadMonitors();
    const s = slug(topic);

    if (!monitors[s]) {
      return { success: false, message: `Not monitoring "${topic}".` };
    }

    delete monitors[s];
    saveMonitors(monitors);
    return { success: true, message: `Stopped monitoring: "${topic}"` };
  }

  /**
   * List all monitored topics.
   */
  listTopics(): { success: boolean; message: string; topics: string[] } {
    const monitors = loadMonitors();
    const topics = Object.values(monitors).map(m => m.topic);

    if (topics.length === 0) {
      return { success: true, message: "No topics being monitored.", topics: [] };
    }

    const formatted = topics.map((t, i) => `${i + 1}. ${t}`).join("\n");
    return {
      success: true,
      message: `📡 Monitored topics:\n${formatted}`,
      topics,
    };
  }

  /**
   * Check all topics for new headlines.
   * Returns alerts for topics with new content.
   */
  async checkAll(): Promise<MonitorAlert[]> {
    const monitors = loadMonitors();
    const alerts: MonitorAlert[] = [];

    for (const [s, monitor] of Object.entries(monitors)) {
      try {
        // Don't check more than once per hour
        if (monitor.lastChecked) {
          const lastCheck = new Date(monitor.lastChecked);
          const hoursSince = (Date.now() - lastCheck.getTime()) / (1000 * 60 * 60);
          if (hoursSince < 1) continue;
        }

        const { webToolsService } = await import("../desktop/webTools");
        const result = await webToolsService.fetchNews(monitor.topic);

        if (result.success && result.results) {
          const newHeadlines: string[] = [];

          for (const item of result.results) {
            const hash = titleHash(item.title);
            if (!monitor.seenHashes.includes(hash)) {
              newHeadlines.push(item.title);
              monitor.seenHashes.push(hash);
            }
          }

          // Keep only last 100 hashes to prevent memory leak
          if (monitor.seenHashes.length > 100) {
            monitor.seenHashes = monitor.seenHashes.slice(-100);
          }

          if (newHeadlines.length > 0) {
            alerts.push({
              topic: monitor.topic,
              headlines: newHeadlines,
              timestamp: new Date(),
            });
          }
        }

        monitor.lastChecked = new Date().toISOString();
      } catch (err) {
        console.warn(`[BackgroundMonitor] Error checking "${monitor.topic}":`, err);
      }
    }

    saveMonitors(monitors);
    this.pendingAlerts.push(...alerts);
    return alerts;
  }

  /**
   * Start periodic checking.
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(async () => {
      try {
        await this.checkAll();
      } catch (err) {
        console.warn("[BackgroundMonitor] Periodic check error:", err);
      }
    }, this.checkIntervalMs);

    console.log(`[BackgroundMonitor] Started (interval: ${this.checkIntervalMs / 1000}s)`);
  }

  /**
   * Stop periodic checking.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[BackgroundMonitor] Stopped.");
    }
  }

  /**
   * Get and clear any pending alerts.
   */
  drainAlerts(): MonitorAlert[] {
    const alerts = [...this.pendingAlerts];
    this.pendingAlerts = [];
    return alerts;
  }
}

export const backgroundMonitorService = new BackgroundMonitorService();

// Process wiring shared by the product entry point and test entry points: claims stdout
// for the protocol, reads the per-launch token, and connects stdin to an AgentHost.

import type { HostDeps } from "./host";
import { AgentHost } from "./host";

export interface StdioIo {
  writeLine(line: string): void;
  log(message: string): void;
}

/**
 * Reserve stdout for protocol lines. After this, process.stdout.write and console.* from
 * any code (tools, libraries) go to stderr, so nothing can corrupt the JSONL stream.
 * JSON.stringify escapes newlines, so model or tool text cannot break a line either.
 */
export function claimStdout(): StdioIo {
  const realWrite = process.stdout.write.bind(process.stdout);
  const toStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: never, enc?: never, cb?: never) => toStderr(chunk, enc, cb)) as typeof process.stdout.write;
  return {
    writeLine: (line) => { realWrite(line + "\n"); },
    log: (message) => { toStderr(`[agent-host ${new Date().toISOString()}] ${message}\n`); },
  };
}

/** Read and remove the per-launch token, so tools and child processes never inherit it. */
export function takeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.DASK_AGENT_HOST_TOKEN;
  delete env.DASK_AGENT_HOST_TOKEN;
  return token && token.length >= 32 ? token : null;
}

/** Cloud credentials have no business in this process; remove them before any code can read them. */
export function scrubCloudCredentials(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_API_TOKEN|_AUTH_TOKEN)$/i.test(k) || /^(OPENAI|GROQ|OPENROUTER|GEMINI|ANTHROPIC|GOOGLE_API)/i.test(k)) delete env[k];
  }
}

export function runStdioHost(deps: Omit<HostDeps, "writeLine" | "log" | "exit">, io: StdioIo): AgentHost {
  let exiting = false;
  const exit = (code: number) => {
    if (exiting) return;
    exiting = true;
    // Flush the final protocol lines before leaving (pipes are async on Windows).
    process.stdout.once("drain", () => process.exit(code));
    if (process.stdout.writableLength === 0) process.exit(code);
    setTimeout(() => process.exit(code), 500).unref();
  };
  const host = new AgentHost({ ...deps, writeLine: io.writeLine, log: io.log, exit });
  process.stdin.on("data", (chunk: Buffer) => host.feed(chunk));
  // The owner closing stdin means the owner is gone: never linger as an orphan.
  process.stdin.on("end", () => { void host.shutdown("stdin closed", 0); });
  process.stdin.on("error", () => { void host.shutdown("stdin error", 1); });
  process.on("uncaughtException", (err) => { io.log(`uncaught exception: ${err.stack ?? err.message}`); process.exit(1); });
  process.on("unhandledRejection", (err) => { io.log(`unhandled rejection: ${String(err)}`); process.exit(1); });
  return host;
}

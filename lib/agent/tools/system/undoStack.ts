// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Undo Stack — Reversible action system
// Ported from Mark-LV core/undo.py — every destructive action pushes a
// lambda that can reverse it. User says "undo" → pop and execute.
// ─────────────────────────────────────────────────────────────────────────────

export interface UndoEntry {
  id: string;
  description: string;        // Human-readable label for what was done
  undoFn: () => Promise<void>; // The function that reverses it
  timestamp: Date;
  toolName: string;            // Which tool caused this
  expired: boolean;            // Some actions expire (e.g., can't un-launch an app after 5 min)
}

const MAX_STACK_SIZE = 50;
const DEFAULT_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

let _stack: UndoEntry[] = [];
let _nextId = 1;

/**
 * Push a reversible action onto the undo stack.
 * Call this from any tool implementation right AFTER the action succeeds.
 *
 * @param description - What was done (e.g., "Volume set to 80%")
 * @param undoFn - Async function that reverses the action
 * @param toolName - Which tool created this undo entry
 * @param expiryMs - How long this undo is valid (default: 10 min)
 */
export function pushUndo(
  description: string,
  undoFn: () => Promise<void>,
  toolName: string,
  expiryMs: number = DEFAULT_EXPIRY_MS
): void {
  const entry: UndoEntry = {
    id: `undo_${_nextId++}`,
    description,
    undoFn,
    timestamp: new Date(),
    toolName,
    expired: false,
  };

  _stack.push(entry);

  // Trim stack if too large
  if (_stack.length > MAX_STACK_SIZE) {
    _stack = _stack.slice(-MAX_STACK_SIZE);
  }

  // Auto-expire after timeout
  setTimeout(() => {
    entry.expired = true;
  }, expiryMs);

  console.log(`[Undo] Pushed: "${description}" (${toolName})`);
}

/**
 * Pop and execute the most recent non-expired undo.
 * Returns a description of what was undone, or null if nothing to undo.
 */
export async function popUndo(): Promise<{ success: boolean; message: string }> {
  // Find the most recent non-expired entry
  while (_stack.length > 0) {
    const entry = _stack.pop()!;
    if (entry.expired) {
      continue; // Skip expired entries
    }

    try {
      await entry.undoFn();
      return {
        success: true,
        message: `Undone: ${entry.description}`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to undo "${entry.description}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, message: "Nothing to undo." };
}

/**
 * Peek at the undo stack without popping.
 */
export function peekUndo(): UndoEntry | null {
  // Find the most recent non-expired entry
  for (let i = _stack.length - 1; i >= 0; i--) {
    if (!_stack[i].expired) {
      return _stack[i];
    }
  }
  return null;
}

/**
 * Get the full undo history (non-expired only).
 */
export function getUndoHistory(): UndoEntry[] {
  return _stack.filter(e => !e.expired);
}

/**
 * Clear the entire undo stack.
 */
export function clearUndoStack(): void {
  _stack = [];
}

/**
 * Get the count of available undos.
 */
export function undoCount(): number {
  return _stack.filter(e => !e.expired).length;
}

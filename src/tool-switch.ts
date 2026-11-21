// HH-679 / HH-680 — switching between Claude Code and Pi, the Pi side. The record itself is the shared
// scripts/tool-sessions.mjs (a byte copy of hub-client-core's, the same file the Claude Code plugin's
// hooks run): this Pi process keeps a session marker for its folder (written at session start,
// refreshed by every prompt, turn and tool result, removed at session shutdown) and records the Hub it
// uses for the repository. The session start returns the warnings — Claude Code working in the same
// folder, or Claude Code using another Hub. Never a network call; a failure never touches the session.
import { heartbeat, removeMarker, startSession } from '../scripts/tool-sessions.mjs';

/** This client's name in the shared record. */
export const PI_TOOL = 'pi';

/** The prefix every Hub line of the session carries. */
const PREFIX = 'holycode-hub: ';

/** Writes this session's marker and records its Hub; returns the warning lines (empty when none). */
export function switchingWarnings(cwd: string, hubUrl: string, pid: number = process.pid): string[] {
  try {
    return startSession(cwd, { tool: PI_TOOL, pid, hubUrl }).map((line) => `${PREFIX}${line}`);
  } catch {
    return [];
  }
}

/** A prompt, a finished turn or a tool result: the marker's heartbeat (rewritten once a minute). */
export function beat(cwd: string, pid: number = process.pid): void {
  try {
    heartbeat(cwd, { tool: PI_TOOL, pid });
  } catch {
    // A marker that cannot be written only means no warning for the other tool.
  }
}

/** The session ends: its own marker goes. */
export function endSession(cwd: string, pid: number = process.pid): void {
  try {
    removeMarker(cwd, { tool: PI_TOOL, pid });
  } catch {
    // A marker left behind turns stale once this pid stops running.
  }
}

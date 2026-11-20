// HH-597 — the Pi client says what it is on the calls that carry a client identity (MC-9): every
// `work_sync` and `work_claim` it sends gets `client_kind: "pi"`, added on Pi's `tool_call` hook so
// the command bodies (shared with the Claude Code plugin) stay unchanged. With the Hub's
// PI_CLIENT_ENABLED off the Hub answers exactly as for Claude Code (HH-595).
import { HUB_SERVER_NAME } from './hub-server';
import type { PiToolCallEvent } from './pi-types';

/** Pi names an MCP tool `mcp__<server>__<tool>`, with every character other than [A-Za-z0-9_] as `_`. */
export function piToolName(tool: string): string {
  return `mcp__${HUB_SERVER_NAME.replace(/[^A-Za-z0-9_]/g, '_')}__${tool}`;
}

export const CLIENT_KIND = 'pi';

const IDENTIFIED_TOOLS = new Set(['work_sync', 'work_claim'].map(piToolName));

/** Adds `client_kind: "pi"` to a Hub work_sync / work_claim call; leaves every other call alone. */
export function tagClientKind(event: PiToolCallEvent): boolean {
  if (!IDENTIFIED_TOOLS.has(event.toolName)) return false;
  if (event.input.client_kind === undefined) event.input.client_kind = CLIENT_KIND;
  return true;
}

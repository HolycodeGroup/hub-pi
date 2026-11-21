// HH-596 — the Hub's MCP server entry in Pi's own configuration.
//
// Pi's built-in MCP support reads servers from `<agent dir>/mcp.json` (default `~/.pi/agent`). On
// first load the extension adds the `holycode-hub` entry there, so the developer edits no config
// file, and Pi's own `pi mcp login` / `/mcp` work on it like on any server. The entry is added only
// when it is missing: a server the developer configured (another URL, a staging Hub) is never
// overwritten, and a file Pi could not parse is left alone. A project can point at staging or a
// local Hub with `.pi/mcp.json` (a project entry of the same name wins — see the README).
//
// Day-1 check (19 Nov 2026, DECISIONS): Pi 1.5.2's built-in MCP support signs in to the Hub with no
// add-on — RFC 9728 discovery, dynamic client registration, PKCE S256 and a loopback callback
// `http://127.0.0.1:<port>/callback` — and keeps the tokens in `<agent dir>/mcp-auth.json` (mode
// 0600, in the home folder, never in the repository).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** The MCP server name — the same as the Claude Code plugin's, so tool names read the same. */
export const HUB_SERVER_NAME = 'holycode-hub';

/** Production Hub (streamable HTTP, OAuth 2.1). */
export const DEFAULT_HUB_URL = 'https://rdhub.holycode.com/mcp';

/**
 * The entry written to `mcp.json`. `direct` declares the Hub tools to the model like built-in tools,
 * so the commands can name them (`work_claim`, `work_verify`, …) exactly as in Claude Code.
 */
export const HUB_SERVER_ENTRY = Object.freeze({
  url: DEFAULT_HUB_URL,
  exposure: 'direct',
  description: 'Rapid Dev Hub: the project backlog, story claims, verify gates and project documents',
});

export type EnsureOutcome = 'added' | 'present' | 'unreadable';

/** Pi's configuration folder: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  return configured !== undefined && configured !== '' ? configured : path.join(home, '.pi', 'agent');
}

interface McpFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readMcpFile(file: string): McpFile | 'unreadable' {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as McpFile) : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** The `holycode-hub` URL a `mcp.json` names, or undefined (no file, no entry, or an override without `url`). */
export function hubUrlIn(file: string): string | undefined {
  const parsed = readMcpFile(file);
  if (parsed === 'unreadable') return undefined;
  const entry = parsed.mcpServers?.[HUB_SERVER_NAME] as { url?: unknown } | undefined;
  const url = entry?.url;
  return typeof url === 'string' && url !== '' ? url : undefined;
}

/**
 * Adds the `holycode-hub` server to `<agentDir>/mcp.json` when it is missing, keeping every other
 * key and server. Written through a temporary file and a rename, so a crash never leaves half a
 * file; a new file is readable by its owner only (it may later hold other servers' secrets).
 */
export function ensureHubServer(agentDir: string): EnsureOutcome {
  const file = path.join(agentDir, 'mcp.json');
  const current = readMcpFile(file);
  if (current === 'unreadable') return 'unreadable';
  const servers = current.mcpServers ?? {};
  if (Object.prototype.hasOwnProperty.call(servers, HUB_SERVER_NAME)) return 'present';

  const next: McpFile = { ...current, mcpServers: { ...servers, [HUB_SERVER_NAME]: { ...HUB_SERVER_ENTRY } } };
  mkdirSync(agentDir, { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
  renameSync(temporary, file);
  return 'added';
}

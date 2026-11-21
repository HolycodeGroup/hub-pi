// HH-596 — signing in to the Hub from Pi, through Pi's own MCP sign-in (`pi mcp login`).
//
// Pi opens the browser at the Hub's /oauth/authorize and stores the tokens in its token store in
// the home folder. `/holycode-hub:login` signs out first, so a token the Hub revoked, a password
// reset or an organisation switch always ends with a fresh sign-in. When the project points the
// server at another Hub in `.pi/mcp.json`, the project's entry is the one signed in (`-l`).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { HUB_SERVER_NAME } from './hub-server';
import type { PiApi } from './pi-types';

/** How long Pi waits in the browser for the sign-in, in seconds. */
export const LOGIN_TIMEOUT_SECONDS = 300;

export type ServerScope = 'global' | 'project';

/** `project` when `<cwd>/.pi/mcp.json` defines `holycode-hub` (a staging or local Hub). */
export function serverScope(cwd: string): ServerScope {
  const file = path.join(cwd, '.pi', 'mcp.json');
  if (!existsSync(file)) return 'global';
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers !== undefined && HUB_SERVER_NAME in parsed.mcpServers ? 'project' : 'global';
  } catch {
    return 'global';
  }
}

/** The two `pi` invocations of a fresh sign-in: sign out, then sign in. */
export function loginInvocations(scope: ServerScope): readonly (readonly string[])[] {
  const local = scope === 'project' ? ['-l'] : [];
  return [
    ['mcp', 'logout', HUB_SERVER_NAME, ...local],
    ['mcp', 'login', HUB_SERVER_NAME, ...local, '--timeout', String(LOGIN_TIMEOUT_SECONDS)],
  ];
}

export interface LoginResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Signs out and in again; the message is what the developer sees. Never throws. `scope` is the
 * entry the session resolved (HH-672: an untrusted project's override is not the one signed in).
 */
export async function signIn(pi: PiApi, cwd: string, scope: ServerScope = serverScope(cwd)): Promise<LoginResult> {
  const [logout, login] = loginInvocations(scope);
  try {
    await pi.exec('pi', logout as string[], { cwd, timeout: 30_000 });
    const result = await pi.exec('pi', login as string[], { cwd, timeout: (LOGIN_TIMEOUT_SECONDS + 30) * 1000 });
    if (result.code === 0) {
      return { ok: true, message: 'Signed in to Rapid Dev Hub. The Hub tools are ready on your next message.' };
    }
    return { ok: false, message: 'Hub sign-in did not finish. Run /holycode-hub:login to try again.' };
  } catch {
    return { ok: false, message: 'Hub sign-in could not start. Check that `pi` is on your PATH, then run /holycode-hub:login.' };
  }
}

/** True when `pi mcp list --json` reports the Hub server waiting for a sign-in. */
export function needsSignIn(listJson: string): boolean {
  try {
    const parsed = JSON.parse(listJson) as { servers?: { name?: string; state?: string }[] };
    return (parsed.servers ?? []).some((s) => s.name === HUB_SERVER_NAME && s.state === 'needs-auth');
  } catch {
    return false;
  }
}

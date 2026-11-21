// HH-672 — which Hub this Pi session talks to, and the last Hub each repository used.
//
// A project points Pi at a staging or local Hub with `.pi/mcp.json`. When that file disappears (a
// branch switch removes a branch-only `.pi/`, a fresh worktree never had it), Pi silently falls back
// to the global `holycode-hub` entry — production — and its sign-in link points there. So the session
// start names the Hub (host and where the entry comes from), and the last Hub URL is remembered per
// repository in `~/.holycode-hub/pi/last-hub.json` (the URL only — never a token). A repository that
// last used a non-production Hub and now resolves to another one gets a loud warning naming the fix,
// and no automatic sign-in for the other Hub. An explicit sign-in (`/holycode-hub:login`) records the
// Hub it signed in to, which is how a developer confirms a deliberate switch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_HUB_URL, HUB_SERVER_NAME, hubUrlIn } from './hub-server';
import { serverScope, type ServerScope } from './login';

/** The file under the runtime folder that remembers the last Hub URL per repository. */
export const LAST_HUB_FILE = 'last-hub.json';

/** Git never hangs the session start (background-work.md — explicit timeouts). */
const GIT_TIMEOUT_MS = 5_000;

export interface ResolvedHub {
  readonly url: string;
  readonly host: string;
  /** `project` when the trusted project's `.pi/mcp.json` defines the server, else `global`. */
  readonly scope: ServerScope;
}

export interface HubCheck {
  readonly hub: ResolvedHub;
  /** The Hub URL this repository used last, when it differs from a non-production one (the warning). */
  readonly expected?: string;
  /** True when `expected` is the project's own `.pi/mcp.json`, which Pi ignores in an untrusted project. */
  readonly untrusted?: boolean;
}

/** The host of a Hub URL (`rd-hub-staging.up.railway.app`), or the text itself when it is no URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sameHub(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** True for the production Hub (its host). */
export function isProductionHub(url: string): boolean {
  return hostOf(url) === hostOf(DEFAULT_HUB_URL);
}

/**
 * The Hub Pi uses in `cwd`: the project's `.pi/mcp.json` entry when the project is trusted (Pi reads
 * project files only then), else the user-level entry in `<agentDir>/mcp.json`, else production.
 */
export function resolveHub(cwd: string, agentDir: string, trusted = true): ResolvedHub {
  const globalUrl = hubUrlIn(path.join(agentDir, 'mcp.json')) ?? DEFAULT_HUB_URL;
  const project = trusted && serverScope(cwd) === 'project';
  const url = project ? (hubUrlIn(path.join(cwd, '.pi', 'mcp.json')) ?? globalUrl) : globalUrl;
  return { url, host: hostOf(url), scope: project ? 'project' : 'global' };
}

/**
 * The repository `cwd` belongs to: the top level of its main checkout (`git rev-parse
 * --git-common-dir`), so every worktree of one repository maps to the same key. Outside a git
 * repository, the folder itself.
 */
export function repositoryKey(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commonDir = realpathSync(path.resolve(cwd, out));
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  } catch {
    return path.resolve(cwd);
  }
}

function readMemory(runtimeDir: string): Record<string, { url?: unknown }> {
  const file = path.join(runtimeDir, LAST_HUB_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, { url?: unknown }>) : {};
  } catch {
    return {};
  }
}

/** The Hub URL the repository used last, if any. */
export function lastHub(runtimeDir: string, repository: string): string | undefined {
  const url = readMemory(runtimeDir)[repository]?.url;
  return typeof url === 'string' && url !== '' ? url : undefined;
}

/** Remembers the Hub URL (only the URL) the repository uses; written through a rename. */
export function rememberHub(runtimeDir: string, repository: string, url: string): void {
  const memory = readMemory(runtimeDir);
  if (memory[repository]?.url === url) return;
  mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, LAST_HUB_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...memory, [repository]: { url } }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export interface SessionHubInput {
  readonly cwd: string;
  readonly agentDir: string;
  readonly runtimeDir: string;
  readonly trusted?: boolean;
}

/**
 * The session start's check: the resolved Hub, and `expected` when the repository last used a
 * non-production Hub and now resolves to another one. Without that mismatch the resolved Hub is
 * remembered; with it the memory is kept, so the warning stays until the fix or an explicit sign-in.
 */
export function checkSessionHub(input: SessionHubInput): HubCheck {
  const trusted = input.trusted ?? true;
  const hub = resolveHub(input.cwd, input.agentDir, trusted);
  const ignored = trusted ? undefined : hubUrlIn(path.join(input.cwd, '.pi', 'mcp.json'));
  if (ignored !== undefined && !sameHub(ignored, hub.url)) return { hub, expected: ignored, untrusted: true };
  const repository = repositoryKey(input.cwd);
  const last = lastHub(input.runtimeDir, repository);
  if (last !== undefined && !sameHub(last, hub.url) && !isProductionHub(last)) return { hub, expected: last };
  rememberHub(input.runtimeDir, repository, hub.url);
  return { hub };
}

/** Where the entry comes from, as the developer reads it. */
export function hubSource(hub: ResolvedHub): string {
  return hub.scope === 'project' ? "the project's .pi/mcp.json" : 'the global Pi config';
}

/** The banner lines: the Hub in use, and the loud warning with its fix when the Hub changed. */
export function hubBannerLines(check: HubCheck): string[] {
  const { hub, expected } = check;
  const line = `holycode-hub: Hub ${hub.host} (from ${hubSource(hub)})`;
  if (expected === undefined) return [line];
  return [line, hubWarning(check), ...hubFixLines(check, expected)];
}

/** The one-line warning (also the session-start notice). */
export function hubWarning(check: HubCheck): string {
  const expected = check.expected ?? check.hub.url;
  if (check.untrusted === true) {
    return `holycode-hub: WARNING — wrong Hub? The project's .pi/mcp.json names the Hub at ${hostOf(expected)}, but Pi does not trust this project, so this session talks to ${check.hub.host} (from ${hubSource(check.hub)}).`;
  }
  return `holycode-hub: WARNING — wrong Hub? This repository last used the Hub at ${hostOf(expected)}, but this session talks to ${check.hub.host} (from ${hubSource(check.hub)}). The project's .pi/mcp.json is missing or changed — a branch switch or a fresh worktree drops a .pi/ folder that is not on this branch.`;
}

function hubFixLines(check: HubCheck, expected: string): string[] {
  const { hub } = check;
  const fix = check.untrusted === true
    ? 'holycode-hub: fix — trust this project (restart Pi in it and accept the trust question), so Pi reads its .pi/mcp.json.'
    : `holycode-hub: fix — restore .pi/mcp.json, or run: pi mcp add -l ${HUB_SERVER_NAME} --url ${expected} — then restart Pi.`;
  const next = check.untrusted === true
    ? `holycode-hub: the sign-in for ${hub.host} is not offered, and this warning stays while Pi does not trust the project (or until its .pi/mcp.json is removed). Make no Hub call until the developer has fixed the Hub.`
    : `holycode-hub: the sign-in for ${hub.host} is not offered; run /holycode-hub:login only to switch this repository to ${hub.host}. Make no Hub call until the developer has fixed the Hub or confirmed the switch.`;
  return [fix, next];
}

/** The sign-in confirmation: names the Hub host before the browser opens. */
export function signInQuestion(hub: ResolvedHub): string {
  return `Sign in to Rapid Dev Hub at ${hub.host} (from ${hubSource(hub)})? Your browser opens that Hub's sign-in.`;
}

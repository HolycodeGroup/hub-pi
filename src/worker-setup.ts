// HH-670 AC-3 — before a worker starts, its worktree gets the coordinator's project Pi settings:
// `.pi/mcp.json` as it is (the Hub server a staging or local project points at) and only the model
// fields of `.pi/settings.json` (never a key or any other setting). The worker runs with
// `--approve`, so Pi trusts that worktree's project files for that run only.
//
// The worker must talk to the same Hub as the coordinator: a staging session never spawns a worker
// against production. The coordinator's Hub URL is its project entry when its project is trusted
// (Pi reads `.pi/mcp.json` only then), else the user-level entry in `<agent dir>/mcp.json`; the
// child's is the project file it will have after the copy (it is approved), else the same
// user-level entry. When they differ, nothing is written and the start is refused.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_HUB_URL, HUB_SERVER_NAME } from './hub-server';

/** The settings that choose the model — the only ones copied. */
export const MODEL_SETTING_KEYS = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'modelThinkingLevels', 'enabledModels'] as const;

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `holycode-hub` URL a `mcp.json` names, or undefined (no file, no entry, or an override without `url`). */
export function hubUrlIn(file: string): string | undefined {
  const servers = readJson(file)?.mcpServers as Record<string, { url?: unknown }> | undefined;
  const url = servers?.[HUB_SERVER_NAME]?.url;
  return typeof url === 'string' && url !== '' ? url : undefined;
}

export interface SetupInput {
  readonly coordinatorCwd: string;
  /** Whether Pi trusts the coordinator's project (`ctx.isProjectTrusted()`); unknown counts as trusted. */
  readonly coordinatorTrusted: boolean;
  readonly worktree: string;
  readonly agentDir: string;
}

export type SetupResult = { readonly ok: true; readonly hubUrl: string; readonly copied: readonly string[] } | { readonly ok: false; readonly reason: string };

/** The Hub URLs the coordinator and the child would use. */
export function hubUrls(input: SetupInput): { coordinator: string; child: string } {
  const userLevel = hubUrlIn(path.join(input.agentDir, 'mcp.json')) ?? DEFAULT_HUB_URL;
  const source = path.join(input.coordinatorCwd, '.pi', 'mcp.json');
  const projectUrl = hubUrlIn(source);
  const coordinator = input.coordinatorTrusted ? (projectUrl ?? userLevel) : userLevel;
  const childProject = existsSync(source) ? projectUrl : hubUrlIn(path.join(input.worktree, '.pi', 'mcp.json'));
  return { coordinator, child: childProject ?? userLevel };
}

/** Checks the Hub URL, then copies the project MCP file and the model settings into the worktree. */
export function prepareWorktree(input: SetupInput): SetupResult {
  if (!existsSync(input.worktree) || !statSync(input.worktree).isDirectory()) return { ok: false, reason: `No worktree folder at ${input.worktree}.` };
  const urls = hubUrls(input);
  if (urls.coordinator !== urls.child) {
    return {
      ok: false,
      reason: `Refused: the worker would reach the Hub at ${urls.child}, but this session uses ${urls.coordinator}. Make the worktree's .pi/mcp.json name the same holycode-hub URL.`,
    };
  }
  const copied: string[] = [];
  const targetDir = path.join(input.worktree, '.pi');
  const mcpSource = path.join(input.coordinatorCwd, '.pi', 'mcp.json');
  if (path.resolve(input.coordinatorCwd) === path.resolve(input.worktree)) return { ok: true, hubUrl: urls.coordinator, copied };
  if (existsSync(mcpSource)) {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'mcp.json'), readFileSync(mcpSource), { mode: 0o600 });
    copied.push('.pi/mcp.json');
  }
  const settings = readJson(path.join(input.coordinatorCwd, '.pi', 'settings.json')) ?? {};
  const modelFields = Object.fromEntries(MODEL_SETTING_KEYS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
  if (Object.keys(modelFields).length > 0) {
    const target = path.join(targetDir, 'settings.json');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, `${JSON.stringify({ ...(readJson(target) ?? {}), ...modelFields }, null, 2)}\n`);
    copied.push('.pi/settings.json (model fields)');
  }
  return { ok: true, hubUrl: urls.coordinator, copied };
}

// HH-672 — a claimed story's worktree gets the main checkout's Pi project settings.
//
// `/holycode-hub:claim` creates the story worktree with the shared story-worktree script (`create`),
// which knows nothing of Pi (it is the Claude Code client's too and stays unchanged). A fresh worktree
// has no `.pi/` folder, so Pi there would fall back to the global (production) Hub entry. After a
// successful `create` run through the bash tool, the extension copies `.pi/mcp.json` and only the
// model fields of `.pi/settings.json` from the main checkout into it — the same copy a background
// worker's worktree gets (worker-setup.ts). Without a `.pi/` folder nothing is written.
import { repoOf } from '../scripts/story-worktree.mjs';
import type { PiToolResultEvent } from './pi-types';
import { copyPiProjectSettings } from './worker-setup';

function textOf(content: readonly unknown[] | undefined): string {
  return (content ?? [])
    .map((part) => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('\n');
}

/**
 * The path of a NEW worktree a successful `story-worktree.mjs create` bash run printed, or undefined.
 * A re-claim (`reused`) or a group join keeps the worktree's own `.pi/` untouched.
 */
export function createdWorktree(result: PiToolResultEvent): string | undefined {
  if (result.toolName !== 'bash' || result.isError === true) return undefined;
  const command = result.input.command;
  if (typeof command !== 'string' || !/story-worktree\.mjs["']?\s+create\b/.test(command)) return undefined;
  const json = /\{"ok":true.*\}/.exec(textOf(result.content))?.[0];
  if (json === undefined) return undefined;
  try {
    const parsed = JSON.parse(json) as { path?: unknown; reused?: unknown; group?: unknown };
    if (parsed.reused === true || parsed.group !== undefined) return undefined;
    return typeof parsed.path === 'string' && parsed.path !== '' ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

/** Copies the main checkout's Pi project settings into the worktree a claim just created. */
export function copyIntoClaimedWorktree(cwd: string, result: PiToolResultEvent): string[] {
  const worktree = createdWorktree(result);
  if (worktree === undefined) return [];
  return copyPiProjectSettings(repoOf(cwd).main, worktree);
}

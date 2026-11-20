// HH-671 — wires the standing-order coordinator to the real world: story worktrees through the
// shared story-worktree script, the worker setup of HH-670, git for the commit check, and the
// coordinator session for the Hub commands it runs (complete, release) and its lease renewals.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { expandArguments, type PiCommandFile } from './commands';
import type { PiApi, PiContext } from './pi-types';
import { OrderStore, StandingOrderCoordinator, type WorktreeResult } from './standing-order';
import { prepareWorktree } from './worker-setup';
import type { Notify, WorkerManager } from './workers';
import { create as createStoryWorktree, loadRegistry, repoOf } from '../scripts/story-worktree.mjs';

type CreateWorktree = (cwd: string, input: { key: string; title: string; type: string; limit: number | null; group: string | null }) => WorktreeResult;

/** story-worktree.mjs `create`, typed (the script's defaults make TypeScript infer `null` only). */
const createWorktree = createStoryWorktree as unknown as CreateWorktree;

export interface CoordinatorSetup {
  readonly pi: PiApi;
  readonly manager: WorkerManager;
  readonly notify: Notify;
  readonly commands: readonly PiCommandFile[];
  /** The coordinator session's context (its checkout and its idle state). */
  readonly context: () => PiContext | undefined;
  readonly runtimeDir: string;
  readonly agentDir: string;
  readonly commandsDir: string;
  readonly leaseLimit: () => number | null;
}

/** Sends a message to the coordinator's model: at once when it is idle, else after its turn. */
export function sendToSession(pi: PiApi, ctx: PiContext | undefined, message: string, afterTurn = false): void {
  if (!afterTurn && (ctx?.isIdle() ?? true)) pi.sendUserMessage(message);
  else pi.sendUserMessage(message, { deliverAs: 'followUp' });
}

/** Whether `sha` names a commit in the worktree's repository. */
export function commitExists(worktree: string, sha: string): boolean {
  try {
    execFileSync('git', ['-C', worktree, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function orderFile(runtimeDir: string): string {
  return path.join(runtimeDir, 'standing-order.json');
}

export function createCoordinator(setup: CoordinatorSetup): StandingOrderCoordinator {
  const cwd = (): string => setup.context()?.cwd ?? process.cwd();
  return new StandingOrderCoordinator({
    store: new OrderStore(orderFile(setup.runtimeDir)),
    manager: setup.manager,
    notify: setup.notify,
    createWorktree: ({ key, title, group }) => {
      try {
        return createWorktree(cwd(), { key, title, type: 'feat', limit: setup.leaseLimit(), group });
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    prepare: (worktree) => {
      const ctx = setup.context();
      return prepareWorktree({ coordinatorCwd: cwd(), coordinatorTrusted: ctx?.isProjectTrusted?.() ?? true, worktree, agentDir: setup.agentDir });
    },
    runCommand: (id, args, afterTurn) => {
      const command = setup.commands.find((c) => c.id === id);
      sendToSession(setup.pi, setup.context(), command === undefined ? `/holycode-hub:${id} ${args}` : expandArguments(command.body, args), afterTurn);
    },
    instruct: (text) => sendToSession(setup.pi, setup.context(), text),
    commitExists,
    leaseExpiry: (key) => {
      try {
        const entry = loadRegistry(repoOf(cwd()).registryFile)[key] as { leaseExpiresAt?: unknown } | undefined;
        return typeof entry?.leaseExpiresAt === 'number' ? entry.leaseExpiresAt : null;
      } catch {
        return null;
      }
    },
    leaseLimit: setup.leaseLimit,
    commandsDir: setup.commandsDir,
    cardsDir: path.join(setup.runtimeDir, 'commands-cache'),
  });
}

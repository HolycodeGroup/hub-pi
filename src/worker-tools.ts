// HH-670 — the four worker tools the extension gives the coordinator's model:
//
//   holycode_worker_start   a background Pi run in a story worktree (task text, optional model)
//   holycode_worker_status  every worker (or one): state, model, pid, times, its question, its log
//   holycode_worker_resume  sends the developer's answer into a worker's saved session
//   holycode_worker_stop    stops a worker; its session stays, so it can be resumed
//
// Start and resume return at once: the run goes on in the background and its end shows as a notice.
import path from 'node:path';
import { Type } from 'typebox';

import { needsSignIn } from './login';
import type { PiApi, PiContext, PiTool, PiToolResult } from './pi-types';
import { validKey, type WorkerRecord, type WorkerRegistry } from './worker-registry';
import { prepareWorktree } from './worker-setup';
import type { WorkerManager } from './workers';

/** The optional hard limit's command-line flag (`pi --worker-timeout 120`), off by default. */
export const WORKER_TIMEOUT_FLAG = 'worker-timeout';

export interface WorkerToolDeps {
  readonly pi: PiApi;
  readonly manager: WorkerManager;
  readonly registry: WorkerRegistry;
  readonly agentDir: string;
}

const text = (value: string, isError = false): PiToolResult => ({ content: [{ type: 'text', text: value }], details: undefined, ...(isError ? { isError } : {}) });

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The hard limit for a run: the tool's own value, else `--worker-timeout`, else none. */
export function timeoutMinutes(pi: PiApi, value: unknown): number | null {
  return positive(value) ?? positive(pi.getFlag?.(WORKER_TIMEOUT_FLAG));
}

/** The lease limit that applies: a value passed in may only lower the last claim's, never raise it. */
export function leaseLimit(passed: unknown, saved: number | null): number | null {
  const given = positive(passed);
  if (given === null) return saved;
  return saved === null ? given : Math.min(given, saved);
}

/** The story key of a worktree folder: `<repo>.worktrees/hh-670` → `HH-670`. */
export function keyOfWorktree(worktree: string): string {
  return path.basename(worktree).toUpperCase();
}

/** A refusal reason when the Hub still needs a sign-in; null when signed in (or it cannot tell). */
export async function signInMissing(pi: PiApi, cwd: string): Promise<string | null> {
  try {
    const listed = await pi.exec('pi', ['mcp', 'list', '--json'], { cwd, timeout: 30_000 });
    return needsSignIn(listed.stdout) ? 'The Hub needs a sign-in first: run /holycode-hub:login, then try again.' : null;
  } catch {
    return null;
  }
}

function ago(isoTime: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(isoTime)) / 60_000));
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/** One worker as a status line (and its open question or note on the next line). */
export function describeWorker(record: WorkerRecord, logFile: string, now: number = Date.now()): string {
  const head = `${record.key} — ${record.state} · model ${record.model ?? 'Pi default'} · pid ${record.pid ?? '-'} · started ${record.startedAt} · last activity ${ago(record.lastActivityAt, now)} · ${record.worktree}`;
  const note = record.note === null ? '' : `\n  ${record.state === 'NEEDS_INPUT' ? 'Question' : 'Note'}: ${record.note}`;
  return `${head}${note}\n  Log: ${logFile}`;
}

function startTool(deps: WorkerToolDeps): PiTool {
  return {
    name: 'holycode_worker_start',
    label: 'Start a background worker',
    description:
      'Start a background Pi session in a story worktree, with the Hub tools available, working on the task text. Returns at once; the worker reports when it finishes, fails, stalls or needs an answer.',
    promptGuidelines: [
      'Use holycode_worker_start to work several claimed stories in parallel, one worker per story worktree; give it the complete task, for example "/holycode-hub:execute-work HH-12".',
    ],
    parameters: Type.Object({
      worktree: Type.String({ description: 'The story worktree folder.' }),
      task: Type.String({ description: 'The complete task or Hub command for the worker.' }),
      model: Type.Optional(Type.String({ description: 'provider/id; the current model when omitted.' })),
      story_key: Type.Optional(Type.String({ description: 'The story key; the worktree folder name when omitted.' })),
      concurrent_limit: Type.Optional(Type.Number({ description: "The lease's concurrent_limit; the last claim's when omitted." })),
      timeout_minutes: Type.Optional(Type.Number({ description: 'A hard limit in minutes; none by default.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = str(params.task);
      const worktreeArg = str(params.worktree);
      if (task === '' || worktreeArg === '') return text('holycode_worker_start needs a worktree and a task.', true);
      const worktree = path.resolve(ctx.cwd, worktreeArg);
      const key = str(params.story_key) || keyOfWorktree(worktree);
      if (!validKey(key)) return text(`"${key}" is not a story key; pass story_key.`, true);
      // Every refusal comes before the worktree is touched.
      const limit = leaseLimit(params.concurrent_limit, deps.registry.savedLeaseLimit());
      const refusal = deps.manager.startRefusal(key, limit);
      if (refusal !== null) return text(refusal, true);
      const signIn = await signInMissing(deps.pi, ctx.cwd);
      if (signIn !== null) return text(signIn, true);
      const setup = prepareWorktree({ coordinatorCwd: ctx.cwd, coordinatorTrusted: ctx.isProjectTrusted?.() ?? true, worktree, agentDir: deps.agentDir });
      if (!setup.ok) return text(setup.reason, true);
      const model = str(params.model) || (ctx.model === undefined ? null : `${ctx.model.provider}/${ctx.model.id}`);
      const result = deps.manager.start({ key, worktree, task, model, timeoutMinutes: timeoutMinutes(deps.pi, params.timeout_minutes), limit });
      const copied = setup.copied.length === 0 ? '' : ` Copied into the worktree: ${setup.copied.join(', ')}.`;
      return text(result.ok ? `${result.message}${copied}` : result.message, !result.ok);
    },
  };
}

function statusTool(deps: WorkerToolDeps): PiTool {
  return {
    name: 'holycode_worker_status',
    label: 'Background workers',
    description: 'List the background workers (or one): state, model, pid, start time, last activity, an open question and the log file.',
    parameters: Type.Object({ story_key: Type.Optional(Type.String({ description: 'One worker; all when omitted.' })) }),
    async execute(_id, params) {
      const key = str(params.story_key);
      if (key !== '' && !validKey(key)) return text(`"${key}" is not a story key.`, true);
      const records = deps.manager.status(key === '' ? undefined : key);
      if (records.length === 0) return text(key === '' ? 'No background workers.' : `No worker ${key}.`);
      return text(records.map((r) => describeWorker(r, deps.registry.logFile(r.key))).join('\n'));
    },
  };
}

function resumeTool(deps: WorkerToolDeps): PiTool {
  return {
    name: 'holycode_worker_resume',
    label: 'Answer a background worker',
    description: "Continue a worker's saved session with the developer's answer (to its question, or any next instruction). Returns at once.",
    promptGuidelines: ["Use holycode_worker_resume with the developer's own answer when a worker is NEEDS_INPUT; never answer a worker's question yourself."],
    parameters: Type.Object({
      story_key: Type.String({ description: 'The worker.' }),
      answer: Type.String({ description: "The developer's answer." }),
      timeout_minutes: Type.Optional(Type.Number({ description: 'A hard limit in minutes; none by default.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: PiContext) {
      const key = str(params.story_key);
      const answer = str(params.answer);
      if (key === '' || answer === '') return text('holycode_worker_resume needs a worker and an answer.', true);
      if (!validKey(key)) return text(`"${key}" is not a story key.`, true);
      const signIn = await signInMissing(deps.pi, ctx.cwd);
      if (signIn !== null) return text(signIn, true);
      const result = deps.manager.resume(key, answer, timeoutMinutes(deps.pi, params.timeout_minutes), deps.registry.savedLeaseLimit());
      return text(result.message, !result.ok);
    },
  };
}

function stopTool(deps: WorkerToolDeps): PiTool {
  return {
    name: 'holycode_worker_stop',
    label: 'Stop a background worker',
    description: 'Stop a background worker. Its session is kept, so holycode_worker_resume can continue it.',
    parameters: Type.Object({ story_key: Type.String({ description: 'The worker.' }) }),
    async execute(_id, params) {
      const key = str(params.story_key);
      if (key === '') return text('holycode_worker_stop needs a worker.', true);
      if (!validKey(key)) return text(`"${key}" is not a story key.`, true);
      const result = deps.manager.stop(key);
      return text(result.message, !result.ok);
    },
  };
}

export function workerTools(deps: WorkerToolDeps): PiTool[] {
  return [startTool(deps), statusTool(deps), resumeTool(deps), stopTool(deps)];
}

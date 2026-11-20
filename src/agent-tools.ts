// HH-601 — two tools the extension gives the model, standing in for what Claude Code offers itself:
//
//   holycode_subagent  a fresh-context helper: a separate Pi run (`pi --mode json --no-session`) on
//                      the same model in the same folder, which sees none of this conversation and
//                      returns only its answer. Verify's gap analysis uses it, as Claude Code's
//                      sub-agent. HH-670: no fixed time limit any more — a helper quiet for
//                      STALL_MS is reported to the developer (never killed); cancelling the tool
//                      call stops it.
//   holycode_ask       a choice prompt: every question a Hub command asks the developer (claim's
//                      Start / Decline, init's project picker, add-scope's confirmation, …) shows as
//                      a Pi selection dialog; without a UI (print / JSON mode) it answers with the
//                      question as plain numbered text for the model to ask in its reply. In a
//                      background worker (HH-670) it tells the model to end its turn on the question,
//                      marked so the coordinator records the worker as NEEDS_INPUT.
import { Type } from 'typebox';

import type { PiContext, PiTool, PiToolResult } from './pi-types';
import { lineSplitter, spawnProcess, TurnTracker, WORKER_ENV, WORKER_QUESTION_MARK, type SpawnProcess, type WorkerChild } from './worker-process';
import { STALL_MS } from './workers';

const text = (value: string, isError = false): PiToolResult => ({ content: [{ type: 'text', text: value }], details: undefined, ...(isError ? { isError } : {}) });

/**
 * The `pi` arguments of a fresh-context run: JSON events (for the stall watchdog), no saved
 * session, no extensions (so no Hub tools and no nested sub-runs) and no MCP, on the parent's model
 * when one is set.
 */
export function subagentArgs(task: string, model: PiContext['model']): string[] {
  return ['--mode', 'json', '--no-session', '--no-extensions', '--no-mcp', ...(model === undefined ? [] : ['--model', `${model.provider}/${model.id}`]), '--', task];
}

export interface SubagentOptions {
  readonly spawn?: SpawnProcess;
  readonly stallMs?: number;
}

function runSubagent(task: string, ctx: PiContext, signal: AbortSignal | undefined, options: SubagentOptions): Promise<PiToolResult> {
  const stallMs = options.stallMs ?? STALL_MS;
  return new Promise((resolve) => {
    let child: WorkerChild;
    try {
      child = (options.spawn ?? spawnProcess)('pi', subagentArgs(task, ctx.model), { cwd: ctx.cwd, env: process.env });
    } catch (error) {
      resolve(text(`The fresh-context run could not start: ${error instanceof Error ? error.message : String(error)}`, true));
      return;
    }
    const tracker = new TurnTracker();
    let lastActivity = Date.now();
    let warned = false;
    let aborted = false;
    let stderr = '';
    const feed = lineSplitter((line) => {
      if (tracker.read(line)) lastActivity = Date.now();
    });
    child.stdout?.on('data', feed);
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
      lastActivity = Date.now();
    });
    const watchdog = setInterval(() => {
      const quiet = Date.now() - lastActivity >= stallMs;
      if (quiet && !warned) ctx.ui.notify(`The fresh-context helper has shown no activity for ${Math.round(stallMs / 60_000)} minutes. It keeps running; press Escape to cancel it.`, 'warning');
      warned = quiet;
    }, Math.min(60_000, stallMs));
    watchdog.unref?.();
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (result: PiToolResult): void => {
      clearInterval(watchdog);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', (error) => done(text(`The fresh-context run could not start: ${error.message}`, true)));
    child.on('close', (code, exitSignal) => {
      const outcome = tracker.outcome(code, exitSignal, aborted);
      if (outcome.state === 'STOPPED') done(text('The fresh-context run was cancelled.', true));
      else if (outcome.state === 'FAILED') done(text(`The fresh-context run failed: ${outcome.text} ${stderr.slice(-500)}`.trim(), true));
      else done(text(outcome.text));
    });
  });
}

export function subagentTool(options: SubagentOptions = {}): PiTool {
  return {
    name: 'holycode_subagent',
    label: 'Fresh-context helper',
    description:
      'Run a task in a separate Pi session with a clean context (none of this conversation) and return only its final answer. Give it everything it needs in the task text.',
    promptGuidelines: [
      'Use holycode_subagent whenever a Rapid Dev Hub command or checklist asks for a sub-agent or a fresh context, such as the gap analysis in /holycode-hub:verify.',
    ],
    parameters: Type.Object({ task: Type.String({ description: 'The complete task, with every file path or text the helper needs.' }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const task = typeof params.task === 'string' ? params.task.trim() : '';
      if (task === '') return text('holycode_subagent needs a task.', true);
      return runSubagent(task, ctx, signal, options);
    },
  };
}

/** The question as plain numbered text, for print / JSON mode. */
export function numberedQuestion(question: string, options: readonly string[]): string {
  return [question, ...options.map((option, i) => `${i + 1}. ${option}`)].join('\n');
}

/** What holycode_ask answers inside a background worker: end the turn on the question. */
export function workerQuestion(question: string, options: readonly string[]): string {
  return [
    'You are a background worker and the developer is not watching this session. End your turn now: reply with only this question, and do nothing else until the answer arrives as your next message.',
    WORKER_QUESTION_MARK,
    numberedQuestion(question, options),
  ].join('\n');
}

export function askTool(env: NodeJS.ProcessEnv = process.env): PiTool {
  return {
    name: 'holycode_ask',
    label: 'Ask the developer',
    description: 'Ask the developer to choose one of a few options and return their choice.',
    promptGuidelines: [
      'Use holycode_ask for every question a Rapid Dev Hub (/holycode-hub:*) command asks the developer to decide, such as Start or Decline a claimed story, the project to link, or a confirmation before a write.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'The question, standing on its own.' }),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 6, description: 'The choices, shortest first.' }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const question = typeof params.question === 'string' ? params.question : '';
      const options = Array.isArray(params.options) ? params.options.filter((o): o is string => typeof o === 'string') : [];
      if (question === '' || options.length < 2) return text('holycode_ask needs a question and at least two options.', true);
      if (!ctx.hasUI && (env[WORKER_ENV] ?? '') !== '') return text(workerQuestion(question, options));
      if (!ctx.hasUI) return text(`No dialog is available here (print or JSON mode). Ask the developer in your reply, as plain text:\n${numberedQuestion(question, options)}`);
      const choice = await ctx.ui.select(question, options);
      return text(choice === undefined ? 'The developer dismissed the question without choosing.' : `The developer chose: ${choice}`);
    },
  };
}

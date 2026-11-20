// HH-601 — two tools the extension gives the model, standing in for what Claude Code offers itself:
//
//   holycode_subagent  a fresh-context helper: a separate Pi run (`pi -p --no-session`) on the same
//                      model in the same folder, which sees none of this conversation and returns
//                      only its answer. Verify's gap analysis uses it, as Claude Code's sub-agent.
//   holycode_ask       a choice prompt: every question a Hub command asks the developer (claim's
//                      Start / Decline, init's project picker, add-scope's confirmation, …) shows as
//                      a Pi selection dialog; without a UI (print / JSON mode) it answers with the
//                      question as plain numbered text for the model to ask in its reply.
import { Type } from 'typebox';

import type { PiApi, PiContext, PiTool, PiToolResult } from './pi-types';

/** A sub-run never takes longer than this. */
export const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

const text = (value: string, isError = false): PiToolResult => ({ content: [{ type: 'text', text: value }], details: undefined, ...(isError ? { isError } : {}) });

/**
 * The `pi` arguments of a fresh-context run: no saved session, no extensions (so no Hub tools and
 * no nested sub-runs) and no MCP, on the parent's model when one is set.
 */
export function subagentArgs(task: string, model: PiContext['model']): string[] {
  return ['-p', '--no-session', '--no-extensions', '--no-mcp', ...(model === undefined ? [] : ['--model', `${model.provider}/${model.id}`]), task];
}

export function subagentTool(pi: PiApi): PiTool {
  return {
    name: 'holycode_subagent',
    label: 'Fresh-context helper',
    description:
      'Run a task in a separate Pi session with a clean context (none of this conversation) and return only its final answer. Give it everything it needs in the task text.',
    promptGuidelines: [
      'Use holycode_subagent whenever a Rapid Dev Hub command or checklist asks for a sub-agent or a fresh context, such as the gap analysis in /holycode-hub:verify.',
    ],
    parameters: Type.Object({ task: Type.String({ description: 'The complete task, with every file path or text the helper needs.' }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = typeof params.task === 'string' ? params.task.trim() : '';
      if (task === '') return text('holycode_subagent needs a task.', true);
      try {
        const result = await pi.exec('pi', subagentArgs(task, ctx.model), { cwd: ctx.cwd, timeout: SUBAGENT_TIMEOUT_MS });
        if (result.code !== 0 || result.killed === true) return text(`The fresh-context run failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`, true);
        return text(result.stdout.trim());
      } catch (error) {
        return text(`The fresh-context run could not start: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

/** The question as plain numbered text, for print / JSON mode. */
export function numberedQuestion(question: string, options: readonly string[]): string {
  return [question, ...options.map((option, i) => `${i + 1}. ${option}`)].join('\n');
}

export function askTool(): PiTool {
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
      if (!ctx.hasUI) return text(`No dialog is available here (print or JSON mode). Ask the developer in your reply, as plain text:\n${numberedQuestion(question, options)}`);
      const choice = await ctx.ui.select(question, options);
      return text(choice === undefined ? 'The developer dismissed the question without choosing.' : `The developer chose: ${choice}`);
    },
  };
}

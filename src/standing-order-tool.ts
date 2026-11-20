// HH-671 — `holycode_standing_order`, the tool the coordinator's model drives a parallel standing
// order with (the Pi addendum of the execute-work card tells it when):
//
//   start    after the standing-order claim: the grouping, `--parallel=N` / `--sequential` and an
//            optional `--worker-model`; ONE confirmation (stories, worker model, workers, a rough
//            token estimate) is the Start answer for the batch; then one worker per group
//   status   the order: each group, its state, its worker and worktree
//   retry    starts a group that needs the developer again from the beginning
//   release  releases a group's stories on the Hub with the developer's reason
import { Type } from 'typebox';

import { workerModelChoice } from './models';
import type { PiApi, PiContext, PiTool, PiToolResult } from './pi-types';
import type { RecommendedList } from './recommended-models';
import { confirmationText, orderCap, planGroups, type OrderState, type StandingOrderCoordinator } from './standing-order';
import { signInMissing } from './worker-tools';

export interface StandingOrderToolDeps {
  readonly pi: PiApi;
  readonly coordinator: StandingOrderCoordinator;
  readonly leaseLimit: () => number | null;
  readonly recommended: () => RecommendedList;
}

const text = (value: string, isError = false): PiToolResult => ({ content: [{ type: 'text', text: value }], details: undefined, ...(isError ? { isError } : {}) });

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function grouping(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((keys) => (Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string').map((k) => k.trim()) : []));
}

function workerModel(params: Record<string, unknown>, ctx: PiContext, list: RecommendedList): { model: string | null } | { error: string } {
  const spec = str(params.worker_model);
  if (spec === '') return { model: ctx.model === undefined ? null : `${ctx.model.provider}/${ctx.model.id}` };
  return workerModelChoice(ctx.modelRegistry?.getAvailable() ?? [], list, spec);
}

/** Builds the order the developer is asked to confirm, or the reason it cannot be built. */
export function proposeOrder(deps: StandingOrderToolDeps, params: Record<string, unknown>, ctx: PiContext): { state: OrderState } | { error: string } {
  const running = deps.coordinator.current();
  if (running !== undefined) return { error: `A standing order (${running.scope}) is already running here — see action "status".` };
  const claim = deps.coordinator.lastClaim();
  if (claim === undefined) return { error: 'No standing-order claim in this session yet: run the claim of /holycode-hub:execute-work (phase, epic or story keys) first.' };
  const scope = str(params.scope);
  if (scope === '') return { error: 'holycode_standing_order start needs scope: the scope arguments as typed, flags left out (for example "epic Pi client — core").' };
  const model = workerModel(params, ctx, deps.recommended());
  if ('error' in model) return model;
  const planned = planGroups(claim.stories, grouping(params.groups));
  if ('error' in planned) return planned;
  const cap = orderCap({ leaseLimit: deps.leaseLimit(), parallel: positive(params.parallel), sequential: params.sequential === true });
  return { state: { scope, workerModel: model.model, cap, stories: Object.fromEntries(claim.stories.map((s) => [s.key, s])), groups: planned.groups } };
}

async function start(deps: StandingOrderToolDeps, params: Record<string, unknown>, ctx: PiContext): Promise<PiToolResult> {
  const proposed = proposeOrder(deps, params, ctx);
  if ('error' in proposed) return text(proposed.error, true);
  const summary = confirmationText(proposed.state);
  const keys = Object.keys(proposed.state.stories).join(', ');
  if (!ctx.hasUI && params.confirmed !== true) {
    return text(`No dialog is available here. Show the developer this and ask Start or Decline; call holycode_standing_order start again with confirmed: true only after they answer Start:\n${summary}`);
  }
  if (ctx.hasUI && !(await ctx.ui.confirm('Rapid Dev Hub — standing order', `${summary}\n\nStart?`))) {
    return text(`The developer declined the standing order. Ask for one reason, then run /holycode-hub:release <key> <reason> for each of ${keys}.`);
  }
  const signIn = await signInMissing(deps.pi, ctx.cwd);
  if (signIn !== null) return text(signIn, true);
  const lines = deps.coordinator.begin(proposed.state);
  return text(
    [`Standing order started (${proposed.state.scope}); the developer's Start covers ${keys}.`, ...lines, 'Do not implement, verify or complete these stories in this session: the workers verify, and the extension runs complete here when a verify passed. Report worker notices to the developer.'].join('\n'),
  );
}

export function standingOrderTool(deps: StandingOrderToolDeps): PiTool {
  return {
    name: 'holycode_standing_order',
    label: 'Parallel standing order',
    description:
      'Run a claimed standing order (phase, epic or story keys) in parallel through background workers: start (one confirmation, then one worker per group), status, retry or release a group.',
    promptGuidelines: [
      'Use holycode_standing_order start right after the claim of a /holycode-hub:execute-work standing order, with the groups the parallel-worktrees guidance gives; never implement the handed-out stories in the coordinator session.',
      'When a standing-order worker fails, stalls or needs an answer, let the developer choose: holycode_worker_resume with their answer, holycode_standing_order retry, or release with their reason.',
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal('start'), Type.Literal('status'), Type.Literal('retry'), Type.Literal('release')]),
      scope: Type.Optional(Type.String({ description: 'start: the scope arguments as typed, without flags (e.g. "phase Model Choice").' })),
      groups: Type.Optional(Type.Array(Type.Array(Type.String()), { description: 'start: story keys per group (first key = the group lead); stories left out run alone.' })),
      parallel: Type.Optional(Type.Number({ description: 'start: --parallel=N, the most groups at once.' })),
      sequential: Type.Optional(Type.Boolean({ description: 'start: --sequential, one group at a time.' })),
      worker_model: Type.Optional(Type.String({ description: 'start: --worker-model provider/model for the workers; the session model when omitted.' })),
      confirmed: Type.Optional(Type.Boolean({ description: "start without a dialog only: true after the developer answered Start in their own words." })),
      story_key: Type.Optional(Type.String({ description: 'retry / release: a story of the group.' })),
      reason: Type.Optional(Type.String({ description: "release: the developer's one-line reason." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = str(params.action);
      if (action === 'start') return start(deps, params, ctx);
      if (action === 'status') return text(deps.coordinator.describe());
      const key = str(params.story_key);
      if (key === '') return text(`holycode_standing_order ${action} needs story_key.`, true);
      if (action === 'retry') return text(deps.coordinator.retry(key));
      if (action === 'release') {
        const reason = str(params.reason);
        if (reason === '') return text("holycode_standing_order release needs the developer's reason.", true);
        return text(deps.coordinator.release(key, reason));
      }
      return text(`Unknown action "${action}": start, status, retry or release.`, true);
    },
  };
}

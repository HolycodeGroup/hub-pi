// The Rapid Dev Hub extension for Pi. Pi loads it from the package's `pi.extensions`.
//
//  - On load: adds the `holycode-hub` MCP server to Pi's `mcp.json` when it is missing (HH-596),
//    copies the package's scripts and version into `~/.holycode-hub/pi/` and registers every Hub
//    command as `/holycode-hub:<name>`: the package's rendered commands and the framework cards the
//    Hub delivered (HH-597).
//  - On the first session start: when the Hub still needs a sign-in, offers it (the browser opens
//    at the Hub's /oauth/authorize); in print / JSON mode it names the command instead (HH-596).
//  - On every Hub work_sync / work_claim call: adds `client_kind: "pi"` (HH-597).
//  - On every session start: the session-start banner (git conventions, link state, project rules,
//    a stale AGENTS.md block, the model and its tier) joins the conversation (HH-599); while the
//    Hub's recommended list is missing or a day old it asks for one work_models call (HH-669).
//  - After a successful Hub work_models call: saves the answer as the recommended list (HH-669).
//  - After a successful Hub work_claim / work_progress / work_verify: renews the story worktree's
//    lease, like the Claude Code worktree hook (HH-599).
//  - Effort on the held story (HH-600): Pi's events feed the Claude Code effort engine (human / AI
//    time, steps, token counts per provider/model), and a work_progress / work_verify /
//    work_complete call that leaves the measured effort out is refused once, naming the fields.
//  - Two tools for the model (HH-601): holycode_subagent (a fresh-context helper run) and
//    holycode_ask (a choice dialog, plain numbered text without a UI).
//  - `/holycode-hub:models`: add, use, test and remove the developer's own models (HH-603); every
//    Hub command stops with one line naming it while no model is set.
//  - `/holycode-hub:login`: signs in again (HH-596).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandsToRegister, expandArguments, type PiCommandFile } from '../src/commands';
import { askTool, subagentTool } from '../src/agent-tools';
import { claudeToolName, effortGuardReason, recordAssistantUsage, recordEvent, type AssistantUsage } from '../src/effort';
import { tagClientKind } from '../src/hub-calls';
import { ensureHubServer, piAgentDir } from '../src/hub-server';
import { needsSignIn, signIn } from '../src/login';
import { NO_MODEL_LINE, runModelsCommand } from '../src/models';
import { modelsListStale, savedTier, saveWorkModelsResult } from '../src/model-tier';
import type { PiApi, PiContext, PiToolCallEvent, PiToolResultEvent } from '../src/pi-types';
import { COMMAND_PREFIX } from '../src/render.mjs';
import { installRuntime, piRuntimeDir } from '../src/runtime';
import { sessionBanner } from '../src/session-banner';
import { applyHook as renewWorktreeLease } from '../scripts/story-worktree.mjs';

/** The custom message type the banner joins the conversation with. */
export const BANNER_TYPE = 'holycode-hub-session';

export const LOGIN_COMMAND = 'holycode-hub:login';
export const MODELS_COMMAND = 'holycode-hub:models';

/** The first-session sign-in offer still running, if any (the tests wait on it). */
export let pendingSignInOffer: Promise<void> = Promise.resolve();

/** The package root: this file lives in `<root>/extensions/`. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function offerSignIn(pi: PiApi, ctx: PiContext): Promise<void> {
  const listed = await pi.exec('pi', ['mcp', 'list', '--json'], { cwd: ctx.cwd, timeout: 30_000 });
  if (!needsSignIn(listed.stdout)) return;
  if (!ctx.hasUI) {
    ctx.ui.notify('Rapid Dev Hub needs a sign-in: run /holycode-hub:login.', 'warning');
    return;
  }
  const yes = await ctx.ui.confirm('Rapid Dev Hub', 'Sign in to Rapid Dev Hub now? Your browser opens the Hub sign-in.');
  if (!yes) {
    ctx.ui.notify('Sign in any time with /holycode-hub:login.', 'info');
    return;
  }
  const result = await signIn(pi, ctx.cwd);
  ctx.ui.notify(result.message, result.ok ? 'info' : 'error');
}

function registerHubCommand(pi: PiApi, command: PiCommandFile): void {
  pi.registerCommand(`${COMMAND_PREFIX}${command.id}`, {
    description: command.description,
    async handler(args, ctx) {
      if (ctx.model === undefined) {
        ctx.ui.notify(NO_MODEL_LINE, 'warning');
        return;
      }
      const text = expandArguments(command.body, args);
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: 'followUp' });
    },
  });
}

export default function holycodeHub(pi: PiApi): void {
  const added = ensureHubServer(piAgentDir());
  const runtimeDir = piRuntimeDir();
  installRuntime(PACKAGE_ROOT, runtimeDir);
  for (const command of commandsToRegister(path.join(PACKAGE_ROOT, 'commands'), path.join(runtimeDir, 'commands-cache'))) {
    registerHubCommand(pi, command);
  }

  pi.registerTool(subagentTool(pi));
  pi.registerTool(askTool());

  pi.on('tool_call', (event, ctx) => {
    const call = event as PiToolCallEvent;
    tagClientKind(call);
    const reason = effortGuardReason(ctx.cwd, call.toolName, call.input);
    return reason === null ? undefined : { block: true, reason };
  });

  pi.on('input', (_event, ctx) => recordEvent(ctx.cwd, { hook_event_name: 'UserPromptSubmit', prompt: '' }));
  pi.on('agent_settled', (_event, ctx) => recordEvent(ctx.cwd, { hook_event_name: 'Stop' }));
  pi.on('session_shutdown', (_event, ctx) => recordEvent(ctx.cwd, { hook_event_name: 'SessionEnd' }));
  pi.on('ui_prompt_start', (_event, ctx) => recordEvent(ctx.cwd, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }));
  pi.on('ui_prompt_end', (_event, ctx) => recordEvent(ctx.cwd, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }));
  pi.on('message_end', (event, ctx) => recordAssistantUsage(ctx.cwd, piAgentDir(), (event as { message?: AssistantUsage }).message ?? {}));

  pi.on('tool_result', (event, ctx) => {
    const result = event as PiToolResultEvent;
    recordEvent(ctx.cwd, {
      hook_event_name: 'PostToolUse',
      tool_name: claudeToolName(result.toolName),
      tool_input: result.input,
      tool_response: { content: result.content ?? [] },
      tool_failed: result.isError === true,
    });
    if (result.isError === true) return;
    try {
      saveWorkModelsResult(runtimeDir, result.toolName, result.content);
    } catch {
      // A list that cannot be written keeps the previous one; the Hub call still succeeded.
    }
    try {
      renewWorktreeLease(ctx.cwd, { tool_name: result.toolName, tool_input: result.input });
    } catch {
      // A worktree registry that cannot be read never fails the Hub call it follows.
    }
  });

  pi.on('session_start', async (event, ctx) => {
    const banner = sessionBanner({
      cwd: ctx.cwd,
      shippedBlock: path.join(PACKAGE_ROOT, 'agents', 'hub-workflow-section.md'),
      model: ctx.model === undefined ? undefined : { provider: ctx.model.provider, id: ctx.model.id },
      tier: ctx.model === undefined ? 'UNKNOWN' : savedTier(runtimeDir, ctx.model.provider, ctx.model.id),
      refreshModels: modelsListStale(runtimeDir),
    });
    pi.sendMessage({ customType: BANNER_TYPE, content: banner.join('\n'), display: true }, { deliverAs: 'nextTurn' });
    if ((event as { reason?: string }).reason !== 'startup') return;
    if (added === 'added') ctx.ui.notify('Rapid Dev Hub server added to Pi. Run /reload if its tools do not appear.', 'info');
    if (added === 'unreadable') {
      ctx.ui.notify('Pi could not read its mcp.json, so the Rapid Dev Hub server was not added. Fix the file, then restart Pi.', 'error');
      return;
    }
    // Not awaited: the session starts at once and the question appears beside it. A slow or
    // missing `pi` binary never stops the session; the command stays available.
    pendingSignInOffer = offerSignIn(pi, ctx).catch(() => undefined);
  });

  pi.registerCommand(MODELS_COMMAND, {
    description: 'Add, use, test or remove your own model (any provider in Pi; keys stay on this machine)',
    async handler(args, ctx) {
      await runModelsCommand(pi, args, ctx, { agentDir: piAgentDir(), runtimeDir, packageRoot: PACKAGE_ROOT });
    },
  });

  pi.registerCommand(LOGIN_COMMAND, {
    description: 'Sign in to Rapid Dev Hub again (password reset, organisation switch, revoked token)',
    async handler(_args, ctx) {
      const result = await signIn(pi, ctx.cwd);
      ctx.ui.notify(result.message, result.ok ? 'info' : 'error');
    },
  });
}

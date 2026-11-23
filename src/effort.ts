// HH-600 — effort on the held story, measured in Pi with the Claude Code plugin's engine
// (scripts/effort-core.mjs, a byte copy): Pi's extension events are translated into the hook events
// the engine already understands, so the buffer (~/.holycode-hub/effort/), the human / AI segments
// and the categories are exactly the Claude Code client's (MC-8).
//
//   developer's message (`input`)     → UserPromptSubmit   (AI time starts)
//   agent settled (`agent_settled`)   → Stop               (human time starts)
//   session ends (`session_shutdown`) → SessionEnd
//   a dialog waits (`ui_prompt_*`)    → AskUserQuestion    (that wait is human time)
//   a tool finished (`tool_result`)   → PostToolUse        (Pi's bash/edit/write named as Claude Code's);
//                                        HH-700: after a work_complete, the engine's note on effort that
//                                        did not travel with it
//   an assistant message ends         → its token counts, as `provider/model`, with how it is paid for;
//                                        HH-593: and the model in use, also without a claim
//
//   session starts (`session_start`)  → the quiet send of unsent effort (HH-681, below)
//
// Only timestamps, actor, category, model ids and token counts are kept — never prompt text, tool
// input beyond what the engine reads to name the step, code or file content.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  absorbTranscript,
  applyEvent,
  attachEffort,
  loadState,
  noteModel,
  pointerProjectId,
  projectRootFor,
  saveState,
  sessionStartNote,
  sessionStartSends,
  stateFileFor,
  undeliveredNote,
} from '../scripts/effort-core.mjs';

type Source = 'API_KEY' | 'SUBSCRIPTION' | 'UNKNOWN';

/** Pi's built-in tool names → the Claude Code names the engine's step rules use. */
const CLAUDE_TOOL: Readonly<Record<string, string>> = Object.freeze({ bash: 'Bash', edit: 'Edit', write: 'Write', read: 'Read' });

export function claudeToolName(piTool: string): string {
  return CLAUDE_TOOL[piTool] ?? piTool;
}

interface EngineState {
  /** HH-593 — `model` / `piModelSource`: the model in use and how it is paid for, kept with or without a claim. */
  usage: { messages: Record<string, unknown>; piSources?: Record<string, Source>; model?: string; piModelSource?: Source };
  reminded?: Record<string, boolean>;
  story: unknown;
}

function withState<T>(cwd: string, change: (state: EngineState) => T): T {
  const file = stateFileFor(cwd) as string;
  const state = loadState(file) as EngineState;
  const result = change(state);
  saveState(file, state);
  return result;
}

/** A successful work_complete — the one call after which effort it left behind can no longer reach the Hub. */
function isSuccessfulCompletion(event: Record<string, unknown>): boolean {
  return event.hook_event_name === 'PostToolUse' && /__work_complete$/.test(String(event.tool_name ?? '')) && event.tool_failed !== true;
}

/**
 * Feeds one translated hook event to the engine. Never throws: effort must never stop a session.
 *
 * @returns HH-700 — after a successful work_complete that left measured time segments or token counts
 *   unreported, the engine's own note for the developer (the text Claude Code shows, HH-199); otherwise
 *   null. Read before the event is applied, since the completion clears the held story's effort.
 */
export function recordEvent(cwd: string, event: Record<string, unknown>, now: number = Date.now()): string | null {
  try {
    return withState(cwd, (state) => {
      const note = isSuccessfulCompletion(event) ? (undeliveredNote(state as never, event.tool_input as never, 'UNKNOWN') as string | null) : null;
      applyEvent(state as never, { cwd, ...event } as never, now);
      return note;
    });
  } catch {
    // An unreadable buffer loses this event only.
    return null;
  }
}

/**
 * How a provider is paid for, from Pi's own records: a subscription sign-in (`oauth` in
 * `auth.json`) is SUBSCRIPTION, a stored or configured key is API_KEY, anything else (a local model,
 * a key only in the environment) UNKNOWN. Only the record types are read, never a key.
 */
export function providerSource(agentDir: string, provider: string): Source {
  const read = (name: string): Record<string, unknown> => {
    const file = path.join(agentDir, name);
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const auth = read('auth.json')[provider] as { type?: string } | undefined;
  if (auth?.type === 'oauth') return 'SUBSCRIPTION';
  if (auth?.type === 'api_key') return 'API_KEY';
  const custom = ((read('models.json').providers ?? {}) as Record<string, { apiKey?: unknown }>)[provider];
  return typeof custom?.apiKey === 'string' && custom.apiKey !== '' ? 'API_KEY' : 'UNKNOWN';
}

export interface AssistantUsage {
  readonly role?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly responseId?: string;
  readonly usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/**
 * Keeps one assistant message's token counts as `provider/model`, with its payment source. HH-593: the
 * model and its source are also kept without a claim, so `effort-capture.mjs model` can name the model
 * of a reverse-engineer or adopt-project run (only the model id — never message text).
 */
export function recordAssistantUsage(cwd: string, agentDir: string, message: AssistantUsage, now: number = Date.now()): void {
  if (message.role !== 'assistant' || message.usage === undefined || !message.provider || !message.model) return;
  const model = `${message.provider}/${message.model}`;
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(now).toISOString(),
    message: {
      id: message.responseId ?? randomUUID(),
      model,
      usage: {
        input_tokens: message.usage.input ?? 0,
        output_tokens: message.usage.output ?? 0,
        cache_creation_input_tokens: message.usage.cacheWrite ?? 0,
        cache_read_input_tokens: message.usage.cacheRead ?? 0,
      },
    },
  });
  try {
    withState(cwd, (state) => {
      absorbTranscript(state as never, [line]);
      const source = providerSource(agentDir, message.provider as string);
      if (state.story !== null) state.usage.piSources = { ...(state.usage.piSources ?? {}), [model]: source };
      noteModel(state as never, model);
      // The source belongs to the model only when the model was kept (an id the Hub refuses keeps neither).
      if (state.usage.model === model) state.usage.piModelSource = source;
    });
  } catch {
    // An unreadable buffer loses this message's counts only.
  }
}

/**
 * HH-593 — a new session forgets the model the previous one recorded, so the `model` step only ever
 * names a model of the current session (a plan is never attributed to a model that did not make it).
 * Called at `session_start`. Never throws.
 */
export function forgetSessionModel(cwd: string): void {
  try {
    withState(cwd, (state) => {
      delete state.usage.model;
      delete state.usage.piModelSource;
    });
  } catch {
    // An unreadable buffer has no model to forget.
  }
}

/**
 * The effort guard (the Claude Code rule, HH-199): a work_progress / work_verify / work_complete call
 * for the held story that leaves out the measured segments or the token counts is refused ONCE, with
 * the exact fields to add; the repeated call always runs. Null lets the call run.
 */
export function effortGuardReason(cwd: string, toolName: string, input: Record<string, unknown>, now: number = Date.now()): string | null {
  try {
    return withState(cwd, (state) => {
      const next = attachEffort(state as never, toolName, input, now, "UNKNOWN") as Record<string, unknown> | null;
      if (next === null) return null;
      state.reminded = state.reminded ?? {};
      if (state.reminded[toolName] === true) return null;
      state.reminded[toolName] = true;
      const sources = state.usage.piSources ?? {};
      const add: Record<string, unknown> = {};
      if (next.segments !== input.segments) add.segments = next.segments;
      if (next.model_usage !== input.model_usage) {
        add.model_usage = (next.model_usage as { model: string }[]).map((entry) => ({ ...entry, source: sources[entry.model] ?? 'UNKNOWN' }));
      }
      const drop = ['human_ms', 'ai_ms'].filter((field) => field in input && !(field in next));
      return `holycode-hub: this call leaves out the measured effort. Call it again with these fields added${drop.length > 0 ? ` and without ${drop.join(' / ')}` : ''} (counts and timestamps only): ${JSON.stringify(add)}`;
    });
  } catch {
    return null;
  }
}

interface SessionStartSend {
  key: string;
  input: { story_id: string; segments?: unknown[]; model_usage?: { model: string; source: string }[] };
}

/**
 * HH-681 — effort measured in this folder that has not reached the Hub (a story completed from another
 * clone or computer, or simply not sent yet): the hidden note asking the model for one quiet
 * work_progress call per story, each model's usage with the source Pi recorded for it — or null when
 * there is nothing to send. The extension cannot call the Hub itself (Pi's MCP adapter serves the
 * model), so the call is the model's. Never throws.
 */
export function sessionStartEffortNote(cwd: string, now: number = Date.now()): string | null {
  try {
    return withState(cwd, (state) => {
      const sources = state.usage.piSources ?? {};
      const sends = (sessionStartSends(state as never, now, 'UNKNOWN') as SessionStartSend[]).map(({ key, input }) => ({
        key,
        input: input.model_usage === undefined ? input : { ...input, model_usage: input.model_usage.map((entry) => ({ ...entry, source: sources[entry.model] ?? 'UNKNOWN' })) },
      }));
      return sessionStartNote(sends as never, pointerProjectId(projectRootFor(cwd) as string) as string | null) as string | null;
    });
  } catch {
    return null;
  }
}

// HH-670 — the process seam behind background workers and the fresh-context helper, and the reader
// of Pi's JSON event stream (`pi --mode json`, docs/json.md in @earendil-works/pi-coding-agent).
//
// Facts this relies on (Pi 1.5.2 / 1.6.0, checked against the real binary):
//  - JSON mode writes strict JSONL to stdout, split on LF only (Node's readline also splits on
//    U+2028/U+2029, so it is not used); diagnostics go to stderr.
//  - Pi reads a piped stdin as part of the prompt, so the child's stdin is always closed ('ignore').
//  - A provider error does NOT change the exit code: Pi exits 0 after `agent_settled`, and the last
//    assistant `message_end` carries `stopReason: "error"` with `errorMessage`. The outcome is
//    therefore read from the events, not from the exit code alone.
import { spawn } from 'node:child_process';

/** The slice of a child process the workers use; a fake implements it in the tests. */
export interface WorkerChild {
  readonly pid?: number;
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => WorkerChild;

/** The real seam: non-blocking `child_process.spawn`, stdin closed, stdout and stderr piped. */
export const spawnProcess: SpawnProcess = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });

/** A record longer than this (an `agent_end` with a huge transcript) is dropped, not buffered. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Feeds chunks in, calls `onLine` for every complete LF-terminated record (a trailing CR stripped). */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    let index = pending.indexOf('\n');
    while (index !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (line !== '') onLine(line);
      index = pending.indexOf('\n');
    }
    if (pending.length > MAX_LINE_BYTES) pending = '';
  };
}

/** The child's environment names its story, so its extension answers questions in worker form. */
export const WORKER_ENV = 'HOLYCODE_HUB_WORKER';

/** Marks the worker form of holycode_ask's answer; the question follows on the next lines. */
export const WORKER_QUESTION_MARK = '[holycode-worker-question]';

/** What a Hub tool error says when the Hub sign-in expired or was revoked. */
const SIGN_IN_PATTERN = /sign[- ]?in|needs[- ]auth|unauthori[sz]ed|\b401\b|invalid[_ ]token|re-?authenticate/i;

/** Pi's stderr notice of a server waiting for a sign-in (stricter: "Sign-in OK" must not match). */
const STDERR_SIGN_IN_PATTERN = /needs[- ]?(sign[- ]?in|auth)|sign[- ]?in (required|expired)|unauthori[sz]ed|\b401\b/i;

/** The question the developer gets when a worker met an expired Hub sign-in. */
export const SIGN_IN_QUESTION =
  'The Hub sign-in expired in this worker. Sign in again with /holycode-hub:login in this session, then resume the worker (any answer, for example "signed in").';

type JsonEvent = { type?: unknown; [key: string]: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('');
}

export type TurnState = 'DONE' | 'FAILED' | 'NEEDS_INPUT' | 'STOPPED';

export interface TurnOutcome {
  readonly state: TurnState;
  /** The question for NEEDS_INPUT, the reason for FAILED, the final answer for DONE. */
  readonly text: string;
}

/** The Hub's work_verify tool as Pi names it (`mcp__holycode_hub__work_verify`). */
const VERIFY_TOOL = 'mcp__holycode_hub__work_verify';

/** `verified.passed` of a work_verify answer's text, or undefined when it is no verify answer. */
export function verifyPassedOf(text: string): boolean | undefined {
  try {
    const passed = (JSON.parse(text) as { verified?: { passed?: unknown } }).verified?.passed;
    return typeof passed === 'boolean' ? passed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follows one Pi run's JSON events: whether a line was activity, the last assistant message, a
 * question asked through holycode_ask, an expired Hub sign-in. `outcome()` turns that into the
 * state the run ends in.
 */
export class TurnTracker {
  private finalText = '';
  private stopReason = '';
  private errorMessage = '';
  private question: string | null = null;
  private signInExpired = false;
  /** story_id of each work_verify call still running, by tool call id. */
  private readonly verifyCalls = new Map<string, string>();
  private readonly verified: Record<string, boolean> = {};

  /** Reads one stdout line; returns true when it was a Pi event (output or tool activity). */
  read(line: string): boolean {
    let event: JsonEvent;
    try {
      event = JSON.parse(line) as JsonEvent;
    } catch {
      return false;
    }
    if (event === null || typeof event !== 'object') return false;
    if (event.type === 'message_end') this.readMessage(event.message);
    if (event.type === 'tool_execution_end') this.readToolEnd(event);
    // The model went on working after asking: the question was not where its turn ended.
    if (event.type === 'tool_execution_start' && event.toolName !== 'holycode_ask') this.question = null;
    if (event.type === 'tool_execution_start' && event.toolName === VERIFY_TOOL) this.readVerifyStart(event);
    return true;
  }

  /** Reads stderr text: Pi reports a server waiting for a sign-in there once after startup. */
  readStderr(text: string): void {
    if (/holycode-hub/i.test(text) && STDERR_SIGN_IN_PATTERN.test(text)) this.signInExpired = true;
  }

  private readMessage(message: unknown): void {
    if (message === null || typeof message !== 'object') return;
    const m = message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (m.role !== 'assistant') return;
    this.finalText = textOf(m.content).trim();
    this.stopReason = typeof m.stopReason === 'string' ? m.stopReason : '';
    this.errorMessage = typeof m.errorMessage === 'string' ? m.errorMessage : '';
  }

  private readVerifyStart(event: JsonEvent): void {
    const storyId = (event.args as { story_id?: unknown } | undefined)?.story_id;
    if (typeof event.toolCallId === 'string' && typeof storyId === 'string') this.verifyCalls.set(event.toolCallId, storyId);
  }

  private readToolEnd(event: JsonEvent): void {
    const toolName = typeof event.toolName === 'string' ? event.toolName : '';
    const text = textOf((event.result as { content?: unknown } | undefined)?.content);
    const storyId = typeof event.toolCallId === 'string' ? this.verifyCalls.get(event.toolCallId) : undefined;
    if (toolName === VERIFY_TOOL && storyId !== undefined) {
      const passed = event.isError === true ? false : verifyPassedOf(text);
      if (passed !== undefined) this.verified[storyId] = passed;
    }
    const marked = text.indexOf(WORKER_QUESTION_MARK);
    if (toolName === 'holycode_ask' && marked !== -1) this.question = text.slice(marked + WORKER_QUESTION_MARK.length).trim();
    if (event.isError === true && toolName.startsWith('mcp__holycode_hub__') && SIGN_IN_PATTERN.test(text)) this.signInExpired = true;
  }

  /** The state a finished run ends in: a question or a sign-in wins over the exit status. */
  outcome(code: number | null, signal: NodeJS.Signals | null, stopped: boolean): TurnOutcome {
    if (stopped) return { state: 'STOPPED', text: 'Stopped by the developer.' };
    if (this.question !== null) return { state: 'NEEDS_INPUT', text: this.question };
    if (this.signInExpired) return { state: 'NEEDS_INPUT', text: SIGN_IN_QUESTION };
    if (code !== 0 || signal !== null) return { state: 'FAILED', text: `Pi exited with ${signal ?? `code ${code}`}.` };
    if (this.stopReason === 'error' || this.stopReason === 'aborted') return { state: 'FAILED', text: this.errorMessage || `The model run ended with ${this.stopReason}.` };
    return { state: 'DONE', text: this.finalText };
  }

  /** HH-671 — the Hub's verify verdict per story this run saw (its work_verify answers), latest wins. */
  verifiedStories(): Readonly<Record<string, boolean>> {
    return { ...this.verified };
  }
}

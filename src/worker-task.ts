// HH-671 — what a standing-order worker is told, and how the coordinator reads its answer.
//
// The task text carries every decision the developer already took in the batch confirmation (start,
// branch, open a PR, never merge, conventional commits without AI trailers, the port range) so a
// worker never has to ask them. A worker implements and verifies only: the coordinator completes.
//
// "Verify passed" and the commit come from two sources that must agree:
//  - the worker's final reply ends with one structured line, RESULT_MARK followed by JSON
//    (`{"stories":[…],"verify":"PASSED","sha":"…","pr":"…"}`), parsed by parseWorkerResult;
//  - the Hub's own work_verify answers the worker received, read from its JSON events
//    (TurnTracker.verifiedStories). A story whose passed verify was not seen is never completed.
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';

/** The marker the worker's final reply ends with, followed by one JSON object. */
export const RESULT_MARK = 'HOLYCODE-WORKER-RESULT';

/** The environment variable naming the first port of a worker's own range (HH-671 AC-5). */
export const PORT_BASE_ENV = 'HUB_WORKER_PORT_BASE';

/** Ports per worker: the range is `base` to `base + PORTS_PER_WORKER - 1`. */
export const PORTS_PER_WORKER = 100;

export interface WorkerTaskInput {
  readonly keys: readonly string[];
  readonly worktree: string;
  readonly branch: string;
  readonly portBase: number;
  /** Where the package's commands and the framework cards are, for the `/holycode-hub:<name>` steps. */
  readonly commandsDir: string;
  readonly cardsDir: string;
}

/** The complete first message of a standing-order worker. */
export function workerTask(input: WorkerTaskInput): string {
  const keys = input.keys.join(', ');
  const last = input.portBase + PORTS_PER_WORKER - 1;
  return [
    `You are a Rapid Dev Hub background worker for ${keys}, in the worktree ${input.worktree} on the branch ${input.branch}. The developer is not watching this session; the coordinator session completes your stories.`,
    '',
    'Decisions already taken by the developer (never ask them again):',
    `- Start: the developer answered Start for ${keys} in the batch confirmation. Wherever a command asks Start or Decline, take Start yourself.`,
    `- Work only in this worktree, on the branch ${input.branch}; never create or switch to another branch.`,
    '- Commit with conventional commit subjects (feat:, fix:, test:, docs: …) that name the story key. Never add AI trailers: no Co-Authored-By line and no "Generated with" line.',
    '- Push the branch and open a pull request to the default branch (or update the one that exists). Never merge it.',
    `- Ports: use only ${input.portBase}–${last} (environment variable ${PORT_BASE_ENV}) for any server you start. When the repository has scripts/dev/with-worktree-env.sh, run every service, test and E2E command through it.`,
    '',
    `Work the stories one after another (${keys}). For each one:`,
    '1. Run `/holycode-hub:claim <key>`: it renews your lease and gives the story text and its directive (answer Start yourself). Run it again whenever you have worked on a story for more than four hours.',
    '2. Implement the story against its acceptance criteria and directive, with its tests.',
    '3. Commit, push and open or update the pull request.',
    '4. Run `/holycode-hub:verify <key>` (it sends your measured effort and token usage) until the Hub says it passed.',
    'Never run `/holycode-hub:complete` and never release a story: the coordinator does that.',
    '',
    `A \`/holycode-hub:<name>\` step means: follow that command's file — ${input.commandsDir}/<name>.md, or ${input.cardsDir}/<name>.md for a framework card — with its arguments in place of $ARGUMENTS.`,
    'When you need the developer to decide something, ask with holycode_ask.',
    '',
    'End your final reply with exactly one last line, nothing after it:',
    `${RESULT_MARK} {"stories":[${input.keys.map((k) => JSON.stringify(k)).join(',')}],"verify":"PASSED","sha":"<full sha of the pushed head commit>","pr":"<pull request URL>"}`,
    'Write "verify":"FAILED" and add "reason":"<one line>" when a verify did not pass.',
  ].join('\n');
}

export interface WorkerResultLine {
  readonly stories: readonly string[];
  readonly verify: 'PASSED' | 'FAILED';
  readonly sha: string | null;
  readonly pr: string | null;
  readonly reason: string | null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The last RESULT_MARK line of a worker's final reply, or null when there is none or it is malformed. */
export function parseWorkerResult(text: string | null): WorkerResultLine | null {
  if (text === null) return null;
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^`+|`+$/g, ''))
    .filter((l) => l.startsWith(RESULT_MARK))
    .at(-1);
  if (line === undefined) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line.slice(RESULT_MARK.length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const stories = Array.isArray(parsed.stories) ? parsed.stories.filter((s): s is string => typeof s === 'string') : [];
  if (stories.length === 0 || (parsed.verify !== 'PASSED' && parsed.verify !== 'FAILED')) return null;
  const sha = typeof parsed.sha === 'string' && SHA_PATTERN.test(parsed.sha.toLowerCase()) ? parsed.sha.toLowerCase() : null;
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return { stories, verify: parsed.verify, sha, pr: str(parsed.pr), reason: str(parsed.reason) };
}

/** Bytes read from the end of a worker's log for its tail. */
const TAIL_BYTES = 64 * 1024;

function readTail(file: string): string {
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  // A tail cut mid-file starts inside a line: drop that partial line.
  return length < size ? text.slice(text.indexOf('\n') + 1) : text;
}

function summarise(line: string): string | null {
  let event: { type?: unknown; message?: { role?: unknown; content?: unknown }; toolName?: unknown; isError?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return line.trim() === '' ? null : line.trim().slice(0, 300);
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant' && Array.isArray(event.message.content)) {
    const text = event.message.content.map((b: { text?: unknown }) => (typeof b?.text === 'string' ? b.text : '')).join('').trim();
    return text === '' ? null : `assistant: ${text.slice(0, 300)}`;
  }
  if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') return `tool ${event.toolName}${event.isError === true ? ' (error)' : ''}`;
  return null;
}

/** The last `lines` readable entries of a worker's log: its replies, tool calls and plain output. */
export function logTail(file: string, lines = 8): string[] {
  const entries = readTail(file)
    .split('\n')
    .map(summarise)
    .filter((entry): entry is string => entry !== null);
  return entries.slice(-lines);
}

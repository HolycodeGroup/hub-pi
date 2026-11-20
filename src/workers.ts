// HH-670 — background Pi workers: each one is a separate `pi --mode json` run in a story worktree,
// with the extension and MCP enabled (so it reaches the Hub), on a saved session it can be resumed
// from. The coordinator session is never blocked: the child is spawned without waiting, its JSON
// events are read as they arrive, and its state lives in the registry on disk.
//
//  - No fixed time limit. A worker with no output and no tool activity for STALL_MS turns STALLED and
//    the developer is told; it is never killed for it. An optional hard limit (`--worker-timeout`)
//    stops it and marks it FAILED.
//  - A run that ends on a question (holycode_ask without a dialog) or an expired Hub sign-in ends
//    NEEDS_INPUT; resume sends the answer into the same session (`--session-id`).
//  - At most MAX_WORKERS live at once, and never more than the lease's concurrent_limit.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

import { LIVE_STATES, type WorkerRecord, type WorkerRegistry, type WorkerState } from './worker-registry';
import { lineSplitter, spawnProcess, TurnTracker, WORKER_ENV, type SpawnProcess, type TurnOutcome, type WorkerChild } from './worker-process';

/** Never more workers at once than this, whatever the lease allows. */
export const MAX_WORKERS = 3;

/** No output or tool activity for this long marks a worker STALLED. */
export const STALL_MS = 30 * 60 * 1000;

/** Last activity reaches the registry at most this often (the watchdog reads it from memory). */
const ACTIVITY_WRITE_MS = 15_000;

export type Notify = (message: string, level: 'info' | 'warning' | 'error') => void;

export interface WorkerManagerOptions {
  readonly registry: WorkerRegistry;
  readonly notify: Notify;
  readonly spawn?: SpawnProcess;
  readonly env?: NodeJS.ProcessEnv;
  readonly isAlive?: (pid: number) => boolean;
  readonly stallMs?: number;
  /** HH-671 — called once a run ends in a state that is not live (the standing-order coordinator). */
  readonly onFinish?: (record: WorkerRecord) => void;
  /** HH-671 — called when the watchdog marks a worker STALLED (it keeps running). */
  readonly onStall?: (record: WorkerRecord) => void;
}

export interface WorkerResult {
  readonly ok: boolean;
  readonly message: string;
  readonly record?: WorkerRecord;
}

interface LiveWorker {
  readonly child: WorkerChild;
  readonly tracker: TurnTracker;
  lastActivity: number;
  lastWrite: number;
  stalled: boolean;
  stopped: boolean;
  timedOut: boolean;
  finished: boolean;
  timer?: NodeJS.Timeout;
}

export interface StartRequest {
  readonly key: string;
  readonly worktree: string;
  readonly task: string;
  readonly model: string | null;
  /** Hard limit in minutes; null (the default) means none. */
  readonly timeoutMinutes: number | null;
  /** The lease's concurrent-story limit; null means only MAX_WORKERS applies. */
  readonly limit: number | null;
  /** HH-671 — extra environment for every run of this worker (kept for resumes). */
  readonly env?: Readonly<Record<string, string>>;
}

/** The `pi` arguments of one worker turn: JSON events, trusted worktree, the saved session. */
export function workerArgs(input: { sessionDir: string; sessionId: string; key: string; model: string | null; message: string }): string[] {
  return [
    '--mode', 'json',
    '--approve',
    '--session-dir', input.sessionDir,
    '--session-id', input.sessionId,
    '--name', `Hub worker ${input.key}`,
    ...(input.model === null ? [] : ['--model', input.model]),
    '--', input.message,
  ];
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
const short = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

export class WorkerManager {
  private readonly live = new Map<string, LiveWorker>();
  private readonly spawn: SpawnProcess;
  private readonly isAlive: (pid: number) => boolean;
  private readonly stallMs: number;

  constructor(private readonly options: WorkerManagerOptions) {
    this.spawn = options.spawn ?? spawnProcess;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.stallMs = options.stallMs ?? STALL_MS;
  }

  private get registry(): WorkerRegistry {
    return this.options.registry;
  }

  /** The worker's output file. */
  logFile(key: string): string {
    return this.registry.logFile(key);
  }

  /** Workers whose Pi process is alive, in this session or another coordinator's. */
  liveCount(): number {
    this.recoverOrphans();
    return this.registry.list().filter((r) => LIVE_STATES.includes(r.state)).length;
  }

  /** The cap that applies now: MAX_WORKERS, lowered by the lease's limit. */
  cap(limit: number | null): number {
    return limit === null ? MAX_WORKERS : Math.min(MAX_WORKERS, limit);
  }

  /** Why a start would be refused now (a worker already open for the key, or the cap); null when it may start. */
  startRefusal(key: string, limit: number | null): string | null {
    const existing = this.registry.get(key);
    if (existing !== undefined && (LIVE_STATES.includes(existing.state) || existing.state === 'NEEDS_INPUT')) {
      return `Worker ${key} is ${existing.state}: resume it or stop it first.`;
    }
    const cap = this.cap(limit);
    if (this.liveCount() >= cap) return `Refused: ${cap} worker(s) already run, the most allowed now (at most ${MAX_WORKERS}, and never more than the lease's concurrent limit).`;
    return null;
  }

  start(request: StartRequest): WorkerResult {
    const refusal = this.startRefusal(request.key, request.limit);
    if (refusal !== null) return { ok: false, message: refusal, record: this.registry.get(request.key) };
    const now = Date.now();
    const record: WorkerRecord = {
      key: request.key,
      worktree: request.worktree,
      pid: null,
      model: request.model,
      state: 'RUNNING',
      startedAt: iso(now),
      lastActivityAt: iso(now),
      sessionId: `${request.key.toLowerCase()}-${now.toString(36)}`,
      note: null,
      ...(request.env === undefined ? {} : { env: request.env }),
    };
    mkdirSync(this.registry.sessionsDir, { recursive: true });
    writeFileSync(this.registry.logFile(request.key), '');
    return this.run(record, request.task, request.timeoutMinutes, 'started');
  }

  resume(key: string, answer: string, timeoutMinutes: number | null, limit: number | null): WorkerResult {
    this.recoverOrphans();
    const record = this.registry.get(key);
    if (record === undefined) return { ok: false, message: `No worker ${key}.` };
    if (LIVE_STATES.includes(record.state)) return { ok: false, message: `Worker ${key} is still running (${record.state}); resume it once its turn ends.`, record };
    const cap = this.cap(limit);
    if (this.liveCount() >= cap) return { ok: false, message: `Refused: ${cap} worker(s) already run, the most allowed now.` };
    const now = Date.now();
    return this.run({ ...record, state: 'RUNNING', note: null, lastActivityAt: iso(now) }, answer, timeoutMinutes, 'resumed');
  }

  stop(key: string): WorkerResult {
    const record = this.registry.get(key);
    if (record === undefined) return { ok: false, message: `No worker ${key}.` };
    const worker = this.live.get(key);
    const stopped = this.registry.transition(key, [...LIVE_STATES, 'NEEDS_INPUT'], { state: 'STOPPED', pid: null, note: 'Stopped by the developer.' });
    if (stopped === undefined) return { ok: false, message: `Worker ${key} is already ${record.state}.`, record };
    if (worker !== undefined) {
      worker.stopped = true;
      worker.child.kill('SIGTERM');
    } else if (record.pid !== null && this.isAlive(record.pid)) {
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch {
        // Gone between the check and the signal: it is stopped either way.
      }
    }
    return { ok: true, message: `Worker ${key} stopped. Its session is kept: resume it to continue.`, record: stopped };
  }

  status(key?: string): WorkerRecord[] {
    this.recoverOrphans();
    const all = this.registry.list();
    return key === undefined ? all : all.filter((r) => r.key === key);
  }

  /** The stall watchdog: marks quiet workers STALLED (never kills them). */
  sweep(now: number = Date.now()): void {
    for (const [key, worker] of this.live) {
      if (worker.stalled || worker.finished || now - worker.lastActivity < this.stallMs) continue;
      if (this.registry.transition(key, ['RUNNING'], { state: 'STALLED', lastActivityAt: iso(worker.lastActivity) }) === undefined) continue;
      worker.stalled = true;
      const minutes = Math.round(this.stallMs / 60_000);
      this.options.notify(`Worker ${key} is STALLED: no output or tool activity for ${minutes} minutes. It keeps running; check ${this.registry.logFile(key)} or stop it.`, 'warning');
      const record = this.registry.get(key);
      if (record !== undefined) this.options.onStall?.(record);
    }
  }

  /** Stops every worker this session started (the coordinator is closing). */
  shutdown(): void {
    for (const key of [...this.live.keys()]) this.stop(key);
  }

  /**
   * Crash recovery: a record left live whose process is gone (its coordinator closed or crashed)
   * becomes STOPPED, so it never counts against the cap and can be resumed.
   */
  recoverOrphans(): void {
    for (const record of this.registry.list()) {
      if (!LIVE_STATES.includes(record.state) || this.live.has(record.key)) continue;
      if (record.pid !== null && this.isAlive(record.pid)) continue;
      this.registry.transition(record.key, LIVE_STATES, { state: 'STOPPED', pid: null, note: 'Its coordinator session ended while it ran. Resume it to continue.' });
    }
  }

  private run(record: WorkerRecord, message: string, timeoutMinutes: number | null, verb: string): WorkerResult {
    const args = workerArgs({ sessionDir: this.registry.sessionsDir, sessionId: record.sessionId, key: record.key, model: record.model, message });
    let child: WorkerChild;
    try {
      child = this.spawn('pi', args, { cwd: record.worktree, env: { ...(this.options.env ?? process.env), ...(record.env ?? {}), [WORKER_ENV]: record.key } });
    } catch (error) {
      const failed = { ...record, state: 'FAILED' as const, note: `Pi could not start: ${error instanceof Error ? error.message : String(error)}` };
      this.registry.put(failed);
      return { ok: false, message: failed.note, record: failed };
    }
    const started = { ...record, pid: child.pid ?? null };
    this.registry.put(started);
    const now = Date.now();
    const worker: LiveWorker = { child, tracker: new TurnTracker(), lastActivity: now, lastWrite: now, stalled: false, stopped: false, timedOut: false, finished: false };
    this.live.set(record.key, worker);
    this.wire(record.key, worker);
    if (timeoutMinutes !== null && timeoutMinutes > 0) {
      worker.timer = setTimeout(() => {
        worker.timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMinutes * 60_000);
      worker.timer.unref?.();
    }
    return { ok: true, message: `Worker ${record.key} ${verb} in ${record.worktree} (pid ${child.pid ?? 'unknown'}). Output: ${this.registry.logFile(record.key)}`, record: started };
  }

  private wire(key: string, worker: LiveWorker): void {
    const log = this.registry.logFile(key);
    const onLine = lineSplitter((line) => {
      if (worker.tracker.read(line)) this.touch(key, worker);
    });
    worker.child.stdout?.on('data', (chunk) => {
      appendFileSync(log, chunk);
      onLine(chunk);
    });
    worker.child.stderr?.on('data', (chunk) => {
      appendFileSync(log, chunk);
      worker.tracker.readStderr(chunk.toString());
      this.touch(key, worker);
    });
    worker.child.on('error', (error) => this.finish(key, worker, { state: 'FAILED', text: `Pi could not run: ${error.message}` }));
    worker.child.on('close', (code, signal) => {
      const outcome = worker.timedOut ? { state: 'FAILED' as const, text: 'Stopped at the --worker-timeout limit.' } : worker.tracker.outcome(code, signal, worker.stopped);
      this.finish(key, worker, outcome);
    });
  }

  private touch(key: string, worker: LiveWorker): void {
    const now = Date.now();
    worker.lastActivity = now;
    if (worker.stalled) {
      worker.stalled = false;
      worker.lastWrite = now;
      if (this.registry.transition(key, ['STALLED'], { state: 'RUNNING', lastActivityAt: iso(now) }) !== undefined) {
        this.options.notify(`Worker ${key} is active again.`, 'info');
      }
      return;
    }
    if (now - worker.lastWrite < ACTIVITY_WRITE_MS) return;
    worker.lastWrite = now;
    this.registry.transition(key, ['RUNNING'], { lastActivityAt: iso(now) });
  }

  private finish(key: string, worker: LiveWorker, outcome: TurnOutcome): void {
    if (worker.finished) return;
    worker.finished = true;
    if (worker.timer !== undefined) clearTimeout(worker.timer);
    // A run stopped and replaced by a new one under the same key (a retry) leaves the new one alone.
    if (this.live.get(key) !== worker) return;
    this.live.delete(key);
    const state: WorkerState = outcome.state;
    const seen = worker.tracker.verifiedStories();
    const verified = { ...(this.registry.get(key)?.verified ?? {}), ...seen };
    const done = this.registry.transition(key, LIVE_STATES, {
      state,
      pid: null,
      note: outcome.text === '' ? null : outcome.text,
      lastActivityAt: iso(worker.lastActivity),
      ...(Object.keys(verified).length === 0 ? {} : { verified }),
    });
    if (done === undefined) return;
    const log = this.registry.logFile(key);
    if (state === 'DONE') this.options.notify(`Worker ${key} finished: ${short(outcome.text) || '(no final answer)'} Log: ${log}`, 'info');
    if (state === 'FAILED') this.options.notify(`Worker ${key} FAILED: ${short(outcome.text)} Log: ${log}`, 'error');
    if (state === 'NEEDS_INPUT') this.options.notify(`Worker ${key} needs your answer: ${short(outcome.text)} Answer with holycode_worker_resume.`, 'warning');
    this.options.onFinish?.(done);
  }
}

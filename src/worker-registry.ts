// HH-670 — the background workers' registry on disk: `~/.holycode-hub/pi/workers/<key>.json` (one
// record per story key), the worker's output in `<key>.log` and its Pi sessions in `sessions/`.
// Every write goes through a temporary file and a rename, so a crash never leaves half a record;
// a state change names the states it may leave (a stale run never overwrites a newer state).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type WorkerState = 'RUNNING' | 'NEEDS_INPUT' | 'STALLED' | 'DONE' | 'FAILED' | 'STOPPED';

/** States in which the worker's Pi process is alive. */
export const LIVE_STATES: readonly WorkerState[] = ['RUNNING', 'STALLED'];

export interface WorkerRecord {
  readonly key: string;
  readonly worktree: string;
  readonly pid: number | null;
  /** `provider/id`, or null for Pi's default model. */
  readonly model: string | null;
  readonly state: WorkerState;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  /** The Pi session id (`--session-id`) a resume continues. */
  readonly sessionId: string;
  /** The open question (NEEDS_INPUT), the failure reason (FAILED) or the final answer (DONE). */
  readonly note: string | null;
  /** HH-671 — extra environment of every run of this worker (its port range). */
  readonly env?: Readonly<Record<string, string>>;
  /** HH-671 — the Hub's verify verdict per story key seen in this worker's runs, latest wins. */
  readonly verified?: Readonly<Record<string, boolean>>;
}

/** A story key that is safe as a file name: `HH-670`, `DHWH-7`. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes('..') && key.toLowerCase() !== 'lease';
}

/** `<runtime dir>/workers`. */
export function workersDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'workers');
}

export class WorkerRegistry {
  constructor(readonly dir: string) {}

  get sessionsDir(): string {
    return path.join(this.dir, 'sessions');
  }

  logFile(key: string): string {
    return path.join(this.dir, `${key}.log`);
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  get(key: string): WorkerRecord | undefined {
    const file = this.file(key);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as WorkerRecord;
    } catch {
      return undefined;
    }
  }

  list(): WorkerRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json') && name !== 'lease.json')
      .sort()
      .map((name) => this.get(name.slice(0, -'.json'.length)))
      .filter((record): record is WorkerRecord => record !== undefined && typeof record.state === 'string');
  }

  put(record: WorkerRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(record.key);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  /**
   * Applies `patch` only while the record is in one of `from`; returns the new record, or
   * undefined when the state had already moved on (the caller then stops).
   */
  transition(key: string, from: readonly WorkerState[], patch: Partial<Omit<WorkerRecord, 'key'>>): WorkerRecord | undefined {
    const current = this.get(key);
    if (current === undefined || !from.includes(current.state)) return undefined;
    const next = { ...current, ...patch };
    this.put(next);
    return next;
  }

  /** The concurrent-story limit of the last claim's lease (null: no limit set). */
  savedLeaseLimit(): number | null {
    try {
      const value = (JSON.parse(readFileSync(path.join(this.dir, 'lease.json'), 'utf8')) as { concurrent_limit?: unknown }).concurrent_limit;
      return typeof value === 'number' && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  saveLeaseLimit(limit: number | null): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, 'lease.json'), `${JSON.stringify({ concurrent_limit: limit })}\n`);
  }
}

/**
 * Reads `lease.concurrent_limit` from a successful work_claim result's text content; undefined when
 * the content is not a claim answer.
 */
export function claimLimitOf(content: readonly unknown[] | undefined): number | null | undefined {
  for (const block of content ?? []) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') continue;
    try {
      const lease = (JSON.parse(text) as { lease?: { concurrent_limit?: unknown } }).lease;
      if (lease === undefined) continue;
      return typeof lease.concurrent_limit === 'number' ? lease.concurrent_limit : null;
    } catch {
      // Not JSON: not a claim answer.
    }
  }
  return undefined;
}

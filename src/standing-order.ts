// HH-671 — the standing-order coordinator: the Pi session that claimed a phase, an epic or a list
// of stories runs the handed-out stories in parallel through background workers (HH-670).
//
//  - The coordinator owns the order. It claims once (the claim card, in this session), the model
//    groups the handed-out stories per the `parallel-worktrees` guidance, and `begin` starts one
//    worker per group — at most MAX_WORKERS, never more than the lease's concurrent_limit, one at a
//    time with `--sequential`, at most N with `--parallel=N`.
//  - Workers implement and verify only. When one ends DONE with a passed verify (its structured
//    result line AND the Hub's work_verify answers it received agree), the coordinator runs
//    `/holycode-hub:complete <key> <sha> --scope <scope>` here for each of its stories; the stories
//    the Hub hands out in that answer join the queue and get workers.
//  - A worker that fails, stops, ends without a passed verify or needs an answer holds its slot
//    (its leases stay held) until the developer resumes, retries or releases it.
//  - The order is kept in `<runtime dir>/standing-order.json`, written through a temporary file and
//    a rename, so a restarted coordinator carries on with it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { WorkerRecord } from './worker-registry';
import { logTail, parseWorkerResult, PORT_BASE_ENV, PORTS_PER_WORKER, workerTask } from './worker-task';
import { MAX_WORKERS, type Notify, type WorkerManager } from './workers';

/** The first worker's port range starts here; worker slot n gets `PORT_BASE_START + n * PORTS_PER_WORKER`. */
export const PORT_BASE_START = 42000;

/** A still-running worker's lease is renewed when it expires within this long. */
export const RENEW_BEFORE_MS = 60 * 60 * 1000;

/** The rough token estimate: a story's fixed cost plus a share per story point (mostly cached input). */
export const TOKENS_PER_STORY = 1_000_000;
export const TOKENS_PER_POINT = 300_000;

export type GroupState = 'QUEUED' | 'RUNNING' | 'COMPLETING' | 'ATTENTION' | 'DONE' | 'RELEASED';

/** States in which a group holds a worker slot (and its leases). */
const SLOT_STATES: readonly GroupState[] = ['RUNNING', 'COMPLETING', 'ATTENTION'];

export interface OrderStory {
  readonly key: string;
  readonly title: string;
  readonly points: number | null;
}

export interface OrderGroup {
  /** The group's first story: its worker, worktree and branch are named after it. */
  readonly lead: string;
  readonly keys: readonly string[];
  readonly state: GroupState;
  readonly worktree: string | null;
  readonly portBase: number | null;
  readonly sha: string | null;
  readonly completed: readonly string[];
  readonly note: string | null;
}

export interface OrderState {
  /** The scope arguments as typed (`epic Pi client — core`), sent with every `--scope`. */
  readonly scope: string;
  readonly workerModel: string | null;
  readonly cap: number;
  readonly stories: Readonly<Record<string, OrderStory>>;
  readonly groups: readonly OrderGroup[];
}

export class OrderStore {
  constructor(readonly file: string) {}

  get(): OrderState | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as OrderState;
    } catch {
      return undefined;
    }
  }

  put(state: OrderState): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}

/** The cap for this order: MAX_WORKERS, lowered by the lease limit and `--parallel=N`; 1 with `--sequential`. */
export function orderCap(input: { leaseLimit: number | null; parallel: number | null; sequential: boolean }): number {
  if (input.sequential) return 1;
  return Math.max(1, Math.min(MAX_WORKERS, input.leaseLimit ?? MAX_WORKERS, input.parallel ?? MAX_WORKERS));
}

const group = (keys: readonly string[]): OrderGroup => ({ lead: keys[0] as string, keys, state: 'QUEUED', worktree: null, portBase: null, sha: null, completed: [], note: null });

/**
 * The groups of a new order: the model's grouping, checked against the handed-out stories (an
 * unknown or repeated key is refused); a story the grouping leaves out gets a group of its own.
 */
export function planGroups(stories: readonly OrderStory[], grouping: readonly (readonly string[])[] | undefined): { groups: OrderGroup[] } | { error: string } {
  const known = new Set(stories.map((s) => s.key));
  const seen = new Set<string>();
  const groups: OrderGroup[] = [];
  for (const keys of grouping ?? []) {
    if (keys.length === 0) continue;
    for (const key of keys) {
      if (!known.has(key)) return { error: `${key} is not one of the stories the claim handed out (${[...known].join(', ')}).` };
      if (seen.has(key)) return { error: `${key} is in more than one group.` };
      seen.add(key);
    }
    groups.push(group(keys));
  }
  for (const story of stories) if (!seen.has(story.key)) groups.push(group([story.key]));
  return { groups };
}

/** A rough token estimate for the stories, for the confirmation. */
export function tokenEstimate(stories: readonly OrderStory[]): number {
  return stories.reduce((sum, s) => sum + TOKENS_PER_STORY + (s.points ?? 0) * TOKENS_PER_POINT, 0);
}

/** The batch confirmation's text: stories by group, the worker model, the workers and the estimate. */
export function confirmationText(state: OrderState): string {
  const workers = Math.min(state.cap, state.groups.length);
  const millions = (tokenEstimate(Object.values(state.stories)) / 1_000_000).toFixed(1);
  const lines = state.groups.map((g, i) => `  ${i + 1}. ${g.keys.map((k) => `${k} — ${state.stories[k]?.title ?? ''}`).join('; ')}`);
  return [
    `Standing order ${state.scope}: ${Object.keys(state.stories).length} stories in ${state.groups.length} group(s).`,
    ...lines,
    `Worker model: ${state.workerModel ?? 'the session model'}.`,
    `Workers at once: ${workers} (cap ${state.cap}).`,
    `Rough token estimate: ~${millions}M tokens (mostly cached input).`,
    'Start counts as Start for every story above and for those the Hub hands out later under this order. Workers implement and verify; this session completes each story.',
  ].join('\n');
}

export interface WorktreeResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly branch?: string;
  readonly reason?: string;
}

export interface CoordinatorDeps {
  readonly store: OrderStore;
  readonly manager: WorkerManager;
  readonly notify: Notify;
  /** story-worktree.mjs `create` from the coordinator's checkout. */
  readonly createWorktree: (input: { key: string; title: string; group: string | null }) => WorktreeResult;
  /** Copies the project's Pi settings into a worktree and checks its Hub (worker-setup). */
  readonly prepare: (worktree: string) => { ok: boolean; reason?: string };
  /** Runs a `/holycode-hub:<id>` command in the coordinator session; `afterTurn` always queues it after the running turn. */
  readonly runCommand: (id: string, args: string, afterTurn?: boolean) => void;
  /** Sends an instruction to the coordinator's model. */
  readonly instruct: (text: string) => void;
  /** Whether the sha is a commit in the worktree. */
  readonly commitExists: (worktree: string, sha: string) => boolean;
  /** When a story's lease expires (the story-worktree registry), or null when unknown. */
  readonly leaseExpiry: (key: string) => number | null;
  readonly leaseLimit: () => number | null;
  readonly commandsDir: string;
  readonly cardsDir: string;
}

export interface HandedOut {
  readonly scope: unknown;
  readonly stories: readonly OrderStory[];
}

function storiesOf(value: unknown): OrderStory[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is { key: string; title?: unknown; points?: unknown } => typeof (s as { key?: unknown } | null)?.key === 'string')
    .map((s) => ({ key: s.key, title: typeof s.title === 'string' ? s.title : '', points: typeof s.points === 'number' ? s.points : null }));
}

/** The JSON object of a Hub tool's text answer, or undefined. */
export function answerOf(content: readonly unknown[] | undefined): Record<string, unknown> | undefined {
  for (const block of content ?? []) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}

function errorText(content: readonly unknown[] | undefined): string {
  return (content ?? []).map((b) => (typeof (b as { text?: unknown } | null)?.text === 'string' ? (b as { text: string }).text : '')).join(' ').trim().slice(0, 400);
}

export class StandingOrderCoordinator {
  private claimed: HandedOut | undefined;
  private readonly renewAsked = new Map<string, number>();

  constructor(private readonly deps: CoordinatorDeps) {}

  /** A standing-order claim in this session (the work_claim tool result): its stories are the batch. */
  noteClaim(input: Record<string, unknown>, content: readonly unknown[] | undefined): void {
    const order = answerOf(content)?.standing_order as { handed_out?: unknown } | undefined;
    if (order === undefined || input.scope === undefined) return;
    const story = (answerOf(content)?.story ?? {}) as { key?: unknown; title?: unknown; points?: unknown };
    const handed = storiesOf(order.handed_out);
    const first = storiesOf([story]);
    this.claimed = { scope: input.scope, stories: [...first, ...handed.filter((s) => !first.some((f) => f.key === s.key))] };
  }

  /** The stories of the last standing-order claim, or undefined when none was made in this session. */
  lastClaim(): HandedOut | undefined {
    return this.claimed;
  }

  current(): OrderState | undefined {
    return this.deps.store.get();
  }

  /** Records a confirmed order and starts its first workers; returns what started. */
  begin(state: OrderState): string[] {
    this.deps.store.put(state);
    this.claimed = undefined;
    return this.fill();
  }

  private save(change: (state: OrderState) => OrderState): OrderState | undefined {
    const state = this.deps.store.get();
    if (state === undefined) return undefined;
    const next = change(state);
    this.deps.store.put(next);
    return next;
  }

  private setGroup(lead: string, patch: Partial<OrderGroup>): OrderState | undefined {
    return this.save((s) => ({ ...s, groups: s.groups.map((g) => (g.lead === lead ? { ...g, ...patch } : g)) }));
  }

  /** Starts workers for queued groups while slots are free; returns one line per start or refusal. */
  fill(): string[] {
    const lines: string[] = [];
    for (;;) {
      const state = this.deps.store.get();
      if (state === undefined) return lines;
      const cap = Math.min(state.cap, this.deps.leaseLimit() ?? MAX_WORKERS);
      const busy = state.groups.filter((g) => SLOT_STATES.includes(g.state));
      const next = state.groups.find((g) => g.state === 'QUEUED');
      if (next === undefined || busy.length >= cap) return lines;
      const refusal = this.deps.manager.startRefusal(next.lead, this.deps.leaseLimit());
      // The global worker cap (workers outside the order count too): stay queued, try again later.
      if (refusal !== null && refusal.startsWith('Refused:')) return [...lines, `${next.keys.join(', ')}: queued — ${refusal}`];
      lines.push(this.launch(state, next, busy));
    }
  }

  private freePortBase(busy: readonly OrderGroup[]): number {
    const used = new Set(busy.map((g) => g.portBase));
    for (let slot = 0; ; slot += 1) {
      const base = PORT_BASE_START + slot * PORTS_PER_WORKER;
      if (!used.has(base)) return base;
    }
  }

  private launch(state: OrderState, g: OrderGroup, busy: readonly OrderGroup[]): string {
    const fail = (reason: string): string => {
      this.setGroup(g.lead, { state: 'ATTENTION', note: reason });
      this.deps.notify(`Standing order: ${g.keys.join(', ')} could not start: ${reason} Retry or release it.`, 'error');
      return `${g.lead}: ${reason}`;
    };
    let worktree: WorktreeResult = { ok: false };
    for (const key of g.keys) {
      const made = this.deps.createWorktree({ key, title: state.stories[key]?.title ?? key, group: key === g.lead ? null : g.lead });
      if (!made.ok) return fail(made.reason ?? 'the story worktree could not be created.');
      if (key === g.lead) worktree = made;
    }
    const dir = worktree.path as string;
    const setup = this.deps.prepare(dir);
    if (!setup.ok) return fail(setup.reason ?? 'the worktree could not be prepared.');
    const portBase = g.portBase ?? this.freePortBase(busy);
    const task = workerTask({ keys: g.keys, worktree: dir, branch: worktree.branch ?? '', portBase, commandsDir: this.deps.commandsDir, cardsDir: this.deps.cardsDir });
    const started = this.deps.manager.start({
      key: g.lead,
      worktree: dir,
      task,
      model: state.workerModel,
      timeoutMinutes: null,
      limit: this.deps.leaseLimit(),
      env: { [PORT_BASE_ENV]: String(portBase) },
    });
    if (!started.ok) return fail(started.message);
    this.setGroup(g.lead, { state: 'RUNNING', worktree: dir, portBase, note: null });
    return `${g.keys.join(', ')}: worker started in ${dir} (ports ${portBase}–${portBase + PORTS_PER_WORKER - 1}).`;
  }

  /** A worker's run ended (WorkerManager.onFinish). */
  onWorkerFinished(record: WorkerRecord): void {
    const state = this.deps.store.get();
    const g = state?.groups.find((x) => x.lead === record.key && (x.state === 'RUNNING' || x.state === 'ATTENTION'));
    if (state === undefined) return;
    if (g === undefined) {
      // A worker outside the order finished: a group waiting on the global cap may start now.
      this.fill();
      return;
    }
    if (record.state !== 'DONE') {
      this.attention(g, record, record.state === 'NEEDS_INPUT' ? `Question: ${record.note ?? ''}` : `${record.state}: ${record.note ?? ''}`);
      return;
    }
    const why = this.notCompletable(g, record);
    if (why !== null) {
      this.attention(g, record, why);
      return;
    }
    const sha = parseWorkerResult(record.note)?.sha as string;
    this.setGroup(g.lead, { state: 'COMPLETING', sha, note: null });
    this.deps.notify(`Standing order: ${g.keys.join(', ')} verified at ${sha.slice(0, 12)}; completing in this session.`, 'info');
    this.runCompletes(state.scope, g.keys, sha);
  }

  /** One complete per story; every one after the first waits for the turn the first one starts. */
  private runCompletes(scope: string, keys: readonly string[], sha: string): void {
    keys.forEach((key, i) => this.deps.runCommand('complete', `${key} ${sha} --scope ${scope}`, i > 0));
  }

  /** The watchdog marked a group's worker STALLED: the developer is asked; the worker keeps running. */
  onWorkerStalled(record: WorkerRecord): void {
    const g = this.deps.store.get()?.groups.find((x) => x.lead === record.key && x.state === 'RUNNING');
    if (g !== undefined) this.attention(g, record, 'STALLED: no output or tool activity for a long time; it keeps running.');
  }

  /** Why a DONE worker's stories may not be completed, or null when every check holds. */
  private notCompletable(g: OrderGroup, record: WorkerRecord): string | null {
    const result = parseWorkerResult(record.note);
    if (result === null) return 'the worker finished without its result line.';
    if (result.verify !== 'PASSED') return `the worker reports verify FAILED${result.reason === null ? '' : `: ${result.reason}`}.`;
    if (result.sha === null) return 'the result line has no full commit sha.';
    const missing = g.keys.filter((k) => record.verified?.[k] !== true);
    if (missing.length > 0) return `no passed Hub verify was seen for ${missing.join(', ')}.`;
    if (g.worktree !== null && !this.deps.commitExists(g.worktree, result.sha)) return `commit ${result.sha} is not in ${g.worktree}.`;
    return null;
  }

  private attention(g: OrderGroup, record: WorkerRecord, note: string): void {
    this.setGroup(g.lead, { state: 'ATTENTION', note });
    const tail = record.state === 'NEEDS_INPUT' ? [] : logTail(this.deps.manager.logFile(record.key));
    const options = record.state === 'NEEDS_INPUT' ? 'answer it (holycode_worker_resume), retry or release' : 'resume it (holycode_worker_resume), retry or release';
    const lines = [`Standing order: ${g.keys.join(', ')} needs the developer — ${note}`, ...(tail.length === 0 ? [] : ['Log tail:', ...tail.map((l) => `  ${l}`)]), `Ask the developer: ${options} (holycode_standing_order action "retry" / "release").`];
    this.deps.notify(lines.join('\n'), 'warning');
  }

  /** A work_complete answer in this session: records the completion and queues what the Hub handed out. */
  onComplete(input: Record<string, unknown>, content: readonly unknown[] | undefined, isError: boolean): string[] {
    const key = input.story_id;
    const state = this.deps.store.get();
    // A group held after a refused completion (it keeps its sha) is followed again when it is retried.
    const completing = (x: OrderGroup): boolean => x.state === 'COMPLETING' || (x.state === 'ATTENTION' && x.sha !== null);
    const g = state?.groups.find((x) => completing(x) && typeof key === 'string' && x.keys.includes(key));
    if (state === undefined || g === undefined || typeof key !== 'string') return [];
    if (isError) {
      this.setGroup(g.lead, { state: 'ATTENTION', note: `complete ${key} failed: ${errorText(content)}` });
      this.deps.notify(`Standing order: completing ${key} failed — ${errorText(content)} Retry or release it.`, 'error');
      return [];
    }
    const completed = [...new Set([...g.completed, key])];
    const order = answerOf(content)?.standing_order as { handed_out?: unknown; open?: unknown } | undefined;
    const known = new Set(Object.keys(state.stories));
    const fresh = storiesOf(order?.handed_out).filter((s) => !known.has(s.key));
    this.save((s) => ({
      ...s,
      stories: { ...s.stories, ...Object.fromEntries(fresh.map((f) => [f.key, f])) },
      groups: [...s.groups.map((x) => (x.lead === g.lead ? { ...x, completed, note: null, state: completed.length === x.keys.length ? ('DONE' as const) : ('COMPLETING' as const) } : x)), ...fresh.map((f) => group([f.key]))],
    }));
    if (fresh.length > 0) this.deps.notify(`Standing order: the Hub handed out ${fresh.map((f) => f.key).join(', ')}; queued.`, 'info');
    const lines = this.fill();
    this.finishIfDone(typeof order?.open === 'number' ? order.open : null);
    return lines;
  }

  private finishIfDone(open: number | null): void {
    const state = this.deps.store.get();
    if (state === undefined || state.groups.some((g) => g.state !== 'DONE' && g.state !== 'RELEASED')) return;
    this.deps.store.clear();
    const report = state.groups.map((g) => `  ${g.keys.join(', ')} — ${g.state}${g.sha === null ? '' : ` at ${g.sha.slice(0, 12)}`}`);
    const end = open === 0 || open === null ? 'The standing order is done.' : `The queue is empty while ${open} stories of the scope stay open: they wait on work outside this order (see next.waiting).`;
    this.deps.notify([`Standing order ${state.scope}: ${end}`, ...report].join('\n'), 'info');
  }

  /** Starts a group's worker again from the beginning (a FAILED, STOPPED or stuck worker). */
  retry(key: string): string {
    const g = this.groupOf(key);
    if (g === undefined) return `${key} is not in the standing order.`;
    const record = this.deps.manager.status(g.lead)[0];
    const workerLive = record !== undefined && ['RUNNING', 'STALLED'].includes(record.state);
    // A group left RUNNING by a worker stopped outside the order (stop, Pi closed, a crash) may be retried too.
    const stuck = g.state === 'RUNNING' && !workerLive && record?.state !== 'NEEDS_INPUT';
    if (g.sha !== null && (g.state === 'COMPLETING' || g.state === 'ATTENTION')) {
      const state = this.setGroup(g.lead, { state: 'COMPLETING', note: null });
      this.runCompletes(state?.scope ?? '', g.keys.filter((k) => !g.completed.includes(k)), g.sha);
      return `Completing ${g.keys.join(', ')} again at ${g.sha.slice(0, 12)}.`;
    }
    if (g.state !== 'ATTENTION' && !stuck) return `${g.keys.join(', ')} is ${g.state}; only a group that needs the developer can be retried.`;
    if (record !== undefined && ['RUNNING', 'STALLED', 'NEEDS_INPUT'].includes(record.state)) this.deps.manager.stop(g.lead);
    this.setGroup(g.lead, { state: 'QUEUED', note: null });
    return this.fill().join('\n') || `${g.keys.join(', ')} queued; it starts when a slot is free.`;
  }

  /** Releases a group's stories on the Hub (the release command, with the developer's reason) and drops them. */
  release(key: string, reason: string): string {
    const g = this.groupOf(key);
    if (g === undefined) return `${key} is not in the standing order.`;
    if (g.state === 'DONE' || g.state === 'RELEASED') return `${g.keys.join(', ')} is already ${g.state}.`;
    const record = this.deps.manager.status(g.lead)[0];
    if (record !== undefined && ['RUNNING', 'STALLED', 'NEEDS_INPUT'].includes(record.state)) this.deps.manager.stop(g.lead);
    const open = g.keys.filter((k) => !g.completed.includes(k));
    this.setGroup(g.lead, { state: 'RELEASED', note: reason });
    open.forEach((k, i) => this.deps.runCommand('release', `${k} ${reason}`, i > 0));
    const lines = this.fill();
    this.finishIfDone(null);
    return [`Releasing ${open.join(', ')}: ${reason}`, ...lines].join('\n');
  }

  private groupOf(key: string): OrderGroup | undefined {
    return this.deps.store.get()?.groups.find((g) => g.keys.includes(key));
  }

  /** The watchdog's turn: asks this session to renew the lease of a running worker's story before it expires. */
  renewLeases(now: number = Date.now()): string[] {
    const state = this.deps.store.get();
    if (state === undefined) return [];
    const due: string[] = [];
    for (const g of state.groups.filter((x) => x.state === 'RUNNING' || x.state === 'ATTENTION')) {
      for (const key of g.keys.filter((k) => !g.completed.includes(k))) {
        const expires = this.deps.leaseExpiry(key);
        const asked = this.renewAsked.get(key) ?? 0;
        if (expires === null || expires - now > RENEW_BEFORE_MS || now - asked < RENEW_BEFORE_MS) continue;
        this.renewAsked.set(key, now);
        due.push(key);
      }
    }
    if (due.length > 0) {
      this.deps.instruct(
        `holycode-hub standing order: the lease of ${due.join(', ')} expires within the hour while its worker still runs. Renew it now: call the \`work_claim\` tool on the \`holycode-hub\` MCP server once per story with { "project_id": <the pointer's Project ID>, "story_id": "<key>" } (plus the pointer's repository_id when it has one) — it only renews the lease. Ask nothing and start no work on it in this session.`,
      );
    }
    return due;
  }

  /** The order as text, for the status action. */
  describe(): string {
    const state = this.deps.store.get();
    if (state === undefined) return 'No standing order is running in Pi.';
    const lines = state.groups.map((g) => {
      const worker = this.deps.manager.status(g.lead)[0];
      const run = worker === undefined ? '' : ` · worker ${worker.state}`;
      return `  ${g.keys.join(', ')} — ${g.state}${run}${g.worktree === null ? '' : ` · ${g.worktree}`}${g.note === null ? '' : `\n    ${g.note}`}`;
    });
    return [`Standing order ${state.scope} · worker model ${state.workerModel ?? 'session model'} · cap ${state.cap}`, ...lines].join('\n');
  }
}

// HH-597 — the commands the extension registers: the package's rendered commands (commands/) and
// the framework cards the Hub delivered (~/.holycode-hub/pi/commands-cache/). Each becomes the
// `/holycode-hub:<name>` command; running it sends its body, with the arguments filled in, to the
// model — exactly what Pi does with a prompt template — drawn in the chat as one line (HH-690,
// `command-dispatch.ts`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface PiCommandFile {
  /** The name without the prefix: the file name without `.md`. */
  readonly id: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly body: string;
}

function frontmatterValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}

/** Parses one command file: `---` front matter (`description`, `argument-hint`), then the body. */
export function parseCommandFile(id: string, text: string): PiCommandFile {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) return { id, description: text.split('\n').find((line) => line.trim() !== '')?.trim() ?? id, body: text };
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), frontmatterValue(line.slice(colon + 1)));
  }
  const hint = fields.get('argument-hint');
  return {
    id,
    description: fields.get('description') ?? id,
    ...(hint !== undefined && hint !== '' ? { argumentHint: hint } : {}),
    body: match[2] ?? '',
  };
}

/** Every `*.md` command file in a folder, sorted by name; a missing folder has none. */
export function loadCommandFiles(dir: string): PiCommandFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .map((name) => parseCommandFile(name.slice(0, -3), readFileSync(path.join(dir, name), 'utf8')));
}

/** Fills in `$ARGUMENTS` / `$@` (all arguments, as typed) — the placeholders the commands use. */
export function expandArguments(body: string, args: string): string {
  const typed = args.trim();
  return body.replaceAll('$ARGUMENTS', typed).replaceAll('$@', typed);
}

/**
 * HH-671 — what the Pi client adds to a framework card when it registers it, after the Hub's text.
 * The Hub's card stays the one Claude Code runs; only Pi reads these lines, and only when its
 * extension has the tool they name (an older Pi package never registers them).
 */
export const CARD_ADDENDA: Readonly<Record<string, string>> = Object.freeze({
  'execute-work': [
    '',
    '**Pi: parallel standing order (background workers)** — in Pi this replaces the per-story loop and the parallel-run part of the standing-order paragraph above. Leave `--worker-model <provider/model>` out of every `/holycode-hub:*` argument, like `--parallel=N` and `--sequential`. In step 1 skip the claim\'s Start / Decline question for a standing order: the batch confirmation below is the Start answer for every handed-out story. After the claim, read the `parallel-worktrees` guidance and group the handed-out stories as it says, then call `holycode_standing_order` once with `action: "start"`, `scope` (the scope arguments as typed, flags left out), `groups` (the story keys of each group, its first story first) and `parallel`, `sequential` or `worker_model` when they were given. It shows the developer one confirmation — the stories, the worker model, the number of workers and a rough token estimate — and starts one background worker per group in its own worktree and port range: at most 3, and never more than the lease\'s concurrent-story limit. Do not implement, verify or complete the handed-out stories in this session: each worker implements and verifies its stories; when a worker\'s verify passed, the extension runs `/holycode-hub:complete <key> <sha> --scope <scope>` here, queues what the Hub hands out and starts workers for it, and asks this session to renew a running worker\'s lease before it expires. When a worker fails, stalls or needs an answer, tell the developer its question or log tail and let them choose: answer it (`holycode_worker_resume` with their words), retry (`holycode_standing_order` `action: "retry"`) or release (`action: "release"` with their reason). `action: "status"` shows the order. When the developer declines the confirmation, ask for one reason and run `/holycode-hub:release <key> <reason>` for each handed-out story.',
    '',
  ].join('\n'),
});

/** A card with the Pi client's addendum, when it has one. */
export function withAddendum(card: PiCommandFile): PiCommandFile {
  const addendum = CARD_ADDENDA[card.id];
  return addendum === undefined ? card : { ...card, body: `${card.body.replace(/\n*$/, '\n')}${addendum}` };
}

/**
 * The bundled commands plus the cached framework cards. A card never replaces a bundled command
 * of the same name (the package's own command is the reviewed one).
 */
export function commandsToRegister(bundledDir: string, cardsDir: string, addenda = true): PiCommandFile[] {
  const bundled = loadCommandFiles(bundledDir);
  const names = new Set(bundled.map((c) => c.id));
  const cards = loadCommandFiles(cardsDir).filter((card) => !names.has(card.id));
  return [...bundled, ...(addenda ? cards.map(withAddendum) : cards)];
}

// HH-597 — the commands the extension registers: the package's rendered commands (commands/) and
// the framework cards the Hub delivered (~/.holycode-hub/pi/commands-cache/). Each becomes the
// `/holycode-hub:<name>` command; running it sends its body, with the arguments filled in, as the
// developer's message — exactly what Pi does with a prompt template.
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
 * The bundled commands plus the cached framework cards. A card never replaces a bundled command
 * of the same name (the package's own command is the reviewed one).
 */
export function commandsToRegister(bundledDir: string, cardsDir: string): PiCommandFile[] {
  const bundled = loadCommandFiles(bundledDir);
  const names = new Set(bundled.map((c) => c.id));
  return [...bundled, ...loadCommandFiles(cardsDir).filter((card) => !names.has(card.id))];
}

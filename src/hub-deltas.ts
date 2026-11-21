// HH-673 — the extension applies the deltas of a Hub work_sync / work_claim result itself, so their
// payload never passes through the model.
//
// The commands used to tell the model to pipe `command_deltas` (every framework card), the guidance
// bodies and the project rule files into the apply scripts. That put the whole payload into the
// conversation and made the model copy it into a bash call: Pi cuts an MCP result over 20 KB in the
// middle and saves the full text to a file, so the model read the file back in pieces and re-sent
// it — a request of over 1 MB on Fireworks. Pi's `tool_result` event may replace a result before
// the model sees it, so the extension now runs the same apply logic the scripts use (imported, not
// copied) on the full result and hands the model the result with each delta replaced by a one-line
// summary. The rule tier keeps its refusal and unsynced-local-edit behaviour unchanged.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { applyCommandDeltas } from '../scripts/apply-command-deltas.mjs';
import { applyRuleDeltas } from '../scripts/apply-rule-deltas.mjs';
import { piToolName } from './hub-calls';
import type { PiToolResultEvent } from './pi-types';

const WORK_SYNC = piToolName('work_sync');
const WORK_CLAIM = piToolName('work_claim');

/** The prefix of every summary the extension leaves in a delta's place. */
export const APPLIED = 'applied by the extension:';
export const NOT_APPLIED = 'not applied by the extension:';

interface CardDeltas {
  changed: unknown[];
  removed: unknown[];
  manifest_sha256?: string;
}

interface ProjectDeltas {
  changed: unknown[];
  removed: unknown[];
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

function textOf(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const texts = blocks.map((block) => (block as { type?: unknown; text?: unknown } | null)?.text).filter((text): text is string => typeof text === 'string');
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function parseObject(text: string | undefined): JsonObject | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The full Hub result. Pi gives the model at most 20 KB of an MCP result and keeps the raw result in
 * `structuredContent` (and the full text in `details.fullOutputPath`), so those come first; the
 * model-facing text is the last resort.
 */
export function fullHubResult(event: Pick<PiToolResultEvent, 'content' | 'structuredContent' | 'details'>): JsonObject | undefined {
  const raw = event.structuredContent;
  if (isObject(raw)) {
    // A copy: the summaries replace fields, and Pi keeps its own object.
    if (isObject(raw.structuredContent)) return structuredClone(raw.structuredContent);
    const fromRaw = parseObject(textOf(raw.content));
    if (fromRaw !== undefined) return fromRaw;
  }
  const saved = isObject(event.details) ? event.details.fullOutputPath : undefined;
  if (typeof saved === 'string' && existsSync(saved)) {
    const fromFile = parseObject(readFileSync(saved, 'utf8'));
    if (fromFile !== undefined) return fromFile;
  }
  return parseObject(textOf(event.content));
}

const isCardDeltas = (value: unknown): value is CardDeltas => isObject(value) && Array.isArray(value.changed) && Array.isArray(value.removed);

function cardSummary(deltas: unknown, cacheDir: string): string {
  if (!isCardDeltas(deltas)) return `${NOT_APPLIED} not a deltas object`;
  const s = applyCommandDeltas(deltas, cacheDir);
  return `${APPLIED} written ${s.written}, removed ${s.removed}, promoted ${s.promoted}, refused ${s.refused}, skipped ${s.skipped}`;
}

function ruleSummary(deltas: unknown, projectRoot: string): string {
  const project = isObject(deltas) ? deltas.project : undefined;
  // A pre-US-044 shape carries only the withdrawn framework tier: nothing to apply, as in the script.
  if (!isCardDeltas(project)) return isCardDeltas(deltas) ? `${APPLIED} nothing to apply` : `${NOT_APPLIED} not a rule_deltas object`;
  const s = applyRuleDeltas(project as ProjectDeltas, projectRoot).project;
  const conflicts = s.conflicts.length === 0 ? 'none' : `${s.conflicts.join(', ')} (unsynced local edits, not overwritten — run /holycode-hub:sync)`;
  return `${APPLIED} written ${s.written}, dropped ${s.dropped}, refused ${s.refused}, conflicts ${conflicts}`;
}

function applied(owner: JsonObject, key: string, apply: (deltas: unknown) => string): boolean {
  if (!(key in owner)) return false;
  try {
    owner[key] = apply(owner[key]);
  } catch (error) {
    owner[key] = `${NOT_APPLIED} ${error instanceof Error ? error.message : String(error)}`;
  }
  return true;
}

export interface ApplyPlaces {
  /** `~/.holycode-hub/pi` — holds `commands-cache/` and `guidance-cache/`. */
  readonly runtimeDir: string;
  /** The repository the project rule files land in (the session's working directory). */
  readonly projectRoot: string;
}

/**
 * Applies the deltas of a successful Hub work_sync / work_claim result and returns the text the
 * model gets instead: the same result with each delta replaced by its one-line summary. Undefined
 * for any other tool, a failed call, or a result that carries no delta.
 */
export function applyHubDeltas(event: PiToolResultEvent, places: ApplyPlaces): string | undefined {
  if (event.isError === true || (event.toolName !== WORK_SYNC && event.toolName !== WORK_CLAIM)) return undefined;
  const result = fullHubResult(event);
  if (result === undefined) return undefined;
  const owner = event.toolName === WORK_CLAIM ? result.directive : result;
  if (!isObject(owner)) return undefined;
  const cards = (cache: string) => (deltas: unknown) => cardSummary(deltas, path.join(places.runtimeDir, cache));
  const touched = [
    applied(owner, 'rule_deltas', (deltas) => ruleSummary(deltas, places.projectRoot)),
    applied(owner, 'command_deltas', cards('commands-cache')),
    applied(owner, 'guidance_deltas', cards('guidance-cache')),
  ];
  return touched.some(Boolean) ? JSON.stringify(result) : undefined;
}

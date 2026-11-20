// HH-599 — a model's tier for the session-start line, from the recommended list the Hub last sent
// (`~/.holycode-hub/pi/models.json`). Without a saved list the tier is UNKNOWN: the line says so
// instead of guessing. Never a network call.
//
// HH-669 — the list is saved whenever a Hub work_models call comes back (Pi's tool_result event):
// an extension cannot call an MCP tool itself, so the session-start banner asks the model to call
// work_models once while the saved list is missing or more than a day old.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { saveModels } from '../scripts/save-models.mjs';
import { piToolName } from './hub-calls';
import { findListed } from './recommended-models';
import type { TierLabel } from './session-banner';

/** How old the saved list may get before the session start asks for a fresh one. */
export const MODELS_REFRESH_MS = 24 * 60 * 60 * 1000;

const WORK_MODELS_TOOL = piToolName('work_models');

/** True when no list is saved, or the saved one is older than {@link MODELS_REFRESH_MS}. */
export function modelsListStale(runtimeDir: string, now: number = Date.now()): boolean {
  const file = path.join(runtimeDir, 'models.json');
  return !existsSync(file) || now - statSync(file).mtimeMs > MODELS_REFRESH_MS;
}

/**
 * Saves a successful Hub work_models result as the recommended list; any other tool result is left
 * alone. Returns whether a list was saved (an answer that is not a list changes nothing).
 */
export function saveWorkModelsResult(runtimeDir: string, toolName: string, content: readonly unknown[] | undefined): boolean {
  if (toolName !== WORK_MODELS_TOOL) return false;
  for (const block of content ?? []) {
    const text = (block as { type?: unknown; text?: unknown } | null)?.text;
    if (typeof text === 'string' && saveModels(text, runtimeDir).ok) return true;
  }
  return false;
}

const TIERS = new Set(['CERTIFIED', 'SUPPORTED', 'EXPERIMENTAL']);

export function savedTier(runtimeDir: string, provider: string, model: string): TierLabel {
  const file = path.join(runtimeDir, 'models.json');
  if (!existsSync(file)) return 'UNKNOWN';
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as { models?: { provider?: string; model?: string; tier?: string }[] };
    if (!Array.isArray(list.models)) return 'UNKNOWN';
    const found = findListed(list.models, provider, model);
    if (found === undefined) return 'NOT_LISTED';
    return typeof found.tier === 'string' && TIERS.has(found.tier) ? (found.tier as TierLabel) : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

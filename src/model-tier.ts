// HH-599 — a model's tier for the session-start line, from the recommended list the Hub last sent
// (`~/.holycode-hub/pi/models.json`, saved by the models command). Without a saved list the tier is
// UNKNOWN: the line says so instead of guessing. Never a network call.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { TierLabel } from './session-banner';

const TIERS = new Set(['CERTIFIED', 'SUPPORTED', 'EXPERIMENTAL']);

export function savedTier(runtimeDir: string, provider: string, model: string): TierLabel {
  const file = path.join(runtimeDir, 'models.json');
  if (!existsSync(file)) return 'UNKNOWN';
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as { models?: { provider?: string; model?: string; tier?: string }[] };
    if (!Array.isArray(list.models)) return 'UNKNOWN';
    const found = list.models.find((m) => m.provider === provider && m.model === model);
    if (found === undefined) return 'NOT_LISTED';
    return typeof found.tier === 'string' && TIERS.has(found.tier) ? (found.tier as TierLabel) : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

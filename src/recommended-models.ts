// HH-604 AC-5 — the recommended model list on the Pi side. The Hub serves it through `work_models`;
// the commands save the latest answer into `~/.holycode-hub/pi/models.json` (scripts/save-models.mjs),
// and the package ships a copy (`models/recommended-models.json`, a byte copy of the Hub's file) for
// when the Hub has not answered yet. The preset shortcuts and the session-start tier read it here.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type ModelTier = 'CERTIFIED' | 'SUPPORTED' | 'EXPERIMENTAL';

export interface RecommendedModel {
  readonly provider: string;
  readonly model: string;
  readonly tier: ModelTier;
  readonly notes: string;
  readonly settings: Readonly<Record<string, string | number | boolean>>;
}

export interface RecommendedList {
  readonly version: string;
  readonly models: readonly RecommendedModel[];
  readonly allowedProviders: readonly string[] | null;
  /** Where the list came from: the Hub's last answer, or the copy bundled with the package. */
  readonly source: 'hub' | 'bundled';
}

const TIERS = new Set<string>(['CERTIFIED', 'SUPPORTED', 'EXPERIMENTAL']);

function isModel(value: unknown): value is RecommendedModel {
  const m = value as Partial<RecommendedModel> | null;
  return (
    m !== null &&
    typeof m === 'object' &&
    typeof m.provider === 'string' &&
    typeof m.model === 'string' &&
    typeof m.tier === 'string' &&
    TIERS.has(m.tier)
  );
}

/** Parses a work_models answer (or the bundled file); null when it is not one. */
export function parseRecommended(text: string): Omit<RecommendedList, 'source'> | null {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; models?: unknown; policy?: { allowed_providers?: unknown } };
    if (typeof parsed.version !== 'string' || !Array.isArray(parsed.models) || !parsed.models.every(isModel)) return null;
    const allowed = parsed.policy?.allowed_providers;
    return {
      version: parsed.version,
      models: parsed.models,
      allowedProviders: Array.isArray(allowed) && allowed.every((p) => typeof p === 'string') ? allowed : null,
    };
  } catch {
    return null;
  }
}

/** The Hub's last answer when the runtime folder holds a valid one, else the bundled copy. */
export function readRecommended(runtimeDir: string, packageRoot: string): RecommendedList {
  const saved = path.join(runtimeDir, 'models.json');
  if (existsSync(saved)) {
    const fromHub = parseRecommended(readFileSync(saved, 'utf8'));
    if (fromHub !== null) return { ...fromHub, source: 'hub' };
  }
  const bundled = parseRecommended(readFileSync(path.join(packageRoot, 'models', 'recommended-models.json'), 'utf8'));
  if (bundled === null) throw new Error('the bundled recommended-models.json is not a valid list');
  return { ...bundled, source: 'bundled' };
}

/**
 * A model's tier. `NOT_LISTED` when the list does not name it; `UNKNOWN` when only the bundled
 * copy is known, so the tier may be out of date (the Hub has not answered on this machine yet).
 */
export function tierOf(list: RecommendedList, provider: string, model: string): ModelTier | 'NOT_LISTED' | 'UNKNOWN' {
  const found = list.models.find((m) => m.provider === provider && m.model === model);
  if (found !== undefined) return found.tier;
  return list.source === 'bundled' ? 'UNKNOWN' : 'NOT_LISTED';
}

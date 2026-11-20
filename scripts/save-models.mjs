#!/usr/bin/env node
// HH-604 — saves the Hub's work_models answer (JSON on stdin) as the Pi client's recommended list,
// `models.json` next to this script's folder (`~/.holycode-hub/pi/models.json`). Only a valid
// answer is written, through a temporary file and a rename; anything else leaves the old list.
// Prints one line: the version saved, or why nothing was.
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TIERS = new Set(['CERTIFIED', 'SUPPORTED', 'EXPERIMENTAL']);

/** True when `value` is a work_models answer. */
export function isWorkModelsAnswer(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.version === 'string' &&
    Array.isArray(value.models) &&
    value.models.every((m) => m && typeof m.provider === 'string' && typeof m.model === 'string' && TIERS.has(m.tier))
  );
}

/** Writes the answer into `<dir>/models.json`; returns the line to print. */
export function saveModels(text, dir) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return { ok: false, line: 'save-models: not JSON; the recommended list was not changed' };
  }
  if (!isWorkModelsAnswer(answer)) return { ok: false, line: 'save-models: not a work_models answer; the recommended list was not changed' };
  const file = path.join(dir, 'models.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: answer.version, models: answer.models, policy: answer.policy ?? { allowed_providers: null } }, null, 2)}\n`);
  renameSync(temporary, file);
  return { ok: true, line: `save-models: recommended list ${answer.version} saved (${answer.models.length} models)` };
}

function main() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = saveModels(readFileSync(0, 'utf8'), dir);
  console.log(result.line);
  process.exitCode = result.ok ? 0 : 1;
}

// realpath both: a symlinked folder (macOS /var → /private/var) must still count as "run directly".
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

#!/usr/bin/env node
// HH-600 — the Pi client's effort CLI, run by /holycode-hub:verify, /complete and /progress
// (`effort-capture.mjs take` / `usage`). The measuring engine is effort-core.mjs, a byte copy of the
// Claude Code plugin's effort-capture.mjs, so the buffer (~/.holycode-hub/effort/), the segment
// format and the delivery rules are the same for both clients. Pi feeds the engine from its
// extension (src/effort.ts) instead of Claude Code hooks; the one Pi difference is how each model
// is paid for, which the extension records per model (state.usage.piSources) from Pi's own sign-in:
// an API key, a subscription login, or a local model (UNKNOWN). Counts and timestamps only.
import console from 'node:console';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadState, saveState, stateFileFor, take, usageReport } from './effort-core.mjs';

/** The model_usage report with each model's own payment source (UNKNOWN when none was recorded). */
export function piUsageReport(state) {
  const sources = state.usage?.piSources ?? {};
  return usageReport(state, 'UNKNOWN').map((entry) => ({ ...entry, source: sources[entry.model] ?? 'UNKNOWN' }));
}

export function run(command, cwd, now) {
  const file = stateFileFor(cwd);
  const state = loadState(file);
  if (command === 'take') {
    const segments = take(state, now);
    saveState(file, state);
    return JSON.stringify(segments);
  }
  if (command === 'usage') return JSON.stringify(piUsageReport(state));
  return '';
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(run(process.argv[2], process.cwd(), Date.now()));
  } catch {
    console.log('[]');
  }
}

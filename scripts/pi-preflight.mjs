#!/usr/bin/env node
// HH-597 — the Pi lines of /holycode-hub:preflight (the shared preflight.mjs is a byte copy of core
// and stays unchanged): the Pi version, this package's version, and whether a model is set.
// Reads only; prints one line each, ✓ / ✗ like preflight.mjs. Never prints a key.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The configured model as `provider/model`, from the project's then the user's Pi settings. */
export function configuredModel(cwd, agentDir) {
  for (const file of [path.join(cwd, '.pi', 'settings.json'), path.join(agentDir, 'settings.json')]) {
    const settings = existsSync(file) ? readJson(file) : null;
    if (settings !== null && typeof settings.defaultModel === 'string' && settings.defaultModel !== '') {
      return typeof settings.defaultProvider === 'string' ? `${settings.defaultProvider}/${settings.defaultModel}` : settings.defaultModel;
    }
  }
  return null;
}

export function preflightLines({ piVersion, packageVersion, model }) {
  return [
    piVersion === null ? '✗ Pi not found on PATH: install Pi, then run /holycode-hub:preflight again' : `✓ Pi ${piVersion}`,
    packageVersion === null ? '✗ Rapid Dev Hub package version unknown: run /reload in Pi' : `✓ Rapid Dev Hub package ${packageVersion}`,
    model === null ? '✗ No model set: run /holycode-hub:models add' : `✓ Model ${model}`,
  ];
}

function piVersion() {
  try {
    return execFileSync('pi', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function main() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
  const pkg = readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
  const lines = preflightLines({
    piVersion: piVersion(),
    packageVersion: pkg !== null && typeof pkg.version === 'string' ? pkg.version : null,
    model: configuredModel(process.cwd(), agentDir),
  });
  console.log(lines.join('\n'));
  process.exitCode = lines.some((line) => line.startsWith('✗')) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

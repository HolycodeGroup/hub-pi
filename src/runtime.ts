// HH-597 — the Pi client's runtime folder, `~/.holycode-hub/pi/` (the commands name it
// `$HOME/.holycode-hub/pi`, in place of Claude Code's plugin root). On load the extension copies
// the package's scripts, the AGENTS.md Hub block and its package.json (the version the commands
// report) there, writing a file only when it changed. The framework cards (`commands-cache/`) and
// the guidance cache are written there by the commands' apply scripts. Never inside a repository.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** `~/.holycode-hub/pi` (`HOLYCODE_HUB_PI_HOME` overrides it, for tests). */
export function piRuntimeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.HOLYCODE_HUB_PI_HOME;
  return configured !== undefined && configured !== '' ? configured : path.join(home, '.holycode-hub', 'pi');
}

/** The package files that go to the runtime folder, relative to the package root. */
export function runtimeFiles(packageRoot: string): string[] {
  const listed = (dir: string, ext: string): string[] =>
    existsSync(path.join(packageRoot, dir))
      ? readdirSync(path.join(packageRoot, dir))
          .filter((name) => name.endsWith(ext))
          .sort()
          .map((name) => path.join(dir, name))
      : [];
  return ['package.json', ...listed('scripts', '.mjs'), ...listed('agents', '.md')];
}

function sameContent(a: string, b: string): boolean {
  return existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

/** Copies the runtime files that differ; returns the relative paths it wrote. */
export function installRuntime(packageRoot: string, runtimeDir: string): string[] {
  const written: string[] = [];
  for (const rel of runtimeFiles(packageRoot)) {
    const from = path.join(packageRoot, rel);
    const to = path.join(runtimeDir, rel);
    if (sameContent(from, to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    written.push(rel);
  }
  return written;
}

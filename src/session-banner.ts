// HH-599 — what a Pi session starts with, the same as the Claude Code SessionStart hook
// (packages/client-claude-code/hooks/session-start.sh, read as the reference, not edited): the git
// conventions, the link state from the pointer file, the project rule files to read and a stale
// AGENTS.md Hub block warning — plus one Pi line, the model in use and its tier. Plain file reads
// only: never a network call, never a reason to stop the session.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const START_MARKER = '<!-- holycode-hub:start -->';

export const GIT_CONVENTIONS = Object.freeze([
  'holycode-hub git conventions (always on):',
  '- Conventional commit subjects (feat:, fix:, docs:, chore: ...), imperative, <= 72 chars.',
  '- NO AI credits: never add Co-Authored-By: <AI> or "Generated with ..." trailers.',
  '- Work on a <type>/<descriptor> branch and open a pull request.',
  '- Never commit directly to main.',
]);

/** The block version of a file holding the Hub block: its marker, 1 without one, null when absent. */
export function blockVersion(file: string): number | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(START_MARKER)) return null;
  const match = /^<!-- holycode-hub:block-version: (\d+) -->/m.exec(text);
  return match === null ? 1 : Number(match[1]);
}

function pointerField(text: string, field: string): string {
  return new RegExp(`^\\*\\*${field}:\\*\\*\\s*(\\S*)`, 'm').exec(text)?.[1] ?? '';
}

function projectRulesLine(cwd: string): string {
  const dir = path.join(cwd, '.project-management', 'rules');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];
  return names.length > 0
    ? `holycode-hub: project rules in .project-management/rules/ (${names.join(', ')}) — read every file before implementing; on a conflict they win over Hub guidance`
    : 'holycode-hub: no project rules in .project-management/rules/ yet — a claim delivers them once the team syncs some';
}

function staleBlockLine(cwd: string, shippedBlock: string): string | null {
  const shipped = blockVersion(shippedBlock);
  if (shipped === null) return null;
  const current = blockVersion(path.join(cwd, 'AGENTS.md'));
  if (current === null) return `holycode-hub: AGENTS.md Hub block is missing, the Pi package ships v${shipped} — run /holycode-hub:init to refresh`;
  if (current < shipped) return `holycode-hub: AGENTS.md Hub block is v${current}, the Pi package ships v${shipped} — run /holycode-hub:init to refresh`;
  return null;
}

export type TierLabel = 'CERTIFIED' | 'SUPPORTED' | 'EXPERIMENTAL' | 'NOT_LISTED' | 'UNKNOWN';

/** The model line: the tier, with a warning for an Experimental, unlisted or unknown model. */
export function modelLine(model: { provider: string; id: string } | undefined, tier: TierLabel): string {
  if (model === undefined) return 'holycode-hub: no model set — run /holycode-hub:models add';
  const name = `${model.provider}/${model.id}`;
  switch (tier) {
    case 'CERTIFIED':
    case 'SUPPORTED':
      return `holycode-hub: model ${name} — ${tier.toLowerCase()} on the recommended list`;
    case 'EXPERIMENTAL':
      return `holycode-hub: warning — model ${name} is experimental on the recommended list (not yet measured)`;
    case 'NOT_LISTED':
      return `holycode-hub: warning — model ${name} is not on the recommended list (allowed; not measured by Holycode)`;
    default:
      return `holycode-hub: warning — model ${name}: tier unknown until the Hub's recommended list is loaded (/holycode-hub:models)`;
  }
}

export interface BannerInput {
  readonly cwd: string;
  /** The AGENTS.md Hub block this package ships. */
  readonly shippedBlock: string;
  readonly model: { provider: string; id: string } | undefined;
  readonly tier: TierLabel;
}

/** Every line of the session-start banner, in the Claude Code hook's order, plus the model line. */
export function sessionBanner(input: BannerInput): string[] {
  const lines = [...GIT_CONVENTIONS];
  const pointer = path.join(input.cwd, '.project-management', 'hub-pointer.md');
  if (!existsSync(pointer)) return [...lines, 'holycode-hub: no Hub project in this directory — run /holycode-hub:init', modelLine(input.model, input.tier)];
  const text = readFileSync(pointer, 'utf8');
  const projectId = pointerField(text, 'Project ID');
  if (projectId === '') return [...lines, 'holycode-hub: pointer file is invalid — re-run /holycode-hub:init', modelLine(input.model, input.tier)];
  const hubUrl = pointerField(text, 'Hub URL') || '<hub-url>';
  lines.push(`holycode-hub: linked to project ${projectId} at ${hubUrl}`, projectRulesLine(input.cwd));
  const stale = staleBlockLine(input.cwd, input.shippedBlock);
  if (stale !== null) lines.push(stale);
  return [...lines, modelLine(input.model, input.tier)];
}

// HH-597 — the Pi adapter: renders the tool-neutral command surface (hub-client-core's
// command-spec.mjs, read only — rule MC-1) into Pi's prompt-template form.
//
// Pi turns a Markdown file with `description` / `argument-hint` front matter into a `/` command.
// The Hub extension registers each rendered command under its `/holycode-hub:<name>` name (Pi
// prompt-template file names cannot carry the `:` on Windows, extension commands can), so a Pi
// developer types the same commands as a Claude Code developer.
//
// Zero dependencies, deterministic: the same spec always renders the same bytes (a drift test pins
// the committed commands/ folder to this renderer).
import { APPENDED_STEPS, BODY_REPLACEMENTS, DESCRIPTION_REPLACEMENTS, WORDING_OVERRIDES } from './overrides.mjs';

/**
 * Where the Pi client keeps its runtime files on the developer's machine: the scripts the commands
 * run, the framework cards, the guidance cache and the package version. The extension copies the
 * package's files there on load. Plays the part of Claude Code's `${CLAUDE_PLUGIN_ROOT}`.
 */
export const PI_ROOT = '$HOME/.holycode-hub/pi';

/** The command name prefix, as in the Claude Code plugin. */
export const COMMAND_PREFIX = 'holycode-hub:';

/**
 * Maps the Claude Code plugin's file paths to the Pi client's: the version moves from the plugin
 * manifest to the package manifest, everything else keeps its path under the Pi root.
 * @param {string} body
 * @returns {string}
 */
export function mapPluginPaths(body) {
  return body
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json', `${PI_ROOT}/package.json`)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', PI_ROOT);
}

/**
 * Applies every wording override, in order.
 * @param {string} text
 * @returns {string}
 */
export function applyWording(text) {
  let pi = text;
  for (const { find, replace } of WORDING_OVERRIDES) pi = pi.replaceAll(find, replace);
  return pi;
}

/**
 * The Pi form of one of the Hub's framework cards (apps/backend/commands/*.md, HH-598): the same
 * path mapping and wording overrides as the commands, applied to the whole card.
 * @param {string} card
 * @returns {string}
 */
export function toPiCard(card) {
  return applyWording(mapPluginPaths(card));
}

/**
 * The Pi description of one command.
 * @param {string} id
 * @param {string} description
 * @returns {string}
 */
export function toPiDescription(id, description) {
  return DESCRIPTION_REPLACEMENTS[/** @type {keyof typeof DESCRIPTION_REPLACEMENTS} */ (id)] ?? applyWording(description);
}

/**
 * The Pi body of one command: a whole-body replacement when the command has one, else the core
 * body with the paths mapped, the wording overrides applied and any Pi step appended.
 * @param {string} id
 * @param {string} body
 * @returns {string}
 */
export function toPiBody(id, body) {
  const replacement = BODY_REPLACEMENTS[/** @type {keyof typeof BODY_REPLACEMENTS} */ (id)];
  if (replacement !== undefined) return replacement;
  const pi = applyWording(mapPluginPaths(body));
  const appended = APPENDED_STEPS[/** @type {keyof typeof APPENDED_STEPS} */ (id)];
  return appended === undefined ? pi : `${pi}${appended}`;
}

/**
 * Renders one spec entry as a Pi prompt template.
 * @param {{ id: string, description: string, argumentHint?: string, bodyMarkdown: string }} entry
 * @returns {{ filename: string, contents: string }}
 */
export function renderPiCommand(entry) {
  const hint = entry.argumentHint === undefined || entry.argumentHint === '' ? '' : `argument-hint: ${JSON.stringify(entry.argumentHint)}\n`;
  const frontmatter = `---\ndescription: ${JSON.stringify(toPiDescription(entry.id, entry.description))}\n${hint}---\n`;
  return { filename: `${entry.id}.md`, contents: `${frontmatter}${toPiBody(entry.id, entry.bodyMarkdown)}` };
}

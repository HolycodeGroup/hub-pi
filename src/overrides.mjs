// HH-597 — every Pi-only wording change, in one file so it is easy to review (rule MC-1: the Pi
// adapter reads hub-client-core's command-spec.mjs and never edits it).
//
// An override only changes wording that makes sense in Claude Code alone. It never changes which
// Hub tool a command calls or the arguments it sends; a test compares both with the core body for
// every command (`update` is the one whole-body replacement: its Claude Code body drives the Claude
// Code CLI and marketplace, which Pi does not have).

/**
 * @typedef {object} WordingOverride
 * @property {string} find - exact text in the core body
 * @property {string} replace - its Pi wording
 * @property {string} why - the reason, for review
 */

/** Applied, in order, to every command body after the plugin-root paths are mapped. */
export const WORDING_OVERRIDES = Object.freeze([
  {
    find: 'in Claude Code: `/mcp` → `holycode-hub` → re-authenticate',
    replace: 'in Pi: `/holycode-hub:login`',
    why: 'Pi signs in again through the package command, not Claude Code\'s /mcp screen',
  },
  {
    find: 'this plugin is outdated',
    replace: 'this Pi package is outdated',
    why: 'The client is a Pi package',
  },
  {
    find: "the plugin's `commands-cache/`",
    replace: '`~/.holycode-hub/pi/commands-cache/`',
    why: 'The Pi client keeps the framework cards in its home folder',
  },
  {
    find: 'they must RESTART Claude Code for the new commands to appear (Claude Code registers plugin commands at session start)',
    replace: 'they must run `/reload` in Pi for the new commands to appear (the Hub extension registers the cards when Pi loads it)',
    why: 'Pi reloads its extensions in place',
  },
  {
    find: 'then RESTART Claude Code to install',
    replace: 'then run `/reload` in Pi to install',
    why: 'Pi reloads its extensions in place',
  },
  {
    find: 'restart Claude Code',
    replace: 'run `/reload` in Pi',
    why: 'Pi reloads its extensions in place',
  },
  {
    find: '--tool claude-code`',
    replace: '--tool pi`',
    why: 'HH-679: the worktree script names the calling client, so the warning names the other one (Claude Code)',
  },
  {
    find: 'Pipe the JSON of `result.directive.rule_deltas` into `node "$HOME/.holycode-hub/pi/scripts/apply-rule-deltas.mjs" --project-root "$PWD"` (stdin) and report its one-line summary; a non-zero exit means a delta was refused or a project file was skipped as an unsynced local edit (`project.conflicts`)',
    replace: 'The Hub extension has already applied `result.directive.rule_deltas` to this repository\'s `.project-management/rules/` and left its one-line summary in that field (`applied by the extension: …`) — report the summary; never pipe or copy deltas yourself. `refused` above 0, any `conflicts` (a project file skipped as an unsynced local edit) or `not applied by the extension` means a delta did not land',
    why: 'HH-673: the Pi extension applies the deltas as the result comes back, so the payload never passes through the model',
  },
  {
    find: 'Pipe the JSON of `result.directive.command_deltas` into `node "$HOME/.holycode-hub/pi/scripts/apply-command-deltas.mjs"` (stdin) and report its one-line summary; a non-zero exit means a card was refused — report it, never work around it. When `result.directive.guidance_deltas` is present, pipe its JSON the same way into `node "$HOME/.holycode-hub/pi/scripts/apply-command-deltas.mjs" --cache "$HOME/.holycode-hub/pi/guidance-cache"`.',
    replace: 'The Hub extension has already applied `result.directive.command_deltas` (into `$HOME/.holycode-hub/pi/commands-cache/`) and, when present, `result.directive.guidance_deltas` (into `$HOME/.holycode-hub/pi/guidance-cache/`), and left a one-line summary in each field — report the summaries; never pipe or copy deltas yourself. `refused` above 0 or `not applied by the extension` means a card did not land — report it, never work around it.',
    why: 'HH-673: the Pi extension applies the deltas as the result comes back, so the payload never passes through the model',
  },
  {
    find: 'Pipe the JSON of `result.command_deltas` into `node "$HOME/.holycode-hub/pi/scripts/apply-command-deltas.mjs"` (stdin) and report its one-line summary; a non-zero exit means a card was refused — report it, never work around it.',
    replace: 'The Hub extension has already applied `result.command_deltas` (into `$HOME/.holycode-hub/pi/commands-cache/`) and left its one-line summary in that field (`applied by the extension: …`) — report the summary; never pipe or copy deltas yourself. `refused` above 0 or `not applied by the extension` means a card did not land — report it, never work around it.',
    why: 'HH-673: the Pi extension applies the deltas as the result comes back, so the payload never passes through the model',
  },
]);

/** The one command whose whole body is Pi's own: updating the package goes through Pi. */
export const BODY_REPLACEMENTS = Object.freeze({
  update: [
    '1. Run `pi update --extensions` and show the developer its report as printed. It brings every installed Pi package, this one included, to its latest version.',
    '2. When the report shows this package was already current, say so — nothing needs a reload — and tell the Hub which version this computer runs, so an outdated notice about it clears at once: call the `work_sync` tool on the `holycode-hub` MCP server exactly once with `{ "client_version": "<the version field of $HOME/.holycode-hub/pi/package.json>", "command_cache": <the parsed contents of `$HOME/.holycode-hub/pi/commands-cache/.manifest.json`, when it exists> }`, then report the one-line summary the Hub extension left in `result.command_deltas` (it applies the cards itself as the result comes back; never pipe or copy them yourself). When that call fails, say so in one line — nothing needs doing.',
    '3. When the report shows an update, tell the developer to run `/reload` in Pi once, so the new version of the extension and its commands load, and then `/holycode-hub:sync-commands`, which brings the framework cards for the new version and refreshes the `AGENTS.md` Hub block.',
    '4. On a non-zero exit, relay the failure as printed. Never retry in a loop and never edit Pi\'s settings or the package folder yourself. **Next step:** end your reply with one line that starts with `Next:` — `Next: /reload, then /holycode-hub:sync-commands` after an update, or `Next: carry on` when nothing was updated. Make no further Hub calls for this step.',
    '',
  ].join('\n'),
});

/** Command descriptions that only make sense in Claude Code; other descriptions get the wording overrides. */
export const DESCRIPTION_REPLACEMENTS = Object.freeze({
  update: 'Update this Pi package to its latest version through Pi, then bring the command cards back',
});

/** Steps the Pi client adds to a command, after the core steps. */
export const APPENDED_STEPS = Object.freeze({
  preflight:
    '4. Then run `node "$HOME/.holycode-hub/pi/scripts/pi-preflight.mjs"` and show its three lines as printed: the Pi version, this package\'s version and whether a model is set (when none is, point the developer to `/holycode-hub:models add`).\n',
  // HH-672 — a `.pi/` folder committed on one branch disappears on a switch to a branch without it.
  init:
    '9. Pi: when this checkout has a `.pi/` folder (a project Hub override in `.pi/mcp.json`, or model settings) that git neither ignores (`git check-ignore -q .pi` fails) nor tracks (`git ls-files .pi` prints nothing), recommend in one line, before the `Next:` line, keeping it out of commits with `echo \'.pi/\' >> .git/info/exclude` unless the team decides to share it: a `.pi/` that lives on one branch disappears on a switch to a branch without it, and Pi then talks to the global (production) Hub. Never run it yourself.\n',
});

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

/**
 * Text the Pi client adds INSIDE a command's core steps, right before an anchor sentence of the core
 * body (applied after the wording overrides). The Claude Code card carries the same text through
 * hub-client-core's `CLAUDE_CODE_INSERTIONS` (rule MC-1 keeps the two clients' changes apart).
 * A missing anchor throws, so a core change can never silently drop it.
 * HH-684 — claim adds the speed-up task's one line with Accept / Defer; verify the reason it may still fail.
 */
export const INSERTIONS = Object.freeze({
  // HH-682 — verify sends how long the tests took (`evidence.timing`), just before its one Hub call.
  verify: Object.freeze({
    before: 'Call the `work_verify` tool on the `holycode-hub` MCP server exactly once',
    text: 'Add how long the tests took as `evidence.timing` (HH-682) — optional and never part of the verdict, so leave out any part you could not measure and never estimate a number; all durations are whole milliseconds. `local`: `total_ms` for the whole local gate and `suites`, one entry per suite or workspace with its `name`, `kind` (`UNIT`, `INTEGRATION`, `E2E`, or `OTHER` for a run that mixes kinds) and `duration_ms` — read the time with `node -e "console.log(Date.now())"` before and after each run, or take the runner\'s own reported duration. `ci`: only when this branch has a pull request (`gh pr view --json number` succeeds) — take the pull request\'s head commit from `gh pr view --json headRefOid`, list its finished runs with `gh run list --commit <headRefOid> --event pull_request --status completed --json databaseId,workflowName` and pick the workflow that runs the tests (the CI workflow, not a labeler or scanner), then `gh run view <databaseId> --json jobs`, and send `run_id` (that databaseId), `total_ms` (the earliest `startedAt` to the latest `completedAt` across its jobs) and `jobs`, every job that ran with its `name` and `duration_ms` (`completedAt` − `startedAt`), matrix shards included (at most 50) — leave out skipped jobs that never started; leave `ci` out when there is no pull request, no finished run of the head commit or no `gh`. `slowest`: the 10 slowest test files of the local run, from the runners\' JSON reports (Vitest `--reporter=json --outputFile=<file>`: each file\'s `endTime` − `startTime`; Playwright `--reporter=json`: the sum of each spec file\'s test durations; or the stack\'s equivalent), each with its `path` relative to the repository root (forward slashes, ending in the file\'s extension; leave out a file whose path does not fit) and `duration_ms` — file paths and numbers only, never test names, code or output. ' +
      'When this story accepted a speed-up task (HH-684 — its claim\'s `directive.maintenance`), the Hub checks this timing against the rule that fired: when the new run still fails that rule, add `evidence.speed_up`: `{ "reason": "<why, in words a reviewer can check>" }` — never invent a reason. ',
  }),
  // HH-684 — the claim card shows a speed-up task in one line with Accept / Defer (a Pi selection dialog).
  claim: Object.freeze({
    before: '**Next step:** end your reply with one line that starts with `Next:` — on Start',
    text: '**Speed-up task (HH-684):** when `result.directive.maintenance` is present it is a separate maintenance task, never one of the story\'s acceptance criteria — show its `summary` as one line. When its `status` is `OFFERED`, ask the developer one more question in a selection dialog (`holycode_ask`): **Accept** it into this story, or **Defer** it to the next claim in this repository, and send the answer with one `work_progress` call `{ "project_id": "<that id>", "story_id": "<key>", "maintenance": { "id": "<maintenance.id>", "decision": "ACCEPT" | "DEFER" } }` — this answer is the one Hub call this step allows besides the claim; on Accept, follow `maintenance.guidance` within `maintenance.time_box_minutes` alongside the story. When its `status` is `ACCEPTED`, it is already part of this story. When its `status` is `PARKED`, show its `prompt` and, when `create_story_url` is not null, that link (the Create story button on the project\'s Effort tab) — omit the link when it is null. ',
  }),
});

/** Steps the Pi client adds to a command, after the core steps. */
export const APPENDED_STEPS = Object.freeze({
  preflight:
    '4. Then run `node "$HOME/.holycode-hub/pi/scripts/pi-preflight.mjs"` and show its three lines as printed: the Pi version, this package\'s version and whether a model is set (when none is, point the developer to `/holycode-hub:models add`).\n',
  // HH-672 — a `.pi/` folder committed on one branch disappears on a switch to a branch without it.
  init:
    '9. Pi: when this checkout has a `.pi/` folder (a project Hub override in `.pi/mcp.json`, or model settings) that git neither ignores (`git check-ignore -q .pi` fails) nor tracks (`git ls-files .pi` prints nothing), recommend in one line, before the `Next:` line, keeping it out of commits with `echo \'.pi/\' >> .git/info/exclude` unless the team decides to share it: a `.pi/` that lives on one branch disappears on a switch to a branch without it, and Pi then talks to the global (production) Hub. Never run it yourself.\n',
});

/**
 * HH-678 — added to every Pi command and framework card that calls a Hub tool. In Pi a Hub call
 * runs inside a `codemode` script and only what the script prints reaches the model (and the
 * developer, when they expand the row): printing the whole result is a wall of escaped JSON.
 */
export const HUB_OUTPUT_NOTE =
  '**Pi: print only what the step reports** — in Pi each Hub tool call runs inside a `codemode` script, and only what the script prints reaches you. A Hub tool call there resolves to the MCP result, so the Hub\'s answer is its `structuredContent` (`const result = (await tools.mcp__holycode_hub__<tool>(args)).structuredContent`). Never print the whole result (`text(JSON.stringify(result))`, `return result`): print only the fields this command reads or reports, as one object of just those fields (`text({ <field>: result.<field>, … })`), plus `client_outdated` whenever a result carries it; when a call fails, print the error\'s code and message. The Hub extension shows each Hub call to the developer as one line (`✓ <tool> 160ms`, or ✗ with the Hub\'s error code and message); Ctrl+O expands it to the script and its output.';

/** HH-678 — the fields a command's script prints, where the command names them exactly. */
export const HUB_OUTPUT_FIELDS = Object.freeze({
  status:
    'For this command print only `result.ready`, `result.waiting` and `result.summary` — and, for the full board (no `summary` argument), `result.phases` cut to each phase\'s `name` and `status`, each epic\'s `name` and `status` and each story\'s `key`, `title`, `status`, `points`, `dep_keys`, `doc_impact` and `bug_doc_impact`.',
});

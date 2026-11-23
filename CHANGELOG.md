# Changelog — Rapid Dev Hub client for Pi

The Pi package has its own version line and never shares a release with the Claude Code plugin.

## [0.2.7]

### Added

- **Pi: plan runs record the model used (HH-593).** The reverse-engineer and adopt-project commands send the model of the Pi session — any provider — as `model_usage`, so the Hub records which model produced the plan. A new `effort-capture.mjs model` step names the model the session last answered with (only its id, never message text), also when no story is claimed. The heavy commands' model advice comes from the Hub guidance they already fetch, in provider-neutral words.
- **Acceptance against the Claude Code plugin (HH-605).** A parity table (`docs/PI-CLIENT-PARITY.md`) lists every command and hook of the Claude Code plugin as working on Pi, working through Pi's own mechanism, or a known gap with its reason, and names the test for each; a test keeps it complete. New tests prove a Claude Code developer and a Pi developer can work on one project at the same time without conflicting over the Hub pointer, the `AGENTS.md` block, the project rules or the story worktrees.

### Fixed

- **Pi: a completed story says when its measured effort was not recorded (HH-700).** After a `work_complete` that left measured time segments or token counts behind, Pi now shows the same warning as Claude Code ("… was completed without …; the Hub accepts them only up to completion, so they are not recorded."), worded by the shared effort engine. A completion that carried everything, or a failed one, shows nothing.

## [0.2.6]

### Fixed

- **Commands and the session banner are short in the chat (HH-690).** Running a `/holycode-hub:<name>` command now shows one line — the command as typed, e.g. `/holycode-hub:status summary` — instead of the whole command card; the model still receives exactly the same card text, a command run while Pi is busy still runs as a follow-up, and `Ctrl+O` expands the line to the full card. The session-start banner shows at most two lines — the linked project and the Hub, plus a warning when there is one (wrong Hub, Claude Code in the same folder, the model's tier, a stale AGENTS.md block); the git conventions and the project rules still reach the model, and `Ctrl+O` shows the full banner.

## [0.2.5]

### Added

- **Verify sends how long the tests took (HH-682).** `/holycode-hub:verify` now adds
  `evidence.timing` to its one `work_verify` call: the local gate's wall time per suite, the pull
  request's latest finished CI run with each job and shard (read with `gh`, only when the branch has a
  pull request) and the 10 slowest test files from the runners' JSON reports — whole milliseconds and
  relative file paths only, never test code or output. Optional: a Hub without it still verifies.
- **The claim shows a speed-up task with Accept / Defer (HH-684).** When the Hub hands a claim the
  repository's speed-up task (its tests are slow), `/holycode-hub:claim` shows it in one line — apart
  from the story's acceptance criteria — and asks Accept into this story or Defer to the next claim in a
  selection dialog, sending the answer with one `work_progress` call; a task deferred 3 times shows the
  Hub's question with the link to the project's Effort tab, where its story is created.
  `/holycode-hub:verify` adds `evidence.speed_up.reason` when an accepted task's new run still fails
  its rule.

### Changed

- **Each Hub call is one collapsed line (HH-678).** A Hub tool call made through `codemode` now shows as one line — `✓ project_status 160ms`, or `✗` with the Hub's error code and message — instead of the script and a wall of escaped JSON; `Ctrl+O` expands it to the full script and output and collapses it again. Every command that calls a Hub tool tells its script to print only the fields the step reports (`/holycode-hub:status` prints the ready stories and the summary line). Other tools look exactly as before.

## [0.2.4]

### Added

- **A warning when Pi and Claude Code work in the same folder (HH-679).** Each Pi session keeps a small
  marker for its folder in the repository's git directory (tool, process id, host, start and heartbeat
  times — no prompt text, code or credential, never sent to the Hub), written at session start,
  refreshed by prompts, turns and tool results and removed at shutdown. A session start in a folder
  where a live Claude Code session works says so in the banner and as a notice, and
  `/holycode-hub:claim` of a story whose worktree Claude Code works in shows the warning and asks
  Continue anyway / Stop — before anything is claimed when a story key is given (Stop then ends the
  command with no Hub call and nothing changed); a standing order names the story in a warning notice
  before its worker starts there. Markers of a stopped process, older
  than 10 minutes or from another machine are ignored and replaced. The effort buffer shared with
  Claude Code is written through a temp file and a rename.
- **A warning when Pi and Claude Code use different Hubs for one repository (HH-680).** The session
  start records the Hub URL Pi resolves for the repository (`<git dir>/holycode-hub/hub.json` — URL,
  tool and time only, never a token, never sent to the Hub) and, when Claude Code last recorded another
  Hub there, says which tool uses which Hub, that claims made in one are not visible in the other, and
  the fix for each tool (`.pi/mcp.json` or `pi mcp add -l holycode-hub --url …`; the Claude Code
  plugin's holycode-hub server URL). A record older than 30 days is ignored.

### Fixed

- **Effort measured in Pi in a second clone or on another computer is no longer lost (HH-681).** When a
  story's lease runs out in this folder's effort buffer (for example because the story was completed
  from another clone), its measured time and token counts are kept for 7 days, and each session start
  asks the model, in a hidden message, for one quiet `work_progress` call per story with pending effort.
  The Hub accepts it from the person who completed the story for 7 days and never counts the same time
  twice; a refusal drops that story's effort from the buffer quietly.

## [0.2.3]

### Fixed

- **The session names the Hub it talks to, and warns when a staging override is lost (HH-672).** Every
  session start shows the Hub host and whether the project's `.pi/mcp.json` or the global Pi config sets
  it; `/holycode-hub:login` and the first-run sign-in name the host before the browser opens. The last
  Hub URL is remembered per repository in `~/.holycode-hub/pi/last-hub.json` (the URL only). A repository
  that last used a non-production Hub and now resolves to another one gets a loud warning with the fix —
  restore `.pi/mcp.json`, or `pi mcp add -l holycode-hub --url <last url>` — and no sign-in offer for the
  other Hub. After `/holycode-hub:claim` creates the story worktree, the extension copies `.pi/mcp.json` and
  only the model fields of `.pi/settings.json` into it, and the docs recommend keeping `.pi/` out of commits via
  `.git/info/exclude`.
- **Sync and claim no longer break on Fireworks with 400 "missing field `content`" (HH-673).** The extension now applies the command cards, guidance and project rule files a `work_sync` / `work_claim` result carries itself and gives the model one summary line per delta (`applied by the extension: written 7, …`), so the payload never passes through the model; `/holycode-hub:sync-commands`, `/holycode-hub:claim` and `/holycode-hub:update` report that summary instead of piping JSON into a script. Unsynced local edits of project rules are still never overwritten. Before each model request the extension also folds the content-less message Pi sends for a tool added mid-session (Kimi K3.1 Pro on Fireworks after a `/reload`) back into the request's tool list, which Fireworks refused.

## [0.2.2]

### Added

- **Background workers (HH-670).** Four new tools — `holycode_worker_start`, `holycode_worker_status`,
  `holycode_worker_resume` and `holycode_worker_stop` — run separate Pi sessions in story worktrees,
  with the Hub tools available, without blocking your session. Workers are tracked in
  `~/.holycode-hub/pi/workers/` (`RUNNING`, `NEEDS_INPUT`, `STALLED`, `DONE`, `FAILED`, `STOPPED`;
  output in `<key>.log`), show a notice when they finish, fail, stall or need an answer, and resume
  their saved session with your answer. At most 3 run at once, never more than the lease's
  concurrent limit; a worker that would reach another Hub than your session is refused.
- **No fixed time limit for helpers (HH-670).** Workers and `holycode_subagent` have no fixed time
  limit any more: one quiet for 30 minutes is reported as stalled and never killed.
  `pi --worker-timeout <minutes>` sets an optional hard limit for workers.
- **Parallel standing orders (HH-671).** `/holycode-hub:execute-work phase|epic <name>` (or several
  story keys) now runs the handed-out stories in parallel through background workers: your session
  claims once, groups the stories per the `parallel-worktrees` guidance and, after one confirmation
  (stories, worker model, workers at once, a rough token estimate), starts one worker per group — at
  most 3, never more than the lease's limit; `--parallel=N` and `--sequential` keep their meaning.
  Workers implement, open a PR and verify; when a verify passed your session runs `complete --scope`,
  queues what the Hub hands out and starts workers for it. Each worker gets its own port range
  (`HUB_WORKER_PORT_BASE`). New tool `holycode_standing_order` (`start`, `status`, `retry`,
  `release`); `--worker-model <provider/model>` runs the workers on another allowed model.

## [0.2.1]

- `/holycode-hub:models use <model> --project` now switches the model for this session as well as
  storing it as the project default; before, only the project default changed and the session kept
  the old model.
- `use` and `test` accept a short model id: `use kimi-k3p1-pro` picks
  `fireworks/accounts/fireworks/models/kimi-k3p1-pro` when it is the only usable model with that
  id. When several match, the answer lists them so you can name one as `provider/model`.
- Tiers show again for Fireworks models: the recommended list names them by their short id
  (`kimi-k3`), which now matches Pi's long id (`accounts/fireworks/models/kimi-k3`). The list's
  Fireworks entries are the current models (Kimi K3, Kimi K3.1 Pro, GLM 5.3, Qwen 3.8 Max,
  DeepSeek V4.1 Flash), all experimental until measured.
- The Hub's recommended list is actually saved now: the session start asks for one `work_models`
  call while the saved list is missing or more than a day old, and the extension saves the answer
  (before, nothing fetched it, so tiers stayed `unknown`).

## [0.2.0]

- `/holycode-hub:models` manages your own model: lists the models you can use with the one in use
  and each one's tier, `add` offers shortcuts (Anthropic, OpenAI, Fireworks, OpenRouter, an EU /
  Swiss OpenAI-compatible endpoint, local Ollama) and every provider in Pi's catalogue and hands the
  key to Pi's own `/login`, `use` switches the model (with `--project`, stores only the model id),
  `test` sends one tiny request and names the problem in plain words, `remove` deletes a stored key.
- While no model is set, every Hub command stops with one line naming `/holycode-hub:models add`.
- The Hub's recommended model list (tiers and notes) is saved on each session, with a copy bundled
  in the package as the fallback.
- Your organisation's allowed model providers are applied: `use` refuses a model from another
  provider and `add` offers only the allowed ones.

## [0.1.0]

- First package: installs with `pi install`, adds the `holycode-hub` MCP server to Pi on first
  load, offers the Hub sign-in on the first session, and `/holycode-hub:login` signs in again.

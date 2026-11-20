# Changelog — Rapid Dev Hub client for Pi

The Pi package has its own version line and never shares a release with the Claude Code plugin.

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

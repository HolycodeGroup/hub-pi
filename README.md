# Rapid Dev Hub — client for Pi

The Rapid Dev Hub client for the [Pi coding agent](https://pi.dev): commands, one extension (the Hub
connection and hooks) and the scripts the commands use. It sits beside the Claude Code plugin
(`packages/client-claude-code`) and never changes it (rule MC-1, enforced by the `client-separation`
CI job). No method ships here: the method stays on the Hub, and the full story text reaches the
client only through `work_claim`.

The package has its own version line (starting at 0.1.0), its own [changelog](CHANGELOG.md) and its
own CI job (`client-pi` in `.github/workflows/ci.yml`).

## Install

1. Install Pi with its own installer (see pi.dev).
2. Install this package:

   ```bash
   pi install git:github.com/HolycodeGroup/hub-pi        # the published package
   pi install ./packages/client-pi                         # or this checkout, while developing
   ```

On its first load the extension adds the `holycode-hub` MCP server to Pi's own
`~/.pi/agent/mcp.json` (`https://rdhub.holycode.com/mcp`, streamable HTTP). You edit no config file.
A `holycode-hub` entry you already have there is never overwritten.

## Sign in to the Hub

On the first session, the extension sees that the Hub still needs a sign-in and asks to sign in now.
Say yes and your browser opens the Hub's sign-in page (`/oauth/authorize`): email, password and, when
you belong to several, the organisation. Pi keeps the Hub credential in its token store in your home
folder (`~/.pi/agent/mcp-auth.json`, readable by you only), never in the repository.

Sign in again with `/holycode-hub:login` after a password reset, an organisation switch or a token
the Hub revoked. It signs out first, so you always get a fresh sign-in.

In print or JSON mode (no dialogs), the session start names `/holycode-hub:login` instead of asking.

## Commands

Every command of the Claude Code plugin works in Pi under the same name — `/holycode-hub:claim`,
`/holycode-hub:verify`, `/holycode-hub:complete` and the rest (32, plus `/holycode-hub:login`). They
are rendered from the shared command definitions (`packages/hub-client-core/src/command-spec.mjs`,
read only) into `commands/`, with the same Hub tools and arguments. The few Pi-only wordings (reload
Pi instead of restarting Claude Code, the Pi sign-in) are listed in one file,
[`src/overrides.mjs`](src/overrides.mjs). After a core change, regenerate the copies:

```bash
node packages/client-pi/tools/sync-from-core.mjs
```

On load the extension copies the scripts the commands run, the `AGENTS.md` Hub block and the package
version to `~/.holycode-hub/pi/`; the framework cards the Hub delivers (`/holycode-hub:sync-commands`)
land in `~/.holycode-hub/pi/commands-cache/` and become commands after `/reload`. Every Hub
`work_sync` and `work_claim` call carries `client_kind: "pi"`.

## Background workers

The extension gives the model four tools that run separate Pi sessions in the background, one per
story worktree, with the extension and the Hub tools enabled (HH-670):

| Tool | Parameters | What it does |
|------|------------|--------------|
| `holycode_worker_start` | `worktree`, `task`, optional `model`, `story_key`, `concurrent_limit`, `timeout_minutes` | Spawns `pi --mode json --approve --session-dir … --session-id …` in the worktree without waiting |
| `holycode_worker_status` | optional `story_key` | State, model, pid, start time, last activity, open question, log file |
| `holycode_worker_resume` | `story_key`, `answer` | Runs the same session (`--session-id`) again with the answer |
| `holycode_worker_stop` | `story_key` | Stops the process; the session stays resumable |

- Registry: `~/.holycode-hub/pi/workers/<key>.json` (states `RUNNING`, `NEEDS_INPUT`, `STALLED`,
  `DONE`, `FAILED`, `STOPPED`), output in `<key>.log`, Pi sessions in `sessions/`. A record left live
  by a closed or crashed coordinator turns `STOPPED` the next time the registry is read.
- The outcome comes from Pi's JSON events, not the exit code (Pi exits 0 after a provider error): the
  last assistant message's `stopReason`, a `holycode_ask` result in worker form (the worker's
  extension sees `HOLYCODE_HUB_WORKER` and tells the model to end its turn on the question), or a Hub
  tool error about the sign-in → `NEEDS_INPUT`.
- Stall watchdog: no JSON event or stderr output for 30 minutes → `STALLED` and a notice, never a
  kill. `pi --worker-timeout <minutes>` (or `timeout_minutes`) adds a hard limit; off by default.
  `holycode_subagent` uses the same watchdog instead of its former 10-minute limit.
- Cap: 3 live workers, lowered by the lease's `concurrent_limit` (passed in, or saved from the last
  `work_claim` answer in `workers/lease.json`).
- Before a start: the coordinator's `.pi/mcp.json` and the model fields of `.pi/settings.json`
  (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, `enabledModels`
  — never a key) are copied into the worktree, and a worker whose `holycode-hub` URL would differ
  from the coordinator's is refused. A worker gets no worker tools of its own.
- Notices reach the coordinator as a Pi notice plus a `holycode-hub-worker` message delivered after
  the current turn. Workers are children of the coordinator's Pi process: closing Pi stops them.

## Parallel standing orders

`/holycode-hub:execute-work phase|epic <name>` (or several story keys) runs the handed-out stories in
parallel through the workers (HH-671). The Pi client appends a Pi paragraph to the Hub's
`execute-work` card when it registers it (`CARD_ADDENDA` in `src/commands.ts`); the Hub's card, and
so Claude Code, is unchanged, and a worker gets the card without it.

| Tool | Actions |
|------|---------|
| `holycode_standing_order` | `start` (`scope`, `groups`, `parallel`, `sequential`, `worker_model`), `status`, `retry` (`story_key`), `release` (`story_key`, `reason`) |

- The coordinator claims once; the extension keeps the claim's `standing_order.handed_out` from the
  `work_claim` result and `start` refuses keys outside it. One confirmation (stories, worker model,
  workers at once, a rough token estimate) is the Start answer for the batch.
- One worker per group, at most 3, never more than the lease's `concurrent_limit`; `--sequential`
  = 1, `--parallel=N` = N. Each worker gets `HUB_WORKER_PORT_BASE` (42000, 42100, 42200 …; 100 ports).
- `--worker-model <provider/model>` must be usable in Pi and pass the organisation's allowed
  providers (`workerModelChoice` in `src/models.ts`).
- The worker's last line is `HOLYCODE-WORKER-RESULT {"stories":[…],"verify":"PASSED","sha":"…","pr":"…"}`.
  The coordinator completes only when that line says PASSED with a full sha that exists in the
  worktree AND the worker's own events show a passed `work_verify` answer for every story of the
  group; then it runs the `complete` card here with `--scope`, queues the stories the Hub hands out
  and starts workers for them. Anything else holds the group for the developer (resume, retry,
  release), with the question or the log tail.
- The order lives in `~/.holycode-hub/pi/standing-order.json`; the watchdog asks the coordinator to
  renew a running worker's lease within the hour before it expires.

## Use staging or a local Hub in one project

A project entry in `.pi/mcp.json` replaces the user-level one for that project only. Pi reads it
only after you trust the project.

1. In the project's root, add the override (staging shown; a local Hub is
   `http://localhost:<port>/mcp`):

   ```bash
   pi mcp add -l holycode-hub --url https://<staging-hub-host>/mcp
   ```

   This writes `.pi/mcp.json`. Decide whether your team commits it; it holds no secret.
2. Start Pi in the project and trust it when asked.
3. Sign in to that Hub: `/holycode-hub:login`. The override has its own sign-in, because Pi keeps
   one credential per server name and URL.
4. Check it: `pi mcp list` shows `holycode-hub` connected with the override's URL.

To go back to the production Hub, remove the override: `pi mcp remove -l holycode-hub`.

## Release (Holycode staff)

The Pi client has its own version line and is published to the public repository
`HolycodeGroup/hub-pi`. A pull request that changes it adds an entry file
`packages/client-pi/changelog.d/<story-key>.md` ([format](changelog.d/README.md)) and **never** raises
`version` in `package.json` or edits the `## [x.y.z]` sections of `CHANGELOG.md` — CI's `changelog`
job fails one that does (HH-667). Then either:

- **With the Hub release (the usual way):** when a shipped file changed since the published version,
  `pnpm promote` first stops and opens a release-prep pull request (`chore/release-prep-pi-v<version>`,
  patch by default, `--pi-minor` / `--pi-major`) that raises the version and moves the entry files into
  a new `## [<version>]` section — one PR together with the Claude Code plugin when that needs a raise
  too. When main already carries a raised, unpublished version, that PR moves the entry files merged since
  into its section instead of raising it again. Merge it and rerun `pnpm promote`: it publishes `packages/client-pi` of the released commit
  after the deploy, the tag and the Claude Code plugin, whenever its version is newer than hub-pi's
  newest tag — with its own confirmation (`--yes-publish` covers it; `--no-publish` skips it). A rerun
  finishes an interrupted Pi publish. See [`docs/PRODUCTION-RUNBOOK.md`](../../docs/PRODUCTION-RUNBOOK.md) §2.
- **Out of band, without a Hub release:** `pnpm release:pi`, which uses the same build and publish
  and still requires the version's `## [x.y.z]` section (merge a release-prep PR first):

1. `pnpm release:pi --dry-run` — builds `dist/hub-pi/` (only what Pi loads, plus README and
   CHANGELOG), runs the outgoing-content scan over it and prints what a publish would push.
2. `pnpm release:pi --yes-publish` — the same, then pushes the tree to hub-pi's `main` and tags it
   `v<version>`. A version hub-pi already has is never pushed again.

Developers then run `/holycode-hub:update` in Pi (`pi update --extensions`, `/reload`, then
`/holycode-hub:sync-commands`).

## Develop

```bash
pnpm --filter client-pi test:coverage   # suite + coverage floors (80%)
pnpm --filter client-pi typecheck
pnpm --filter client-pi lint
pnpm --filter client-pi test:e2e        # installs the package into a real Pi (needs `pi` on PATH)
```

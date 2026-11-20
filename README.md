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

The Pi client is released on its own version line to the public repository
`HolycodeGroup/hub-pi`, apart from the Hub and the Claude Code plugin (`pnpm promote` never touches
it):

1. Raise `version` in `packages/client-pi/package.json` and add its `## [x.y.z]` section to
   `packages/client-pi/CHANGELOG.md`.
2. `pnpm release:pi --dry-run` — builds `dist/hub-pi/` (only what Pi loads, plus README and
   CHANGELOG), runs the outgoing-content scan over it and prints what a publish would push.
3. `pnpm release:pi --yes-publish` — the same, then pushes the tree to hub-pi's `main` and tags it
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

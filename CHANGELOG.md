# Changelog — Rapid Dev Hub client for Pi

The Pi package has its own version line and never shares a release with the Claude Code plugin.

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

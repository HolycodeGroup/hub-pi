# Changelog — Rapid Dev Hub client for Pi

The Pi package has its own version line and never shares a release with the Claude Code plugin.

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

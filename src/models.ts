// HH-603 — /holycode-hub:models: the developer adds their own provider key and picks any model in
// Pi's catalogue (MC-3, MC-7; Confluence "Pi Client — Models and Keys"). Keys stay on the machine:
// a key is typed into Pi's own `/login` (hidden input, kept in ~/.pi/agent/auth.json by Pi), and
// nothing here ever reads, writes, prints or sends one. The Hub never sees a key or model traffic.
//
//   /holycode-hub:models                         the usable models, the one in use, each one's tier
//   /holycode-hub:models add [preset]            a preset (or any provider in Pi's catalogue), then
//                                                Pi's hidden key prompt; local and custom endpoints
//                                                are configured in Pi's models.json without a key
//   /holycode-hub:models use <model> [--project] switches the session; --project also stores it
//                                                as the project default. <model> is provider/model
//                                                or a short id that names one usable model
//   /holycode-hub:models test [model]            one tiny request: OK and the time, or the problem
//   /holycode-hub:models remove <provider>       deletes the stored key (Pi's `auth logout`)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PiApi, PiContext, PiModel } from './pi-types';
import { readRecommended, tierOf, trailingSegment, type RecommendedList } from './recommended-models';

export interface Preset {
  readonly id: string;
  readonly label: string;
  /** Pi's provider id; absent for the custom endpoint, which names its own. */
  readonly provider?: string;
  readonly kind: 'key' | 'local' | 'endpoint';
}

/** Shortcuts for the common choices; every other provider in Pi's catalogue is offered too. */
export const PRESETS: readonly Preset[] = Object.freeze([
  { id: 'anthropic', label: 'Anthropic — Claude models (API key)', provider: 'anthropic', kind: 'key' },
  { id: 'openai', label: 'OpenAI — GPT models (API key)', provider: 'openai', kind: 'key' },
  { id: 'fireworks', label: 'Fireworks — open-weight models: Kimi, GLM, Qwen, MiniMax (API key)', provider: 'fireworks', kind: 'key' },
  { id: 'openrouter', label: 'OpenRouter — many providers behind one key (API key)', provider: 'openrouter', kind: 'key' },
  { id: 'eu-host', label: 'EU / Swiss host — any OpenAI-compatible endpoint you name', kind: 'endpoint' },
  { id: 'local', label: 'Local — Ollama on this machine (no key)', provider: 'ollama', kind: 'local' },
]);

export const NO_MODEL_LINE = 'No model set — run /holycode-hub:models add to add your own model key first.';
export const ENDPOINT_PROVIDER = 'eu-host';
export const ENDPOINT_KEY_ENV = 'EU_HOST_API_KEY';
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export type ModelsAction = 'list' | 'add' | 'use' | 'test' | 'remove';

export function parseModelsArgs(args: string): { action: ModelsAction; rest: string[] } | { error: string } {
  const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (first === undefined) return { action: 'list', rest: [] };
  if (['add', 'use', 'test', 'remove'].includes(first)) return { action: first as ModelsAction, rest };
  return { error: `Unknown /holycode-hub:models action "${first}". Use add, use, test or remove.` };
}

/** How many matches an ambiguous short id names before "…". */
const MATCHES_SHOWN = 5;

/**
 * HH-669 — the usable model a spec names: the exact `provider/id` first, else the one model whose id
 * or trailing id segment (after the last `/`) is the spec. Several matches → an error naming them;
 * none → `model` undefined with no error, so each caller keeps its own "unknown" line.
 */
export function resolveModel(available: readonly PiModel[], spec: string): { model?: PiModel; error?: string } {
  const exact = available.find((m) => `${m.provider}/${m.id}` === spec);
  if (exact !== undefined) return { model: exact };
  const matches = available.filter((m) => m.id === spec || trailingSegment(m.id) === spec);
  if (matches.length <= 1) return { model: matches[0] };
  const names = matches.slice(0, MATCHES_SHOWN).map((m) => `${m.provider}/${m.id}`);
  const more = matches.length > MATCHES_SHOWN ? ', …' : '';
  return { error: `"${spec}" matches ${matches.length} models: ${names.join(', ')}${more}. Name one as provider/model.` };
}

/** One line per usable model: `* ` marks the one in use; the tier from the recommended list. */
export function modelListLines(models: readonly PiModel[], active: PiModel | undefined, list: RecommendedList): string[] {
  if (models.length === 0) return [NO_MODEL_LINE];
  return models.map((m) => {
    const mark = active !== undefined && active.provider === m.provider && active.id === m.id ? '* ' : '  ';
    const tier = tierOf(list, m.provider, m.id);
    return `${mark}${m.provider}/${m.id} — ${tier === 'NOT_LISTED' ? 'not listed' : tier.toLowerCase()}`;
  });
}

function readJson(file: string): Record<string, unknown> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: existsSync(file) ? undefined : 0o600 });
  renameSync(temporary, file);
}

/**
 * Adds a provider to Pi's `models.json` (user level), keeping everything else. An endpoint's key is
 * referenced by an environment variable (`$EU_HOST_API_KEY`) — the key itself is never written.
 */
export function addProviderConfig(agentDir: string, provider: string, config: Record<string, unknown>): void {
  const file = path.join(agentDir, 'models.json');
  const current = readJson(file);
  const providers = (current.providers ?? {}) as Record<string, unknown>;
  writeJson(file, { ...current, providers: { ...providers, [provider]: config } });
}

/** A custom endpoint must be HTTPS (localhost aside); anything else is refused before it is saved. */
export function validEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Stores the project's default model in `.pi/settings.json` — the model id only, never a key. */
export function setProjectModel(cwd: string, provider: string, model: string): void {
  const file = path.join(cwd, '.pi', 'settings.json');
  writeJson(file, { ...readJson(file), defaultProvider: provider, defaultModel: model });
}

export interface TestOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/** The developer's line for a provider's answer to the test call — never a stack trace or a key. */
export function testMessage(name: string, endpoint: string, code: number, stderr: string, ms: number, local: boolean): TestOutcome {
  if (code === 0) return { ok: true, message: `${name} works (${(ms / 1000).toFixed(1)} s).` };
  const provider = name.split('/')[0] ?? name;
  const model = name.split('/').slice(1).join('/');
  if (/\b40[13]\b|unauthori[sz]ed|invalid api key|forbidden/i.test(stderr)) return { ok: false, message: `Key refused by ${provider}. Check the key and add it again.` };
  if (/\b402\b|quota|credit|billing|insufficient/i.test(stderr)) return { ok: false, message: `${provider} says the account has no credit or quota left.` };
  if (/\b404\b|model.*not.*found|unknown model|does not exist/i.test(stderr)) return { ok: false, message: `${provider} does not offer ${model} for this key.` };
  if (/\b429\b|rate.?limit/i.test(stderr)) return { ok: false, message: `${provider} is rate-limiting this key. Try again shortly.` };
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|timed? ?out|network/i.test(stderr) || code === 124) {
    return { ok: false, message: local ? `Cannot reach ${endpoint}. Is Ollama/vLLM running?` : `Cannot reach ${endpoint}.` };
  }
  return { ok: false, message: `${name} did not answer the test call. Run /holycode-hub:models test again, or pick another model.` };
}

/** Runs one tiny request on a model through a separate Pi run (no session, extensions or MCP). */
export async function testModel(pi: PiApi, cwd: string, name: string, endpoint: string, local: boolean, now: () => number = Date.now): Promise<TestOutcome> {
  const started = now();
  try {
    const result = await pi.exec('pi', ['-p', '--no-session', '--no-extensions', '--no-mcp', '--model', name, 'Reply with the single word OK.'], { cwd, timeout: 60_000 });
    return testMessage(name, endpoint, result.killed === true ? 124 : result.code, `${result.stderr}\n${result.code === 0 ? '' : result.stdout}`, now() - started, local);
  } catch (error) {
    return testMessage(name, endpoint, 1, error instanceof Error ? error.message : String(error), now() - started, local);
  }
}

/** HH-608 — the refusal for a provider outside the organisation's list. */
export const PROVIDER_NOT_ALLOWED = 'Provider not allowed by your organisation';

/** HH-608 — whether the organisation's list (null = any, from work_models) allows `provider`. */
export function providerAllowed(list: RecommendedList, provider: string): boolean {
  return list.allowedProviders === null || list.allowedProviders.includes(provider);
}

function notAllowedLine(list: RecommendedList, provider: string): string {
  return `${PROVIDER_NOT_ALLOWED}: ${provider}. Allowed: ${(list.allowedProviders ?? []).join(', ')}.`;
}

export interface ModelsDeps {
  readonly agentDir: string;
  readonly runtimeDir: string;
  readonly packageRoot: string;
}

/** The whole /holycode-hub:models command. Every outcome is one notice; nothing throws. */
export async function runModelsCommand(pi: PiApi, args: string, ctx: PiContext, deps: ModelsDeps): Promise<void> {
  const parsed = parseModelsArgs(args);
  if ('error' in parsed) return ctx.ui.notify(parsed.error, 'error');
  const available = ctx.modelRegistry?.getAvailable() ?? [];
  const list = readRecommended(deps.runtimeDir, deps.packageRoot);
  const say = (message: string, level: 'info' | 'warning' | 'error' = 'info') => ctx.ui.notify(message, level);

  switch (parsed.action) {
    case 'list':
      return say(modelListLines(available, ctx.model, list).join('\n'));
    case 'use': {
      const spec = parsed.rest.find((word) => word !== '--project') ?? '';
      const { model, error } = resolveModel(available, spec);
      if (error !== undefined) return say(error, 'error');
      if (model === undefined) return say(`Unknown model "${spec}". Run /holycode-hub:models to see the usable ones.`, 'error');
      if (!providerAllowed(list, model.provider)) return say(notAllowedLine(list, model.provider), 'error');
      // --project switches the session too: the project default alone would only apply next session.
      const project = parsed.rest.includes('--project');
      const name = `${model.provider}/${model.id}`;
      const switched = await pi.setModel(model).catch(() => false);
      if (!switched) return say(`Pi did not switch to ${name}. Run /holycode-hub:models test ${name} to see why.`, 'error');
      if (project) setProjectModel(ctx.cwd, model.provider, model.id);
      return say(project ? `Now using ${name} for this session and as this project's model (.pi/settings.json holds its id only).` : `Now using ${name} for this session.`);
    }
    case 'test': {
      const spec = parsed.rest[0];
      const { model, error } = spec === undefined ? { model: ctx.model } : resolveModel(available, spec);
      if (error !== undefined) return say(error, 'error');
      if (model === undefined) return say(spec === undefined ? NO_MODEL_LINE : `Unknown model "${spec}".`, 'error');
      const endpoint = model.baseUrl ?? model.provider;
      const outcome = await testModel(pi, ctx.cwd, `${model.provider}/${model.id}`, endpoint, model.provider === 'ollama');
      return say(outcome.message, outcome.ok ? 'info' : 'error');
    }
    case 'remove': {
      const provider = parsed.rest[0];
      if (provider === undefined) return say('Name the provider whose key to delete: /holycode-hub:models remove <provider>.', 'error');
      const result = await pi.exec('pi', ['auth', 'logout', provider], { cwd: ctx.cwd, timeout: 30_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
      return say(result.code === 0 ? `The stored key for ${provider} is deleted.` : `No stored key for ${provider} could be deleted.`, result.code === 0 ? 'info' : 'warning');
    }
    case 'add':
      return addModel(ctx, parsed.rest[0], deps, list);
  }
}

async function addModel(ctx: PiContext, presetId: string | undefined, deps: ModelsDeps, list: RecommendedList): Promise<void> {
  const say = (message: string, level: 'info' | 'warning' | 'error' = 'info') => ctx.ui.notify(message, level);
  // HH-608 — only the providers the organisation allows are offered.
  const presets = PRESETS.filter((p) => providerAllowed(list, p.provider ?? ENDPOINT_PROVIDER));
  const catalogue = [...new Set((ctx.modelRegistry?.getAll?.() ?? []).map((m) => m.provider))]
    .filter((p) => !PRESETS.some((s) => s.provider === p) && providerAllowed(list, p))
    .sort();
  const named = PRESETS.find((p) => p.id === presetId);
  const refused = named === undefined ? presetId : (named.provider ?? ENDPOINT_PROVIDER);
  if (refused !== undefined && !providerAllowed(list, refused)) return say(notAllowedLine(list, refused), 'error');
  let preset = presets.find((p) => p.id === presetId);
  let provider = preset?.provider ?? (presetId !== undefined && catalogue.includes(presetId) ? presetId : undefined);
  if (preset === undefined && provider === undefined) {
    if (!ctx.hasUI) return say(`Name a preset: /holycode-hub:models add <${presets.map((p) => p.id).join('|')}> or another provider: ${catalogue.join(', ')}`, 'warning');
    const choice = await ctx.ui.select('Add a model — choose a provider', [...presets.map((p) => p.label), ...catalogue]);
    if (choice === undefined) return;
    preset = presets.find((p) => p.label === choice);
    provider = preset?.provider ?? choice;
  }
  if (preset?.kind === 'local') {
    const model = (await ctx.ui.input('Ollama model to use', 'qwen3-coder'))?.trim();
    if (!model) return;
    addProviderConfig(deps.agentDir, 'ollama', { baseUrl: OLLAMA_BASE_URL, api: 'openai-completions', models: [{ id: model }] });
    return say(`ollama/${model} added (no key needed). Run /reload, then /holycode-hub:models use ollama/${model} and /holycode-hub:models test.`);
  }
  if (preset?.kind === 'endpoint') {
    const baseUrl = (await ctx.ui.input('Endpoint base URL (HTTPS, OpenAI-compatible)', 'https://llm.example.ch/v1'))?.trim();
    if (!baseUrl) return;
    if (!validEndpoint(baseUrl)) return say('The endpoint must be an HTTPS address.', 'error');
    const model = (await ctx.ui.input('Model id at that endpoint', 'qwen3-coder'))?.trim();
    if (!model) return;
    addProviderConfig(deps.agentDir, ENDPOINT_PROVIDER, { baseUrl, api: 'openai-completions', apiKey: `$${ENDPOINT_KEY_ENV}`, models: [{ id: model }] });
    return say(`${ENDPOINT_PROVIDER}/${model} added. Put the endpoint's key in the ${ENDPOINT_KEY_ENV} environment variable (it is never written to a file), run /reload, then /holycode-hub:models test ${ENDPOINT_PROVIDER}/${model}.`);
  }
  return say(`Run /login ${provider} and choose "API key": Pi asks for the key with hidden input and keeps it in its own credential store (~/.pi/agent/auth.json). Then /holycode-hub:models to pick the model and /holycode-hub:models test to check it.`);
}

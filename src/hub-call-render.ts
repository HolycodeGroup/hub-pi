// HH-678 — Pi draws each Hub tool call as one collapsed line instead of a wall of escaped JSON.
//
// A Hub command runs through Pi's `codemode` tool: the row shows the script, the nested
// `mcp__holycode_hub__*` calls and a preview of what the script printed. While the row is collapsed
// and its script calls the Hub, this renderer draws one line per Hub call instead — the status
// (✓ / ✗ / … / ⊘), the tool name without its server prefix and the duration, and for a failed call
// the Hub's error code and message: `✓ project_status 160ms`, `✗ work_claim 90ms FORBIDDEN_RESOURCE: …`.
// Pi's own expand toggle (`app.tools.expand`, Ctrl+O by default) shows Pi's full row — the script and
// its output — and collapses it again. A Hub tool called directly (exposure "direct") gets the same
// line. Every other tool, and a codemode script that never names the Hub, is drawn exactly as before.
//
// The components are plain objects with `render(width)` (Pi's `Component` contract), so the package
// keeps no dependency on Pi's TUI library; each line is cut to the width it is drawn at.
import { piToolName } from './hub-calls';
import type { PiComponent, PiTheme, PiToolRenderContext, PiToolRenderers, PiToolRenderResult } from './pi-types';

/** The name Pi gives its codemode tool. */
export const CODEMODE_TOOL = 'codemode';

/** What every Hub tool's name starts with in Pi (`mcp__holycode_hub__`). */
export const HUB_TOOL_PREFIX = piToolName('');

const HUB_NAME_PATTERN = new RegExp(`${HUB_TOOL_PREFIX}([A-Za-z0-9_]+)`, 'g');

/** A piece of a line and the theme colour it is drawn in. */
export interface Segment {
  readonly text: string;
  readonly color: string;
}

type Line = readonly Segment[];

/** One nested call of a codemode script, as Pi records it in the row's `details.calls`. */
export interface NestedCall {
  readonly name: string;
  readonly status: 'running' | 'ok' | 'error' | 'cancelled';
  readonly durationMs?: number;
  readonly error?: string;
}

/** Code point ranges a terminal draws two cells wide (East Asian wide / full-width, emoji). */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

/** The cells one character takes: 0 for combining marks and zero-width characters, 2 for wide ones. */
export function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}

/** One line of text: control characters (tabs, newlines, escapes) become spaces. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** A line styled and cut to `width` terminal cells, ending in an ellipsis when it was cut. */
export function fitLine(line: Line, width: number, theme: PiTheme): string {
  const max = Math.max(width, 1);
  const chars = line.map((segment) => Array.from(oneLine(segment.text)));
  const total = chars.flat().reduce((sum, char) => sum + cellWidth(char), 0);
  let left = total <= max ? total : max - 1;
  let out = '';
  for (const [index, segment] of line.entries()) {
    let kept = '';
    for (const char of chars[index] ?? []) {
      if (cellWidth(char) > left) break;
      kept += char;
      left -= cellWidth(char);
    }
    if (kept !== '') out += theme.fg(segment.color, kept);
    if (kept.length < (chars[index] ?? []).join('').length) break;
  }
  return total <= max ? out : `${out}${theme.fg('muted', '…')}`;
}

/** A component that draws the given lines, each cut to the width (no line, no height). */
export class LinesComponent implements PiComponent {
  constructor(
    readonly lines: readonly Line[],
    private readonly theme: PiTheme,
  ) {}

  render(width: number): string[] {
    return this.lines.map((line) => fitLine(line, width, this.theme));
  }

  invalidate(): void {
    // Nothing is cached: every render draws from the lines.
  }
}

/** The Hub tools a codemode script names, without the server prefix, in order, each once. */
export function hubToolsInScript(code: unknown): string[] {
  if (typeof code !== 'string') return [];
  return [...new Set([...code.matchAll(HUB_NAME_PATTERN)].map((m) => m[1] as string))];
}

/** `160ms` below a second, `1.4s` above; empty when unknown. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function errorFields(value: unknown): { code?: string; message?: string } {
  if (value === null || typeof value !== 'object') return {};
  const record = value as { code?: unknown; message?: unknown; data?: { code?: unknown }; error?: unknown };
  if (record.error !== null && typeof record.error === 'object') return errorFields(record.error);
  const code = typeof record.data?.code === 'string' ? record.data.code : typeof record.code === 'string' ? record.code : undefined;
  return { ...(code === undefined ? {} : { code }), ...(typeof record.message === 'string' ? { message: record.message } : {}) };
}

function parsedJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch {
    return undefined;
  }
}

function quotedField(text: string, field: 'code' | 'message'): string | undefined {
  const pattern = field === 'code' ? /"code"\s*:\s*"([A-Z][A-Z0-9_]*)"/g : /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const found = [...text.matchAll(pattern)].at(-1)?.[1];
  if (found === undefined || field === 'code') return found;
  try {
    return JSON.parse(`"${found}"`) as string;
  } catch {
    return found;
  }
}

/**
 * The Hub's error code and message from a failed call's text: the Hub's JSON-RPC error
 * (`{ error: { message, data: { code } } }`, often behind Pi's "MCP HTTP request failed with status
 * 403:"), a tool error (`{ code, message }`), or — when Pi cut the JSON short — the quoted fields.
 * Text with neither keeps its first line.
 */
export function hubErrorSummary(text: string | undefined): string {
  if (text === undefined || text.trim() === '') return '';
  const parsed = errorFields(parsedJson(text));
  const code = parsed.code ?? quotedField(text, 'code');
  const message = parsed.message ?? quotedField(text, 'message');
  const firstLine = (value: string): string => value.trim().split('\n')[0] as string;
  if (code !== undefined && message !== undefined) return `${code}: ${firstLine(message)}`;
  if (code !== undefined || message !== undefined) return firstLine((code ?? message) as string);
  return firstLine(text);
}

const STATUS: Readonly<Record<NestedCall['status'], Segment>> = {
  running: { text: '…', color: 'warning' },
  ok: { text: '✓', color: 'success' },
  error: { text: '✗', color: 'error' },
  cancelled: { text: '⊘', color: 'muted' },
};

/** One Hub call's line: status, tool name, duration and, when it failed, the Hub's error. */
export function hubCallLine(call: NestedCall): Segment[] {
  const name = call.name.startsWith(HUB_TOOL_PREFIX) ? call.name.slice(HUB_TOOL_PREFIX.length) : call.name;
  const line: Segment[] = [STATUS[call.status], { text: ` ${name}`, color: 'toolTitle' }];
  const duration = formatDuration(call.durationMs);
  if (duration !== '') line.push({ text: ` ${duration}`, color: 'dim' });
  const error = call.status === 'error' ? hubErrorSummary(call.error) : '';
  if (error !== '') line.push({ text: ` ${error}`, color: 'error' });
  return line;
}

function nestedCalls(details: unknown): NestedCall[] {
  const calls = (details as { calls?: unknown } | undefined)?.calls;
  return Array.isArray(calls) ? (calls as NestedCall[]).filter((call) => typeof call?.name === 'string') : [];
}

function textOf(result: PiToolRenderResult): string {
  return result.content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

/** The first line after codemode's `Script error:` marker. */
function scriptError(text: string): string {
  const after = text.split('Script error:')[1];
  return after?.trim().split('\n')[0]?.trim() ?? '';
}

/**
 * The collapsed lines of a finished codemode script that called the Hub: one per Hub call, a count
 * of its other calls, and — when the script failed although no Hub call did — why it failed.
 */
export function collapsedScriptLines(result: PiToolRenderResult, context: Pick<PiToolRenderContext, 'isError' | 'durationMs'>): Segment[][] {
  const calls = nestedCalls(result.details);
  const hub = calls.filter((call) => call.name.startsWith(HUB_TOOL_PREFIX));
  const lines = hub.map(hubCallLine);
  const others = calls.length - hub.length;
  if (others > 0 && lines.length > 0) (lines.at(-1) as Segment[]).push({ text: ` (+${others} other call${others === 1 ? '' : 's'})`, color: 'muted' });
  if (context.isError && !hub.some((call) => call.status === 'error')) {
    const why = scriptError(textOf(result));
    lines.push([STATUS.error, { text: ' codemode script failed', color: 'toolTitle' }, ...(why === '' ? [] : [{ text: ` ${why}`, color: 'error' }])]);
  }
  if (lines.length === 0) lines.push(hubCallLine({ name: CODEMODE_TOOL, status: 'ok', ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }) }));
  return lines;
}

/** The context a base renderer gets: never one of this module's components as its last one. */
function forBase(context: PiToolRenderContext): PiToolRenderContext {
  return context.lastComponent instanceof LinesComponent ? { ...context, lastComponent: undefined } : context;
}

function runningLine(names: readonly string[]): Segment[] {
  return [STATUS.running, { text: ` ${names.join(', ')}`, color: 'toolTitle' }];
}

/** The plain fallback of a slot Pi would otherwise fill: the tool name, or the result text. */
function fallbackLines(text: string): Segment[][] {
  return text.split('\n').map((line) => [{ text: line, color: 'toolOutput' }]);
}

/**
 * Lets Pi's own renderer see the final result although its output is not shown: a row expanded while
 * the script ran started Pi's running timer, which only Pi's renderer stops on the final result.
 */
function settleBase(base: PiToolRenderers, result: PiToolRenderResult, options: { expanded: boolean; isPartial: boolean }, theme: PiTheme, context: PiToolRenderContext): void {
  try {
    base.renderResult?.(result, options, theme, forBase(context));
  } catch {
    // Pi's renderer failing never hides the collapsed line.
  }
}

/** Codemode rows: collapsed to the Hub call lines while the script names the Hub and the row is collapsed. */
export function collapseCodemode(base: PiToolRenderers): PiToolRenderers {
  return {
    ...base,
    renderCall(args, theme, context) {
      const names = hubToolsInScript((args as { code?: unknown } | undefined)?.code);
      if (context.expanded || names.length === 0) return base.renderCall?.(args, theme, forBase(context)) ?? new LinesComponent(fallbackLines(CODEMODE_TOOL), theme);
      return new LinesComponent(context.isPartial ? [runningLine(names)] : [], theme);
    },
    renderResult(result, options, theme, context) {
      const collapse = !options.expanded && hubToolsInScript((context.args as { code?: unknown } | undefined)?.code).length > 0;
      if (!collapse) return base.renderResult?.(result, options, theme, forBase(context)) ?? new LinesComponent(fallbackLines(textOf(result)), theme);
      if (options.isPartial) return new LinesComponent([], theme);
      settleBase(base, result, options, theme, context);
      return new LinesComponent(collapsedScriptLines(result, context), theme);
    },
  };
}

/** A Hub tool called directly: the same one line while collapsed, Pi's own row when expanded. */
export function collapseHubTool(toolName: string, base: PiToolRenderers | undefined): PiToolRenderers {
  const name = toolName.slice(HUB_TOOL_PREFIX.length);
  return {
    ...base,
    renderCall(args, theme, context) {
      if (context.expanded) return base?.renderCall?.(args, theme, forBase(context)) ?? new LinesComponent(fallbackLines(toolName), theme);
      return new LinesComponent(context.isPartial ? [runningLine([name])] : [], theme);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded) return base?.renderResult?.(result, options, theme, forBase(context)) ?? new LinesComponent(fallbackLines(textOf(result)), theme);
      if (options.isPartial) return new LinesComponent([], theme);
      const call: NestedCall = { name: toolName, status: context.isError ? 'error' : 'ok', ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }), ...(context.isError ? { error: textOf(result) } : {}) };
      return new LinesComponent([hubCallLine(call)], theme);
    },
  };
}

/** The resolver the extension registers: Hub calls collapsed, every other tool exactly as Pi draws it. */
export function hubCallRenderer(toolName: string, next: () => PiToolRenderers | undefined): PiToolRenderers | undefined {
  if (toolName === CODEMODE_TOOL) {
    const base = next();
    return base === undefined ? undefined : collapseCodemode(base);
  }
  if (toolName.startsWith(HUB_TOOL_PREFIX)) return collapseHubTool(toolName, next());
  return next();
}

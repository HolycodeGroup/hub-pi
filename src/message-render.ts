// HH-690 — the chat draws the extension's long custom messages collapsed, like HH-678's Hub calls.
//
// A `/holycode-hub:<name>` command's card shows as the one line the developer typed and the
// session-start banner as at most two lines (the linked project and Hub, and a warning when there is
// one), each with the key that expands it. Pi's expand toggle (`app.tools.expand`, Ctrl+O by default)
// reaches custom message renderers as `options.expanded`: expanded, the full text the model received
// is drawn, wrapped to the width. The model-facing content is never changed here — a renderer only
// decides what the chat draws.
import { cellWidth, fitLine, type Segment } from './hub-call-render';
import type { PiComponent, PiMessageRenderer, PiMessageRenderOptions, PiRenderedMessage, PiTheme } from './pi-types';

/** Pi's keybinding id for expanding and collapsing tool output and custom messages. */
export const EXPAND_KEYBINDING = 'app.tools.expand';

/** The full text of a custom message, whatever form its content takes. */
export function messageText(message: Pick<PiRenderedMessage, 'content'>): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

/** The keys the expand toggle is bound to (`ctrl+o`), or empty when it has none or Pi cannot say. */
function expandKeys(options: PiMessageRenderOptions): string {
  try {
    return options.keyText(EXPAND_KEYBINDING).trim();
  } catch {
    return '';
  }
}

/** The hint after a collapsed message's first line: ` (ctrl+o to expand)`, nothing without a key. */
export function expandHint(options: PiMessageRenderOptions, action: 'expand' | 'collapse'): Segment[] {
  const keys = expandKeys(options);
  return keys === '' ? [] : [{ text: ` (${keys} to ${action})`, color: 'muted' }];
}

/** One plain line cut into pieces of at most `width` terminal cells (an empty line stays one line). */
export function wrapLine(line: string, width: number): string[] {
  const max = Math.max(width, 1);
  const pieces: string[] = [];
  let current = '';
  let used = 0;
  for (const char of Array.from(line.replace(/\t/g, '  '))) {
    const cells = cellWidth(char);
    if (used + cells > max && current !== '') {
      pieces.push(current);
      current = '';
      used = 0;
    }
    current += char;
    used += cells;
  }
  pieces.push(current);
  return pieces;
}

/** The terminal cells a line takes. */
function lineCells(line: readonly Segment[]): number {
  return line.reduce((sum, segment) => sum + Array.from(segment.text).reduce((cells, char) => cells + cellWidth(char), 0), 0);
}

/**
 * A line followed by its hint, within `width`: the hint's room is kept first and the text is cut to the
 * rest with an ellipsis, so the hint stays visible whenever the terminal has room for it at all.
 */
export function fitWithHint(line: readonly Segment[], hint: readonly Segment[], width: number, theme: PiTheme): string {
  const hintCells = lineCells(hint);
  if (hint.length === 0 || lineCells(line) + hintCells <= width || width <= hintCells + 1) return fitLine([...line, ...hint], width, theme);
  return `${fitLine(line, width - hintCells, theme)}${fitLine(hint, hintCells, theme)}`;
}

/**
 * A message drawn collapsed or expanded: `header` lines always (the first one ends in `hint`), then
 * — expanded — every line of `body` wrapped to the width. A left pad of `outputPad` cells, like Pi's.
 */
export class CollapsibleComponent implements PiComponent {
  constructor(
    private readonly header: readonly (readonly Segment[])[],
    private readonly hint: readonly Segment[],
    private readonly body: string | undefined,
    private readonly theme: PiTheme,
    private readonly pad: number,
  ) {}

  render(width: number): string[] {
    const pad = Math.max(0, Math.min(this.pad, width - 1));
    const inner = Math.max(width - pad, 1);
    const indent = ' '.repeat(pad);
    const header = this.header.map((line, index) => (index === 0 ? fitWithHint(line, this.hint, inner, this.theme) : fitLine(line, inner, this.theme)));
    const body = this.body === undefined ? [] : this.body.split('\n').flatMap((line) => wrapLine(line, inner)).map((line) => fitLine([{ text: line, color: 'customMessageText' }], inner, this.theme));
    return [...header, ...body].map((line) => `${indent}${line}`);
  }

  invalidate(): void {
    // Nothing is cached: every render draws from the text.
  }
}

/** The first line of a text that is not blank. */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

function stringField(details: unknown, field: string): string | undefined {
  const value = (details as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A command message: the command as typed, one line; expanded, the full card below it. */
export const commandMessageRenderer: PiMessageRenderer = (message, options, theme) => {
  const command = stringField(message.details, 'command') ?? firstLine(messageText(message));
  const hint = expandHint(options, options.expanded ? 'collapse' : 'expand');
  return new CollapsibleComponent([[{ text: command, color: 'accent' }]], hint, options.expanded ? messageText(message) : undefined, theme, options.outputPad);
};

/** The summary lines of a banner message: `details.summary`, else its first line. */
export function bannerSummaryOf(message: PiRenderedMessage): string[] {
  const summary = (message.details as { summary?: unknown } | null | undefined)?.summary;
  const lines = Array.isArray(summary) ? summary.filter((line): line is string => typeof line === 'string' && line.trim() !== '').slice(0, 2) : [];
  return lines.length > 0 ? lines : [firstLine(messageText(message))];
}

function bannerColor(line: string): string {
  return /warning|WARNING|no model set/.test(line) ? 'warning' : 'dim';
}

/** The session-start banner: at most two lines; expanded, every line the model received. */
export const bannerMessageRenderer: PiMessageRenderer = (message, options, theme) => {
  if (options.expanded) {
    return new CollapsibleComponent([[{ text: 'holycode-hub session', color: 'accent' }]], expandHint(options, 'collapse'), messageText(message), theme, options.outputPad);
  }
  const lines = bannerSummaryOf(message).map((line): Segment[] => [{ text: line, color: bannerColor(line) }]);
  return new CollapsibleComponent(lines, expandHint(options, 'expand'), undefined, theme, options.outputPad);
};

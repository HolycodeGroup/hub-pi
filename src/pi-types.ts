// The slice of Pi's extension API this package uses (HH-596, HH-597). Pi supplies the real
// implementation at runtime (`@earendil-works/pi-coding-agent`); declaring only what we call keeps
// the package free of a host dependency and lets the tests drive the extension with a small fake.

/** Pi's user-facing dialogs and notices (`ctx.ui`). */
export interface PiUi {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** A model in Pi's catalogue (the fields this package reads). */
export interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly baseUrl?: string;
}

/** Pi's model catalogue (`ctx.modelRegistry`): every model, and those with usable credentials. */
export interface PiModelRegistry {
  getAvailable(): PiModel[];
  getAll?(): PiModel[];
}

/** What Pi passes to an event handler or a command (`ExtensionContext`). */
export interface PiContext {
  readonly ui: PiUi;
  /** False in print / JSON mode, where no dialog can be shown. */
  readonly hasUI: boolean;
  readonly cwd: string;
  /** True when no agent turn is running. */
  isIdle(): boolean;
  /** The active model, when one is set. */
  readonly model?: PiModel;
  readonly modelRegistry?: PiModelRegistry;
  /** Whether Pi trusts this project's local files (HH-670); absent in older Pi versions. */
  isProjectTrusted?(): boolean;
}

/** The result of `pi.exec` — a command run without a shell. */
export interface PiExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed?: boolean;
}

export interface PiCommand {
  readonly description: string;
  handler(args: string, ctx: PiContext): Promise<void>;
}

/** The `tool_call` event: `input` is mutable and patches the call before it runs. */
export interface PiToolCallEvent {
  readonly toolName: string;
  readonly toolCallId?: string;
  input: Record<string, unknown>;
}

/**
 * The `tool_result` event of a finished tool call. A handler may return a patch (`{ content }`) that
 * replaces the result before the model sees it. For an MCP tool, `content` is the model-facing text
 * (Pi cuts it in the middle beyond 20 KB), `structuredContent` the raw MCP result and
 * `details.fullOutputPath` the file holding the full text when it was cut.
 */
export interface PiToolResultEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content?: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly details?: unknown;
  readonly isError?: boolean;
}

/**
 * A custom message that joins the conversation (`pi.sendMessage`). Pi hands `content` to the model as
 * a user message; `display` decides whether the chat shows it; `details` reaches only a message
 * renderer, never the model.
 */
export interface PiCustomMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
}

/** How `pi.sendMessage` delivers: `triggerTurn` starts a turn in an idle session (steer / followUp only). */
export interface PiSendMessageOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: 'steer' | 'followUp' | 'nextTurn';
}

/** The model-facing result of a tool. */
export interface PiToolResult {
  readonly content: { type: 'text'; text: string }[];
  readonly details: unknown;
  readonly isError?: boolean;
}

/** A tool the extension registers for the model (`pi.registerTool`). */
export interface PiTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<PiToolResult>;
}

/** A TUI component (`@earendil-works/pi-tui`): the lines it draws at a width. */
export interface PiComponent {
  render(width: number): readonly string[];
  invalidate(): void;
}

/** The colours a renderer styles text with (Pi's `Theme`, the slice this package calls). */
export interface PiTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** What Pi passes a tool renderer about the row it draws (`ToolRenderContext`, the fields read here). */
export interface PiToolRenderContext {
  readonly args: unknown;
  readonly expanded: boolean;
  readonly isPartial: boolean;
  readonly isError: boolean;
  /** How long the call took, from the final result; undefined while it runs. */
  readonly durationMs: number | undefined;
  readonly lastComponent: PiComponent | undefined;
  readonly [key: string]: unknown;
}

/** The result a tool renderer draws: the model-facing content and the tool's details. */
export interface PiToolRenderResult {
  readonly content: readonly { type: string; text?: string }[];
  readonly details?: unknown;
}

/** How calls to one tool are drawn (`ToolRenderers`). */
export interface PiToolRenderers {
  readonly renderShell?: 'default' | 'self';
  renderCall?(args: unknown, theme: PiTheme, context: PiToolRenderContext): PiComponent;
  renderResult?(result: PiToolRenderResult, options: { expanded: boolean; isPartial: boolean }, theme: PiTheme, context: PiToolRenderContext): PiComponent;
}

/** A custom message as a message renderer gets it (Pi's `CustomMessage`, the fields read here). */
export interface PiRenderedMessage {
  readonly customType: string;
  readonly content: string | readonly { type: string; text?: string }[];
  readonly display: boolean;
  readonly details?: unknown;
}

/**
 * What Pi passes a message renderer (`MessageRenderOptions`, HH-690): `expanded` follows Pi's expand
 * toggle (`app.tools.expand`, Ctrl+O by default); `keyText` names the keys a keybinding id is bound to.
 */
export interface PiMessageRenderOptions {
  readonly expanded: boolean;
  readonly outputPad: number;
  keyText(keybinding: string): string;
  keyHint(keybinding: string, description: string): string;
}

/** Draws custom messages of one type (`MessageRenderer`); undefined falls back to Pi's own box. */
export type PiMessageRenderer = (message: PiRenderedMessage, options: PiMessageRenderOptions, theme: PiTheme) => PiComponent | undefined;

/** Chooses how calls to a tool are drawn; `next()` is what the other resolvers and the tool would use. */
export type PiToolRendererResolver = (toolName: string, next: () => PiToolRenderers | undefined) => PiToolRenderers | undefined;

/** `ExtensionAPI` — what an extension's default export receives. */
export interface PiApi {
  on(event: string, handler: (event: unknown, ctx: PiContext) => unknown): void;
  registerCommand(name: string, command: PiCommand): void;
  registerTool(tool: PiTool): void;
  setModel(model: PiModel): Promise<boolean>;
  exec(command: string, args: readonly string[], options?: { timeout?: number; cwd?: string }): Promise<PiExecResult>;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
  sendMessage(message: PiCustomMessage, options?: PiSendMessageOptions): void;
  /** Draws the custom messages of one `customType` (HH-690); absent in older Pi versions. */
  registerMessageRenderer?(customType: string, renderer: PiMessageRenderer): void;
  /** A command-line flag the extension adds (`pi --<name> <value>`), HH-670. */
  registerFlag?(name: string, options: { description: string; type: 'boolean' | 'string'; default?: boolean | string }): void;
  getFlag?(name: string): boolean | string | undefined;
  /** Draws calls to any tool, the ones other extensions register included (HH-678); absent in older Pi versions. */
  registerToolRenderer?(resolver: PiToolRendererResolver): void;
}

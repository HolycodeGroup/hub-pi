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

/** The `tool_result` event of a finished tool call. */
export interface PiToolResultEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content?: readonly unknown[];
  readonly isError?: boolean;
}

/** A custom message that joins the conversation (`pi.sendMessage`). */
export interface PiCustomMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
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

/** `ExtensionAPI` — what an extension's default export receives. */
export interface PiApi {
  on(event: string, handler: (event: unknown, ctx: PiContext) => unknown): void;
  registerCommand(name: string, command: PiCommand): void;
  registerTool(tool: PiTool): void;
  setModel(model: PiModel): Promise<boolean>;
  exec(command: string, args: readonly string[], options?: { timeout?: number; cwd?: string }): Promise<PiExecResult>;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
  sendMessage(message: PiCustomMessage, options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void;
}

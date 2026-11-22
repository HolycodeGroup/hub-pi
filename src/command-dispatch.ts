// HH-690 — how a `/holycode-hub:<name>` command reaches the model. The card body, with the arguments
// filled in, goes as a custom message (`pi.sendMessage`): Pi hands its content to the model as a user
// message — exactly the text `sendUserMessage` gave it before — while the chat draws it with
// `commandMessageRenderer` as the one line the developer typed (`details.command`, which never
// reaches the model), expandable to the full card with Pi's expand toggle.
import { expandArguments, type PiCommandFile } from './commands';
import { recordEvent } from './effort';
import type { PiApi, PiContext } from './pi-types';
import { COMMAND_PREFIX } from './render.mjs';
import { beat } from './tool-switch';

/** The custom message type a command's card joins the conversation with. */
export const COMMAND_MESSAGE_TYPE = 'holycode-hub-command';

/** What a command message carries for the chat only. */
export interface CommandDetails {
  /** The command as the developer typed it: `/holycode-hub:status summary`. */
  readonly command: string;
}

/** The command line as typed: the prefixed name and the arguments, when there are any. */
export function typedCommand(id: string, args: string): string {
  const typed = args.trim();
  return typed === '' ? `/${COMMAND_PREFIX}${id}` : `/${COMMAND_PREFIX}${id} ${typed}`;
}

/**
 * Sends a command's card to the model: a turn starts at once in an idle session; a busy one (or
 * `afterTurn`) runs it as a follow-up once the current turn ends. `cwd` is where the prompt is
 * recorded for effort: the context's folder by default.
 */
export function sendCommand(pi: PiApi, ctx: PiContext | undefined, command: PiCommandFile, args: string, afterTurn = false, cwd: string = ctx?.cwd ?? process.cwd()): void {
  // A custom message skips Pi's `input` event, which recorded the prompt for the user message before
  // (in the session's folder, which the standing-order runner names even before a session start).
  beat(cwd);
  recordEvent(cwd, { hook_event_name: 'UserPromptSubmit', prompt: '' });
  const details: CommandDetails = { command: typedCommand(command.id, args) };
  const message = { customType: COMMAND_MESSAGE_TYPE, content: expandArguments(command.body, args), display: true, details };
  if (!afterTurn && (ctx?.isIdle() ?? true)) pi.sendMessage(message, { triggerTurn: true });
  else pi.sendMessage(message, { triggerTurn: true, deliverAs: 'followUp' });
}

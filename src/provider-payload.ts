// HH-673 — a request Fireworks refuses: "missing field `content`".
//
// Pi 1.6.0's catalog marks some models (Kimi K3.1 Pro on Fireworks among them) as accepting tools
// added mid-conversation (`supportsMidConvoSystemMessages` + `supportsMidConvoToolAdditions`). For
// those, Pi's OpenAI-compatible serializer sends each tool set that grew during the session (a
// `/reload` that registers new extension tools, an MCP server that connects late, `tool_search`) as
// a message `{ "role": "system", "tools": [...] }` with NO `content` — Moonshot's own API format.
// Fireworks' OpenAI-compatible endpoint requires `content` on every message and answers 400, so
// every later request of the session fails.
//
// Pi's `before_provider_request` event lets an extension replace the payload. For an
// OpenAI-compatible request to any host but Moonshot's own, this folds those messages back into the
// standard form — their tools join the request's top-level `tools` (by name, once) and the message
// is dropped — which is exactly what Pi sends for a model without mid-conversation tool additions.
// Any other message without `content` (none is known) gets an empty one. Nothing else changes.

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Hosts whose API defines the content-less tool message (Moonshot / Kimi); their requests stay as they are. */
const NATIVE_TOOL_MESSAGE_HOSTS = ['moonshot.ai', 'moonshot.cn', 'kimi.com'];

export function keepsNativeToolMessages(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return NATIVE_TOOL_MESSAGE_HOSTS.some((native) => host === native || host.endsWith(`.${native}`));
  } catch {
    return false;
  }
}

function toolName(tool: unknown): string | undefined {
  if (!isObject(tool)) return undefined;
  const named = isObject(tool.function) ? tool.function : isObject(tool.custom) ? tool.custom : undefined;
  return typeof named?.name === 'string' ? named.name : undefined;
}

/**
 * The payload with every message that lacks `content` fixed, or undefined when none does (or the
 * payload is not a chat-completions request).
 */
export function withContentOnEveryMessage(payload: unknown): JsonObject | undefined {
  if (!isObject(payload) || !Array.isArray(payload.messages)) return undefined;
  if (!payload.messages.some((message) => isObject(message) && !('content' in message))) return undefined;
  const tools: unknown[] = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const names = new Set(tools.map(toolName));
  const messages: unknown[] = [];
  for (const message of payload.messages) {
    if (!isObject(message) || 'content' in message) {
      messages.push(message);
    } else if (message.role === 'system' && Array.isArray(message.tools)) {
      for (const tool of message.tools) {
        const name = toolName(tool);
        if (name !== undefined && names.has(name)) continue;
        names.add(name);
        tools.push(tool);
      }
    } else {
      messages.push({ ...message, content: '' });
    }
  }
  return { ...payload, messages, ...(tools.length > 0 ? { tools } : {}) };
}

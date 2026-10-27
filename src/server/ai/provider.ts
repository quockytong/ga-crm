import { PROVIDER_INFO, type AiModelChoice, type AiProvider } from "../../shared/ai";
import { ApiError } from "../errors";
import type { AiKeys } from "./keys";

/**
 * One client for every provider: Gemini, DeepSeek and Qwen all serve the OpenAI chat
 * completions format, so only the base URL and the key differ.
 */

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  // Provider extras (e.g. Gemini's thought signature) are kept and sent back unchanged.
  [extra: string]: unknown;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type Usage = { inputTokens: number; outputTokens: number };

export type StreamEvent = { type: "text"; delta: string } | { type: "done"; toolCalls: ToolCall[]; reasoning: string; usage: Usage; finish: string | null };

// Tests replace the network with a fake provider.
let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setAiFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function post(keys: AiKeys, choice: AiModelChoice, body: Record<string, unknown>): Promise<Response> {
  const info = PROVIDER_INFO[choice.provider];
  const key = keys[choice.provider];
  if (!key) throw new ApiError(503, "ai_provider_missing");
  let res: Response;
  try {
    res = await fetchImpl(`${info.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: choice.model, ...body }),
    });
  } catch {
    throw new ApiError(502, "ai_provider_error");
  }
  if (res.status === 429) throw new ApiError(429, "ai_rate_limited");
  if (res.status === 401 || res.status === 403) throw new ApiError(400, "ai_key_invalid");
  // Providers retire model ids often (e.g. Gemini 2.5 for new users): the GA Head picks another one.
  if (res.status === 404) {
    console.error("AI model not found", choice.provider, choice.model, (await res.text().catch(() => "")).slice(0, 300));
    throw new ApiError(400, "ai_model_unavailable");
  }
  if (!res.ok) {
    console.error("AI provider error", choice.provider, choice.model, res.status, (await res.text().catch(() => "")).slice(0, 500));
    throw new ApiError(502, "ai_provider_error");
  }
  return res;
}

const usageOf = (u: { prompt_tokens?: number; completion_tokens?: number } | undefined): Usage => ({
  inputTokens: u?.prompt_tokens ?? 0,
  outputTokens: u?.completion_tokens ?? 0,
});

// Not chat models: embeddings, speech, images, video, live audio.
const NOT_CHAT = /embed|tts|audio|image|imagen|veo|aqa|live|vision-only|rerank|moderation|whisper|speech/i;

/** Chat model ids the key can use, from the provider's own list (`GET /models`). */
export async function listModels(keys: AiKeys, provider: AiProvider): Promise<string[]> {
  const key = keys[provider];
  if (!key) throw new ApiError(503, "ai_provider_missing");
  let res: Response;
  try {
    res = await fetchImpl(`${PROVIDER_INFO[provider].baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
  } catch {
    throw new ApiError(502, "ai_provider_error");
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(400, "ai_key_invalid");
  if (!res.ok) throw new ApiError(502, "ai_provider_error");
  const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  return [...new Set((body?.data ?? []).map((m) => (m.id ?? "").replace(/^models\//, "")).filter((id) => id && !NOT_CHAT.test(id)))].sort();
}

/** Smallest possible request, to check that a key and model work. */
export async function ping(keys: AiKeys, choice: AiModelChoice): Promise<void> {
  await post(keys, choice, { messages: [{ role: "user", content: "ping" }], max_tokens: 5 });
}

/** A single JSON answer (router, scoring). */
export async function completeJson(keys: AiKeys, choice: AiModelChoice, messages: ChatMessage[], maxTokens = 2000): Promise<{ data: unknown; usage: Usage }> {
  const res = await post(keys, choice, { messages, max_tokens: maxTokens, response_format: { type: "json_object" } });
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const text = body.choices?.[0]?.message?.content ?? "";
  // Some models wrap JSON in a code fence despite response_format.
  const json = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let data: unknown = null;
  try {
    data = JSON.parse(json);
  } catch {
    data = null;
  }
  return { data, usage: usageOf(body.usage) };
}

type Delta = {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ({ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } } & Record<string, unknown>)[];
};

/** Streams text deltas; the last event carries tool calls (if any) and token usage. */
export async function* streamChat(
  keys: AiKeys,
  choice: AiModelChoice,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; maxTokens?: number } = {},
): AsyncGenerator<StreamEvent> {
  const res = await post(keys, choice, {
    messages,
    max_tokens: opts.maxTokens ?? 4000,
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
  });
  const calls: ToolCall[] = [];
  let reasoning = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finish: string | null = null;
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: { choices?: { delta?: Delta; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = usageOf(chunk.usage);
      const choiceChunk = chunk.choices?.[0];
      if (!choiceChunk) continue;
      if (choiceChunk.finish_reason) finish = choiceChunk.finish_reason;
      const delta = choiceChunk.delta ?? {};
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
        const index = tc.index ?? i;
        const { index: _i, id, type: _t, function: fn, ...extra } = tc;
        const call = (calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (id) call.id = id;
        if (fn?.name) call.function.name += fn.name;
        if (fn?.arguments) call.function.arguments += fn.arguments;
        Object.assign(call, extra);
      }
    }
  }
  yield { type: "done", toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })), reasoning, usage, finish };
}

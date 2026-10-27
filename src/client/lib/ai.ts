import { queryOptions } from "@tanstack/react-query";
import type { AgentConfig, AgentKind, AiContext, AiModelChoice, AiProvider, AiTier, CoachScore, CoachSetup, KbCategory, TaskClass } from "@/shared/ai";
import { api, ApiError } from "./api";

export type AiAgent = {
  id: string;
  kind: AgentKind;
  name: string;
  description: string | null;
  contexts: AiContext[];
  quickPrompts: { label: string; text: string }[];
};
export type AiSource = { n: number; title: string; kb: string; heading: string | null };
export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  task: TaskClass | null;
  model: string | null;
  sources: AiSource[] | null;
  createdAt: string;
};
export type AiConversationRow = { id: string; agentId: string; context: AiContext; contextRef: string | null; title: string; updatedAt: string };
export type AiConversation = {
  conversation: {
    id: string;
    agentId: string;
    context: AiContext;
    contextRef: string | null;
    title: string;
    coach: CoachSetup | null;
    score: CoachScore | null;
  };
  names: Record<string, string>;
  messages: AiMessage[];
};

export const aiAgentsQuery = (context: AiContext) =>
  queryOptions({
    queryKey: ["ai", "agents", context],
    queryFn: () => api<{ enabled: boolean; items: AiAgent[] }>(`/api/ai/agents?context=${context}`),
    staleTime: 60_000,
  });

export const aiConversationsQuery = (context: AiContext, ref?: string) =>
  queryOptions({
    queryKey: ["ai", "conversations", context, ref ?? ""],
    queryFn: () => api<{ items: AiConversationRow[] }>(`/api/ai/conversations?context=${context}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`),
  });

export const aiConversationQuery = (id: string) =>
  queryOptions({ queryKey: ["ai", "conversation", id], queryFn: () => api<AiConversation>(`/api/ai/conversations/${id}`) });

export type StreamHandlers = {
  onMeta?: (m: { task: TaskClass; tier: AiTier; provider: AiProvider; model: string; sources: AiSource[] }) => void;
  onDelta?: (text: string) => void;
  onTool?: (name: string) => void;
  onDone?: (d: { id: string; names: Record<string, string> }) => void;
};

/** Sends a message and reads the server-sent events of the answer. */
export async function sendAiMessage(conversationId: string, body: { text: string; task?: TaskClass }, h: StreamHandlers) {
  let res: Response;
  try {
    res = await fetch(`/api/ai/conversations/${conversationId}/messages`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, err?.error ?? "internal");
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === "meta") h.onMeta?.(payload);
      else if (event === "delta") h.onDelta?.(payload.text);
      else if (event === "tool") h.onTool?.(payload.name);
      else if (event === "done") h.onDone?.(payload);
      else if (event === "error") throw new ApiError(502, payload.error);
    }
  }
}

/* ---------- Administration ---------- */

export type AiAdminAgent = Omit<AiAgent, "quickPrompts"> & {
  enabled: boolean;
  instructions: string;
  models: Partial<Record<AiTier, AiModelChoice>>;
  taskTiers: Partial<Record<TaskClass, AiTier>>;
  sortOrder: number;
  kbIds: string[];
  config: Partial<AgentConfig>;
};
export type AiSettingsView = {
  settings: { enabled: boolean; tiers: Record<AiTier, AiModelChoice>; router: AiModelChoice; monthlyTokenLimit: number };
  usedThisMonth: number;
  providers: {
    provider: AiProvider;
    label: string;
    ready: boolean;
    keySource: "GA" | "PLATFORM" | null;
    last4: string | null;
    keyUpdatedAt: string | null;
    keyUnreadable: boolean;
    models: string[];
  }[];
};
export type AiKb = { id: string; name: string; description: string | null; category: KbCategory; enabled: boolean; documents: number; chars: number };
export type AiDocument = {
  id: string;
  title: string;
  productCode: string | null;
  sourceName: string | null;
  chars: number;
  chunks: number;
  createdAt: string;
  createdByName: string | null;
};
export type AiUsageRow = { key: string; name?: string | null; inputTokens: number; outputTokens: number; answers: number };

export const aiSettingsQuery = queryOptions({ queryKey: ["ai", "admin", "settings"], queryFn: () => api<AiSettingsView>("/api/ai/admin/settings") });
export const aiAdminAgentsQuery = queryOptions({ queryKey: ["ai", "admin", "agents"], queryFn: () => api<{ items: AiAdminAgent[] }>("/api/ai/admin/agents") });
export const aiKbsQuery = queryOptions({ queryKey: ["ai", "admin", "kbs"], queryFn: () => api<{ items: AiKb[] }>("/api/ai/admin/kbs") });
export const aiDocumentsQuery = (kbId: string) =>
  queryOptions({ queryKey: ["ai", "admin", "kbs", kbId], queryFn: () => api<{ items: AiDocument[] }>(`/api/ai/admin/kbs/${kbId}/documents`) });
export const aiModelsQuery = (provider: AiProvider) =>
  queryOptions({
    queryKey: ["ai", "admin", "models", provider],
    queryFn: () => api<{ items: string[] }>(`/api/ai/admin/keys/${provider}/models`),
    staleTime: 10 * 60_000,
    retry: false,
  });
export const aiUsageQuery = (month: string) =>
  queryOptions({
    queryKey: ["ai", "admin", "usage", month],
    queryFn: () =>
      api<{ month: string; byUser: AiUsageRow[]; byAgent: AiUsageRow[]; byModel: AiUsageRow[]; byTask: AiUsageRow[] }>(`/api/ai/admin/usage?month=${month}`),
  });

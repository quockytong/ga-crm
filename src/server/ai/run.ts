import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { aiAgentKnowledge, aiAgents, aiConversations, aiMessages, aiSettings } from "../../db/schema";
import { DEFAULT_TASK_TIER, KB_CATEGORIES, KB_TASKS, TOOL_TASKS, type AiModelChoice, type AiTier, type KbCategory, type TaskClass } from "../../shared/ai";
import { vnToday } from "../../shared/coverage";
import { auditStmt } from "../audit";
import { ApiError } from "../errors";
import { inTenant, type Scope } from "../scope";
import { clientContext, clientListContext, leadContext, leadListContext, myDayContext, type Built } from "./context";
import type { AiKeys } from "./keys";
import { enabledKbIds, searchKnowledge, type Passage } from "./knowledge";
import { CONTEXT_HEADER, systemPrompt } from "./prompts";
import { streamChat, type ChatMessage, type ToolCall, type ToolDef, type Usage } from "./provider";
import { Pseudonymizer } from "./pseudonyms";
import { routeTask, type Route } from "./router";

export type Agent = typeof aiAgents.$inferSelect;
export type Conversation = typeof aiConversations.$inferSelect;
export type Settings = typeof aiSettings.$inferSelect;

export type TurnEvent =
  | { type: "meta"; task: TaskClass; tier: AiTier; provider: string; model: string; routedBy: Route["by"]; sources: Source[] }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string };

export type Source = { n: number; title: string; kb: string; heading: string | null };

const HISTORY = 16;
const MAX_TOOL_ROUNDS = 4;

/** Model for a task: the agent's own choice for the tier, else the GA's. */
export function modelFor(agent: Agent, settings: Settings, task: TaskClass): { tier: AiTier; choice: AiModelChoice } {
  const tier = agent.taskTiers[task] ?? DEFAULT_TASK_TIER[task];
  return { tier, choice: agent.models[tier] ?? settings.tiers[tier] };
}

/** Tokens the GA used this month (Vietnam calendar month). */
export async function monthTokens(db: Db, scope: Scope) {
  const start = new Date(Date.parse(`${vnToday().slice(0, 7)}-01T00:00:00+07:00`)).toISOString();
  const row = await db
    .select({ n: sql<number>`coalesce(sum(${aiMessages.inputTokens} + ${aiMessages.outputTokens}), 0)` })
    .from(aiMessages)
    .where(and(inTenant(scope, aiMessages), gte(aiMessages.createdAt, start)))
    .get();
  return row?.n ?? 0;
}

export async function assertBudget(db: Db, scope: Scope, settings: Settings) {
  if (!settings.enabled) throw new ApiError(403, "ai_disabled");
  if (settings.monthlyTokenLimit > 0 && (await monthTokens(db, scope)) >= settings.monthlyTokenLimit) throw new ApiError(429, "ai_budget_exceeded");
}

/** CRM data for the screen the conversation was opened on. */
export async function buildContext(db: Db, scope: Scope, agent: Agent, conv: Conversation, ps: Pseudonymizer): Promise<Built | null> {
  if (agent.kind === "COACH") return conv.coach?.leadId ? leadContext(db, scope, conv.coach.leadId, ps) : null;
  if (agent.config.crmData === false) return null;
  switch (conv.context) {
    case "LEAD":
      return conv.contextRef ? leadContext(db, scope, conv.contextRef, ps) : null;
    case "CLIENT":
      return conv.contextRef ? clientContext(db, scope, conv.contextRef, ps) : null;
    case "LEAD_LIST":
      return leadListContext(db, scope, ps);
    case "CLIENT_LIST":
      return scope.reach === "NONE" ? null : clientListContext(db, scope, ps);
    case "GENERAL":
      // The operations expert answers from knowledge: no CRM data, fewer tokens.
      return agent.kind === "ASSISTANT" || agent.kind === "CUSTOM" ? myDayContext(db, scope, ps) : null;
  }
}

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Search the GA's knowledge bases (product terms, underwriting, policy services, sales). Returns numbered passages to cite as [S#].",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Vietnamese search words" }, category: { type: "string", enum: [...KB_CATEGORIES] } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lead",
      description: "Full details of a lead by its token, e.g. L3: profile, status, notes, contacts, manager feedback, open tasks.",
      parameters: { type: "object", properties: { lead: { type: "string" } }, required: ["lead"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_client",
      description: "Client 360 by token, e.g. K2: policies, products, coverage and gaps, family, care signals, notes.",
      parameters: { type: "object", properties: { client: { type: "string" } }, required: ["client"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_leads",
      description: "The FC's open leads, most urgent first.",
      parameters: { type: "object", properties: { view: { type: "string", enum: ["all", "overdue", "new", "caring"] } } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_clients",
      description: "The FC's clients with care signals first, optionally only one signal.",
      parameters: { type: "object", properties: { signal: { type: "string", enum: ["due", "debt", "maturity", "birthday", "lapsed"] } } },
    },
  },
  {
    type: "function",
    function: {
      name: "my_day",
      description: "Today's tasks, overdue leads, unread manager feedback, clients needing care.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type TurnState = { sources: Source[]; passages: Set<string>; read: Built["read"] };

function addPassages(state: TurnState, found: Passage[]): string {
  const lines: string[] = [];
  for (const p of found) {
    if (state.passages.has(p.id)) continue;
    state.passages.add(p.id);
    const n = state.sources.length + 1;
    state.sources.push({ n, title: p.title, kb: p.kb, heading: p.heading });
    lines.push(`[S${n}] ${p.title}${p.heading ? ` › ${p.heading}` : ""} (${p.kb})\n${p.body}`);
  }
  return lines.join("\n\n");
}

async function runTool(db: Db, scope: Scope, ps: Pseudonymizer, kbIds: string[], productCodes: string[], state: TurnState, call: ToolCall): Promise<string> {
  let args: Record<string, string> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Lỗi: tham số không hợp lệ.";
  }
  const done = (b: Built | null, missing: string) => {
    if (!b) return missing;
    state.read.push(...b.read);
    return b.text;
  };
  switch (call.function.name) {
    case "search_knowledge": {
      const category = (KB_CATEGORIES as readonly string[]).includes(args.category ?? "") ? [args.category as KbCategory] : undefined;
      const found = await searchKnowledge(db, scope, { kbIds, query: String(args.query ?? ""), categories: category, productCodes });
      return addPassages(state, found) || (found.length ? "Các đoạn này đã có ở trên." : "Không tìm thấy trong kho kiến thức.");
    }
    case "get_lead": {
      const id = ps.resolve(String(args.lead ?? ""), "lead");
      return id ? done(await leadContext(db, scope, id, ps), "Không tìm thấy lead này.") : "Không tìm thấy lead này.";
    }
    case "get_client": {
      const code = ps.resolve(String(args.client ?? ""), "client");
      return code ? done(await clientContext(db, scope, code, ps), "Không tìm thấy khách hàng này.") : "Không tìm thấy khách hàng này.";
    }
    case "list_leads":
      return (await leadListContext(db, scope, ps, { view: (["all", "overdue", "new", "caring"] as const).find((v) => v === args.view) })).text;
    case "list_clients":
      return scope.reach === "NONE"
        ? "Không có dữ liệu khách hàng."
        : (await clientListContext(db, scope, ps, { signal: (["due", "debt", "maturity", "birthday", "lapsed"] as const).find((v) => v === args.signal) }))
            .text;
    case "my_day":
      return (await myDayContext(db, scope, ps)).text;
    default:
      return "Công cụ không tồn tại.";
  }
}

/** One question and its answer. Streams events; returns what to store. */
export async function runTurn(
  db: Db,
  keys: AiKeys,
  scope: Scope,
  input: { agent: Agent; settings: Settings; conv: Conversation; text: string; task?: TaskClass },
  emit: (e: TurnEvent) => Promise<void>,
): Promise<{ content: string; task: TaskClass; choice: AiModelChoice; usage: Usage; sources: Source[] }> {
  const { agent, settings, conv } = input;
  const ps = new Pseudonymizer(conv.pseudonyms);
  const [context, history, linked] = await Promise.all([
    buildContext(db, scope, agent, conv, ps),
    db
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(and(inTenant(scope, aiMessages), eq(aiMessages.conversationId, conv.id)))
      .orderBy(asc(aiMessages.createdAt)),
    db
      .select({ kbId: aiAgentKnowledge.kbId })
      .from(aiAgentKnowledge)
      .where(and(inTenant(scope, aiAgentKnowledge), eq(aiAgentKnowledge.agentId, agent.id))),
  ]);
  const kbIds = await enabledKbIds(
    db,
    scope,
    linked.map((l) => l.kbId),
  );
  const state: TurnState = { sources: [], passages: new Set(), read: [...(context?.read ?? [])] };
  const question = ps.scrub(input.text);
  const recent = history.slice(-HISTORY);

  // 1. Task class: fixed for role-play and quick actions, otherwise routed.
  let route: Route;
  if (agent.kind === "COACH") route = { task: "ROLEPLAY", kb: [], query: "", by: "fixed", usage: { inputTokens: 0, outputTokens: 0 } };
  else if (input.task && input.task !== "ROLEPLAY" && input.task !== "EVALUATION")
    route = { task: input.task, kb: [], query: question, by: "fixed", usage: { inputTokens: 0, outputTokens: 0 } };
  else
    route = await routeTask(
      keys,
      settings.router,
      agent.kind,
      conv.context,
      recent.slice(-4).map((m) => `${m.role === "user" ? "FC" : "AI"}: ${(m.role === "user" ? ps.scrub(m.content) : m.content).slice(0, 300)}`),
      question,
    );
  const { tier, choice } = modelFor(agent, settings, route.task);

  // 2. Knowledge: searched up front when the task needs it; the model may search more with a tool.
  let knowledge = "";
  if (kbIds.length && agent.kind !== "COACH" && (KB_TASKS.includes(route.task) || route.kb.length)) {
    const found = await searchKnowledge(db, scope, {
      kbIds,
      query: route.query || question,
      categories: route.kb.length ? route.kb : undefined,
      productCodes: context?.productCodes,
    });
    knowledge = addPassages(state, found);
  }
  await emit({ type: "meta", task: route.task, tier, provider: choice.provider, model: choice.model, routedBy: route.by, sources: state.sources });

  // 3. Messages: stable prefix (rules, GA instructions, CRM data), then history, then the question.
  const system = [systemPrompt(agent.kind, agent.instructions, conv.coach), context ? `${CONTEXT_HEADER}\n${context.text}` : null].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...recent.map((m): ChatMessage => (m.role === "user" ? { role: "user", content: ps.scrub(m.content) } : { role: "assistant", content: m.content })),
    {
      role: "user",
      content: knowledge ? `KNOWLEDGE PASSAGES (cite as [S#]):\n${knowledge}\n\n---\n${question}` : question,
    },
  ];
  const tools = agent.kind !== "COACH" && agent.config.tools !== false && TOOL_TASKS.includes(route.task) ? TOOLS : undefined;

  // 4. Generate, running tools the model asks for (bounded).
  const usage: Usage = { inputTokens: route.usage.inputTokens, outputTokens: route.usage.outputTokens };
  let content = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let text = "";
    let calls: ToolCall[] = [];
    let reasoning = "";
    for await (const ev of streamChat(keys, choice, messages, {
      tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
      maxTokens: route.task === "CHAT" ? 800 : 4000,
    })) {
      if (ev.type === "text") {
        text += ev.delta;
        await emit({ type: "delta", text: ev.delta });
      } else {
        calls = ev.toolCalls;
        reasoning = ev.reasoning;
        usage.inputTokens += ev.usage.inputTokens;
        usage.outputTokens += ev.usage.outputTokens;
      }
    }
    content += text;
    if (!calls.length) break;
    messages.push({ role: "assistant", content: text || null, tool_calls: calls, ...(reasoning ? { reasoning_content: reasoning } : {}) });
    for (const call of calls) {
      await emit({ type: "tool", name: call.function.name });
      messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(db, scope, ps, kbIds, context?.productCodes ?? [], state, call) });
    }
    if (content && !content.endsWith("\n")) content += "\n\n";
  }

  // 5. Keep the pseudonyms (new people may have appeared) and audit what was read.
  const read = [...new Map(state.read.map((r) => [`${r.entity}:${r.id}`, r])).values()];
  await Promise.all([
    db
      .update(aiConversations)
      .set({ pseudonyms: ps.map, updatedAt: new Date().toISOString() })
      .where(and(inTenant(scope, aiConversations), eq(aiConversations.id, conv.id))),
    ...read.map((r) =>
      auditStmt(db, {
        tenantId: scope.tenantId,
        userId: scope.userId,
        action: "AI_READ",
        entity: r.entity,
        entityId: r.id,
        meta: { conversationId: conv.id, agent: agent.kind },
      }),
    ),
  ]);
  return { content: content.trim(), task: route.task, choice, usage, sources: state.sources };
}

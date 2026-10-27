import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Db } from "../../db/client";
import {
  aiAgentKnowledge,
  aiAgents,
  aiConversations,
  aiDocuments,
  aiKnowledgeBases,
  aiMessages,
  aiProviderKeys,
  aiSettings,
  leads,
  users,
} from "../../db/schema";
import {
  AI_PROVIDERS,
  aiAgentSchema,
  aiSettingsSchema,
  coachScoreSchema,
  createConversationSchema,
  DEFAULT_AGENT_KINDS,
  DEFAULT_MONTHLY_TOKENS,
  defaultAgentConfig,
  DEFAULT_TIERS,
  documentSchema,
  kbSearchSchema,
  knowledgeBaseSchema,
  PROVIDER_INFO,
  providerKeySchema,
  sendMessageSchema,
  updateDocumentSchema,
  type AiContext,
} from "../../shared/ai";
import { vi } from "../../i18n/vi";
import { addDocument, deleteDocuments, searchKnowledge } from "../ai/knowledge";
import { encryptKey, keyRow, loadKeys } from "../ai/keys";
import { completeJson, listModels, ping } from "../ai/provider";
import { displayNames, Pseudonymizer } from "../ai/pseudonyms";
import { SCORE_PROMPT } from "../ai/prompts";
import { assertBudget, buildContext, modelFor, monthTokens, runTurn, type Agent, type Settings } from "../ai/run";
import { auditBy, auditStmt } from "../audit";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { valid } from "../http";
import { requirePermission } from "../middleware";
import { inTenant, scopeOf, visibleLeads, type Scope } from "../scope";

/**
 * AI assistants (docs/SPEC-ai.md). Agents use them with `ai.use`, on their own data only;
 * the GA Head (or a role granted `ai.manage`) configures agents, models, knowledge and budget.
 * Conversations are private to the user who started them.
 */

/** A new GA gets the three default assistants and Gemini models; the GA Head edits them. */
export async function ensureDefaults(db: Db, scope: Scope): Promise<Settings> {
  const existing = await db.select().from(aiSettings).where(inTenant(scope, aiSettings)).get();
  if (existing) return existing;
  const now = new Date().toISOString();
  const settings = {
    tenantId: scope.tenantId,
    enabled: true,
    tiers: DEFAULT_TIERS,
    router: DEFAULT_TIERS.FAST,
    monthlyTokenLimit: DEFAULT_MONTHLY_TOKENS,
    updatedBy: null,
    updatedAt: now,
  };
  const d = vi.ai.defaults;
  const agentRows = DEFAULT_AGENT_KINDS.map((kind, i) => ({
    // Fixed ids: two first requests at the same time create them only once.
    id: `${scope.tenantId}:${kind}`,
    tenantId: scope.tenantId,
    kind,
    name: d[kind].name,
    description: d[kind].description,
    enabled: true,
    instructions: d[kind].instructions,
    contexts: (kind === "COACH" ? ["GENERAL", "LEAD"] : ["GENERAL", "LEAD", "CLIENT", "LEAD_LIST", "CLIENT_LIST"]) as AiContext[],
    models: {},
    taskTiers: {},
    config: defaultAgentConfig(kind),
    sortOrder: i,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  }));
  await db.batch([db.insert(aiSettings).values(settings).onConflictDoNothing(), db.insert(aiAgents).values(agentRows).onConflictDoNothing()]);
  const row = await db.select().from(aiSettings).where(inTenant(scope, aiSettings)).get();
  return row!;
}

async function getAgent(db: Db, scope: Scope, id: string) {
  const agent = await db
    .select()
    .from(aiAgents)
    .where(and(inTenant(scope, aiAgents), eq(aiAgents.id, id)))
    .get();
  if (!agent) throw notFound();
  return agent;
}

async function ownConversation(db: Db, scope: Scope, id: string) {
  const conv = await db
    .select()
    .from(aiConversations)
    .where(and(inTenant(scope, aiConversations), eq(aiConversations.id, id), eq(aiConversations.userId, scope.userId)))
    .get();
  if (!conv) throw notFound();
  return conv;
}

const providerParam = z.object({ provider: z.enum(AI_PROVIDERS) });

const agentView = (a: Agent) => ({
  id: a.id,
  kind: a.kind,
  name: a.name,
  description: a.description,
  contexts: a.contexts,
  quickPrompts: a.config.quickPrompts ?? [],
});

const use = new Hono<AppEnv>()
  .use(requirePermission("ai.use"))

  /** Assistants the user can open on this screen. */
  .get("/agents", valid("query", z.object({ context: z.enum(["GENERAL", "LEAD", "CLIENT", "LEAD_LIST", "CLIENT_LIST"]).optional() })), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const settings = await ensureDefaults(db, scope);
    const { context } = c.req.valid("query");
    const rows = await db
      .select()
      .from(aiAgents)
      .where(and(inTenant(scope, aiAgents), eq(aiAgents.enabled, true)))
      .orderBy(asc(aiAgents.sortOrder), asc(aiAgents.name));
    return c.json({ enabled: settings.enabled, items: rows.filter((a) => !context || a.contexts.includes(context)).map(agentView) });
  })

  .get("/conversations", valid("query", z.object({ context: z.string().max(20).optional(), ref: z.string().max(64).optional() })), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { context, ref } = c.req.valid("query");
    const rows = await db
      .select({
        id: aiConversations.id,
        agentId: aiConversations.agentId,
        context: aiConversations.context,
        contextRef: aiConversations.contextRef,
        title: aiConversations.title,
        updatedAt: aiConversations.updatedAt,
      })
      .from(aiConversations)
      .where(
        and(
          inTenant(scope, aiConversations),
          eq(aiConversations.userId, scope.userId),
          context ? eq(aiConversations.context, context as AiContext) : undefined,
          ref ? eq(aiConversations.contextRef, ref) : undefined,
        ),
      )
      .orderBy(desc(aiConversations.updatedAt))
      .limit(30);
    return c.json({ items: rows });
  })

  .post("/conversations", valid("json", createConversationSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const agent = await getAgent(db, scope, input.agentId);
    if (!agent.enabled || (!agent.contexts.includes(input.context) && agent.kind !== "COACH")) throw new ApiError(400, "ai_agent_unavailable");
    if (agent.kind !== "COACH" && (input.context === "LEAD" || input.context === "CLIENT") && !input.contextRef) throw new ApiError(400, "invalid_input");
    // Practice based on a lead: the lead must be visible to the FC.
    if (input.coach?.leadId) {
      const lead = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(visibleLeads(scope), eq(leads.id, input.coach.leadId)))
        .get();
      if (!lead) throw notFound();
    }
    const now = new Date().toISOString();
    const conv = {
      id: crypto.randomUUID(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      agentId: agent.id,
      context: agent.kind === "COACH" ? ("GENERAL" as const) : input.context,
      contextRef: agent.kind === "COACH" ? null : (input.contextRef ?? null),
      title: agent.kind === "COACH" ? vi.ai.coachTitle : agent.name,
      pseudonyms: {},
      coach: agent.kind === "COACH" ? (input.coach ?? { scenario: "NO_MONEY" as const, difficulty: "MEDIUM" as const }) : null,
      score: null,
      createdAt: now,
      updatedAt: now,
    };
    // The context must be readable now (scope): a lead or client out of scope is a 404.
    // Checked even when the agent does not read CRM data, so a conversation can never point at a record out of scope.
    const built = await buildContext(db, scope, { ...agent, config: { ...agent.config, crmData: true } }, conv, new Pseudonymizer(conv.pseudonyms));
    if ((conv.context === "LEAD" || conv.context === "CLIENT" || conv.coach?.leadId) && !built) throw notFound();
    await db.insert(aiConversations).values(conv);
    return c.json({ id: conv.id }, 201);
  })

  .get("/conversations/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const conv = await ownConversation(db, scope, c.req.param("id"));
    const messages = await db
      .select({
        id: aiMessages.id,
        role: aiMessages.role,
        content: aiMessages.content,
        task: aiMessages.task,
        model: aiMessages.model,
        sources: aiMessages.sources,
        createdAt: aiMessages.createdAt,
      })
      .from(aiMessages)
      .where(and(inTenant(scope, aiMessages), eq(aiMessages.conversationId, conv.id)))
      .orderBy(asc(aiMessages.createdAt));
    return c.json({ conversation: { ...conv, pseudonyms: undefined }, names: displayNames(conv.pseudonyms), messages });
  })

  .delete("/conversations/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const conv = await ownConversation(db, scope, c.req.param("id"));
    // Messages stay (without the conversation) for the usage report; their text goes.
    await db.batch([
      db
        .update(aiMessages)
        .set({ content: "" })
        .where(and(inTenant(scope, aiMessages), eq(aiMessages.conversationId, conv.id))),
      db.delete(aiConversations).where(and(inTenant(scope, aiConversations), eq(aiConversations.id, conv.id))),
    ]);
    return c.body(null, 204);
  })

  /** Sends a message; the answer streams back as server-sent events. */
  .post("/conversations/:id/messages", valid("json", sendMessageSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const conv = await ownConversation(db, scope, c.req.param("id"));
    const agent = await getAgent(db, scope, conv.agentId);
    if (!agent.enabled) throw new ApiError(400, "ai_agent_unavailable");
    if (conv.score) throw new ApiError(409, "ai_practice_finished");
    const settings = await ensureDefaults(db, scope);
    await assertBudget(db, scope, settings);
    const { text, task } = c.req.valid("json");
    const userMsg = {
      id: crypto.randomUUID(),
      tenantId: scope.tenantId,
      conversationId: conv.id,
      userId: scope.userId,
      agentId: agent.id,
      role: "user" as const,
      content: text,
      createdAt: new Date().toISOString(),
    };
    const firstMessage = !(await db
      .select({ id: aiMessages.id })
      .from(aiMessages)
      .where(and(inTenant(scope, aiMessages), eq(aiMessages.conversationId, conv.id)))
      .limit(1)
      .get());
    await db.insert(aiMessages).values(userMsg);
    if (firstMessage && agent.kind !== "COACH")
      await db
        .update(aiConversations)
        .set({ title: text.slice(0, 80) })
        .where(eq(aiConversations.id, conv.id));

    return streamSSE(c, async (stream) => {
      try {
        const { keys } = await loadKeys(db, c.env, scope);
        const result = await runTurn(db, keys, scope, { agent, settings, conv, text, task }, (e) =>
          stream.writeSSE({ event: e.type, data: JSON.stringify(e) }),
        );
        const id = crypto.randomUUID();
        await db.insert(aiMessages).values({
          id,
          tenantId: scope.tenantId,
          conversationId: conv.id,
          userId: scope.userId,
          agentId: agent.id,
          role: "assistant",
          content: result.content || vi.ai.emptyAnswer,
          task: result.task,
          provider: result.choice.provider,
          model: result.choice.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          sources: result.sources,
          createdAt: new Date().toISOString(),
        });
        const fresh = await ownConversation(db, scope, conv.id);
        await stream.writeSSE({ event: "done", data: JSON.stringify({ id, names: displayNames(fresh.pseudonyms), usage: result.usage }) });
      } catch (err) {
        const code = err instanceof ApiError ? err.code : "ai_provider_error";
        if (!(err instanceof ApiError)) console.error(err);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: code }) });
      }
    });
  })

  /** Ends an objection-handling practice and scores the FC. */
  .post("/conversations/:id/score", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const conv = await ownConversation(db, scope, c.req.param("id"));
    const agent = await getAgent(db, scope, conv.agentId);
    if (agent.kind !== "COACH") throw new ApiError(400, "invalid_input");
    if (conv.score) return c.json({ score: conv.score });
    const settings = await ensureDefaults(db, scope);
    await assertBudget(db, scope, settings);
    const ps = new Pseudonymizer(conv.pseudonyms);
    const turns = await db
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(and(inTenant(scope, aiMessages), eq(aiMessages.conversationId, conv.id)))
      .orderBy(asc(aiMessages.createdAt));
    if (turns.filter((t) => t.role === "user").length < 2) throw new ApiError(400, "ai_practice_too_short");
    const transcript = turns.map((t) => `${t.role === "user" ? "FC" : "KH"}: ${t.role === "user" ? ps.scrub(t.content) : t.content}`).join("\n");
    const { choice } = modelFor(agent, settings, "EVALUATION");
    const setup = conv.coach
      ? `Scenario: ${conv.coach.scenario}, difficulty ${conv.coach.difficulty}${conv.coach.product ? `, product ${conv.coach.product}` : ""}.`
      : "";
    const { data, usage } = await completeJson(
      (await loadKeys(db, c.env, scope)).keys,
      choice,
      [
        { role: "system", content: SCORE_PROMPT },
        { role: "user", content: `${setup}\n\nTranscript:\n${transcript}` },
      ],
      3000,
    );
    const parsed = coachScoreSchema.safeParse(data);
    if (!parsed.success) throw new ApiError(502, "ai_bad_output");
    const now = new Date().toISOString();
    await db.batch([
      db.update(aiConversations).set({ score: parsed.data, updatedAt: now }).where(eq(aiConversations.id, conv.id)),
      db.insert(aiMessages).values({
        id: crypto.randomUUID(),
        tenantId: scope.tenantId,
        conversationId: conv.id,
        userId: scope.userId,
        agentId: agent.id,
        role: "assistant",
        content: parsed.data.verdict,
        task: "EVALUATION",
        provider: choice.provider,
        model: choice.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        createdAt: now,
      }),
    ]);
    return c.json({ score: parsed.data });
  });

/* ---------- Administration (GA Head) ---------- */

async function assertKbIds(db: Db, scope: Scope, ids: string[]) {
  if (!ids.length) return;
  const found = await db
    .select({ id: aiKnowledgeBases.id })
    .from(aiKnowledgeBases)
    .where(and(inTenant(scope, aiKnowledgeBases), inArray(aiKnowledgeBases.id, ids)));
  if (found.length !== new Set(ids).size) throw new ApiError(400, "invalid_input");
}

async function getKb(db: Db, scope: Scope, id: string) {
  const kb = await db
    .select()
    .from(aiKnowledgeBases)
    .where(and(inTenant(scope, aiKnowledgeBases), eq(aiKnowledgeBases.id, id)))
    .get();
  if (!kb) throw notFound();
  return kb;
}

const admin = new Hono<AppEnv>()
  .use(requirePermission("ai.manage"))

  .get("/settings", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const settings = await ensureDefaults(db, scope);
    const [{ source }, rows] = await Promise.all([loadKeys(db, c.env, scope), db.select().from(aiProviderKeys).where(inTenant(scope, aiProviderKeys))]);
    return c.json({
      settings,
      usedThisMonth: await monthTokens(db, scope),
      providers: AI_PROVIDERS.map((p) => {
        const row = rows.find((r) => r.provider === p);
        return {
          provider: p,
          label: PROVIDER_INFO[p].label,
          ready: !!source[p],
          // GA = the GA's own key, PLATFORM = the platform's (Worker secret). The key itself never leaves the server.
          keySource: source[p],
          last4: source[p] === "GA" ? (row?.last4 ?? null) : null,
          keyUpdatedAt: row?.updatedAt ?? null,
          // A stored key that can no longer be decrypted (secret rotated): ask for it again.
          keyUnreadable: !!row && source[p] !== "GA",
          models: PROVIDER_INFO[p].models,
        };
      }),
    });
  })

  /** The GA's own API key for a provider (replaces the previous one). */
  .put("/keys/:provider", valid("param", providerParam), valid("json", providerKeySchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { provider } = c.req.valid("param");
    const { apiKey } = c.req.valid("json");
    const row = {
      tenantId: scope.tenantId,
      provider,
      encryptedKey: await encryptKey(c.env, scope.tenantId, provider, apiKey),
      last4: apiKey.slice(-4),
      updatedBy: scope.userId,
      updatedAt: new Date().toISOString(),
    };
    await db.batch([
      db
        .insert(aiProviderKeys)
        .values(row)
        .onConflictDoUpdate({
          target: [aiProviderKeys.tenantId, aiProviderKeys.provider],
          set: { encryptedKey: row.encryptedKey, last4: row.last4, updatedBy: row.updatedBy, updatedAt: row.updatedAt },
        }),
      // Never the key itself in the audit log.
      auditStmt(db, { ...auditBy(c), action: "UPDATE", entity: "ai_provider_key", entityId: provider, meta: { last4: row.last4 } }),
    ]);
    return c.json({ ok: true, last4: row.last4 });
  })

  .delete("/keys/:provider", valid("param", providerParam), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { provider } = c.req.valid("param");
    if (!(await keyRow(db, scope, provider))) throw notFound();
    await db.batch([
      db.delete(aiProviderKeys).where(and(inTenant(scope, aiProviderKeys), eq(aiProviderKeys.provider, provider))),
      auditStmt(db, { ...auditBy(c), action: "DELETE", entity: "ai_provider_key", entityId: provider }),
    ]);
    return c.body(null, 204);
  })

  /** Chat models the key in use can call, from the provider's live list. */
  .get("/keys/:provider/models", valid("param", providerParam), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { provider } = c.req.valid("param");
    const { keys } = await loadKeys(db, c.env, scope);
    return c.json({ items: await listModels(keys, provider) });
  })

  /** Checks the key in use for a provider with a tiny request on a model of that provider. */
  .post("/keys/:provider/test", valid("param", providerParam), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { provider } = c.req.valid("param");
    const settings = await ensureDefaults(db, scope);
    const { keys } = await loadKeys(db, c.env, scope);
    const model = [settings.router, ...Object.values(settings.tiers)].find((m) => m.provider === provider)?.model ?? PROVIDER_INFO[provider].models[0]!;
    await ping(keys, { provider, model });
    return c.json({ ok: true, model });
  })

  .put("/settings", valid("json", aiSettingsSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    await ensureDefaults(db, scope);
    const input = c.req.valid("json");
    await db.batch([
      db
        .update(aiSettings)
        .set({ ...input, updatedBy: scope.userId, updatedAt: new Date().toISOString() })
        .where(inTenant(scope, aiSettings)),
      auditStmt(db, { ...auditBy(c), action: "UPDATE", entity: "ai_settings", entityId: scope.tenantId, meta: input }),
    ]);
    return c.json({ ok: true });
  })

  .get("/agents", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    await ensureDefaults(db, scope);
    const [rows, links] = await Promise.all([
      db.select().from(aiAgents).where(inTenant(scope, aiAgents)).orderBy(asc(aiAgents.sortOrder), asc(aiAgents.name)),
      db.select().from(aiAgentKnowledge).where(inTenant(scope, aiAgentKnowledge)),
    ]);
    return c.json({ items: rows.map((a) => ({ ...a, kbIds: links.filter((l) => l.agentId === a.id).map((l) => l.kbId) })) });
  })

  .post("/agents", valid("json", aiAgentSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const { kbIds, ...input } = c.req.valid("json");
    await assertKbIds(db, scope, kbIds);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(aiAgents).values({
        ...input,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 100,
        id,
        tenantId: scope.tenantId,
        createdBy: scope.userId,
        createdAt: now,
        updatedAt: now,
      }),
      ...[...new Set(kbIds)].map((kbId) => db.insert(aiAgentKnowledge).values({ tenantId: scope.tenantId, agentId: id, kbId })),
      auditStmt(db, { ...auditBy(c), action: "CREATE", entity: "ai_agent", entityId: id, meta: { name: input.name, kind: input.kind } }),
    ]);
    return c.json({ id }, 201);
  })

  .patch("/agents/:id", valid("json", aiAgentSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const agent = await getAgent(db, scope, c.req.param("id"));
    const { kbIds, ...input } = c.req.valid("json");
    await assertKbIds(db, scope, kbIds);
    await db.batch([
      db
        .update(aiAgents)
        .set({ ...input, description: input.description ?? null, sortOrder: input.sortOrder ?? agent.sortOrder, updatedAt: new Date().toISOString() })
        .where(and(inTenant(scope, aiAgents), eq(aiAgents.id, agent.id))),
      db.delete(aiAgentKnowledge).where(and(inTenant(scope, aiAgentKnowledge), eq(aiAgentKnowledge.agentId, agent.id))),
      ...[...new Set(kbIds)].map((kbId) => db.insert(aiAgentKnowledge).values({ tenantId: scope.tenantId, agentId: agent.id, kbId })),
      auditStmt(db, { ...auditBy(c), action: "UPDATE", entity: "ai_agent", entityId: agent.id, meta: { name: input.name, enabled: input.enabled } }),
    ]);
    return c.json({ ok: true });
  })

  .delete("/agents/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const agent = await getAgent(db, scope, c.req.param("id"));
    await db.batch([
      db.delete(aiAgentKnowledge).where(and(inTenant(scope, aiAgentKnowledge), eq(aiAgentKnowledge.agentId, agent.id))),
      db.delete(aiAgents).where(and(inTenant(scope, aiAgents), eq(aiAgents.id, agent.id))),
      auditStmt(db, { ...auditBy(c), action: "DELETE", entity: "ai_agent", entityId: agent.id, meta: { name: agent.name } }),
    ]);
    return c.body(null, 204);
  })

  .get("/kbs", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const [kbs, stats] = await Promise.all([
      db.select().from(aiKnowledgeBases).where(inTenant(scope, aiKnowledgeBases)).orderBy(asc(aiKnowledgeBases.name)),
      db
        .select({ kbId: aiDocuments.kbId, docs: count(), chars: sql<number>`sum(${aiDocuments.chars})` })
        .from(aiDocuments)
        .where(inTenant(scope, aiDocuments))
        .groupBy(aiDocuments.kbId),
    ]);
    return c.json({
      items: kbs.map((k) => ({ ...k, documents: stats.find((s) => s.kbId === k.id)?.docs ?? 0, chars: stats.find((s) => s.kbId === k.id)?.chars ?? 0 })),
    });
  })

  .post("/kbs", valid("json", knowledgeBaseSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const input = c.req.valid("json");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.batch([
      db
        .insert(aiKnowledgeBases)
        .values({ ...input, description: input.description ?? null, id, tenantId: scope.tenantId, createdBy: scope.userId, createdAt: now, updatedAt: now }),
      auditStmt(db, { ...auditBy(c), action: "CREATE", entity: "ai_knowledge_base", entityId: id, meta: { name: input.name } }),
    ]);
    return c.json({ id }, 201);
  })

  .patch("/kbs/:id", valid("json", knowledgeBaseSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const kb = await getKb(db, scope, c.req.param("id"));
    const input = c.req.valid("json");
    await db.batch([
      db
        .update(aiKnowledgeBases)
        .set({ ...input, description: input.description ?? null, updatedAt: new Date().toISOString() })
        .where(and(inTenant(scope, aiKnowledgeBases), eq(aiKnowledgeBases.id, kb.id))),
      auditStmt(db, { ...auditBy(c), action: "UPDATE", entity: "ai_knowledge_base", entityId: kb.id, meta: input }),
    ]);
    return c.json({ ok: true });
  })

  .delete("/kbs/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const kb = await getKb(db, scope, c.req.param("id"));
    const docs = await db
      .select({ id: aiDocuments.id })
      .from(aiDocuments)
      .where(and(inTenant(scope, aiDocuments), eq(aiDocuments.kbId, kb.id)));
    await deleteDocuments(
      db,
      scope,
      docs.map((d) => d.id),
    );
    await db.batch([
      db.delete(aiAgentKnowledge).where(and(inTenant(scope, aiAgentKnowledge), eq(aiAgentKnowledge.kbId, kb.id))),
      db.delete(aiKnowledgeBases).where(and(inTenant(scope, aiKnowledgeBases), eq(aiKnowledgeBases.id, kb.id))),
      auditStmt(db, { ...auditBy(c), action: "DELETE", entity: "ai_knowledge_base", entityId: kb.id, meta: { name: kb.name, documents: docs.length } }),
    ]);
    return c.body(null, 204);
  })

  .get("/kbs/:id/documents", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const kb = await getKb(db, scope, c.req.param("id"));
    const rows = await db
      .select({
        id: aiDocuments.id,
        title: aiDocuments.title,
        productCode: aiDocuments.productCode,
        sourceName: aiDocuments.sourceName,
        chars: aiDocuments.chars,
        chunks: aiDocuments.chunks,
        createdAt: aiDocuments.createdAt,
        createdByName: users.name,
      })
      .from(aiDocuments)
      .leftJoin(users, eq(users.id, aiDocuments.createdBy))
      .where(and(inTenant(scope, aiDocuments), eq(aiDocuments.kbId, kb.id)))
      .orderBy(asc(aiDocuments.title));
    return c.json({ items: rows });
  })

  .post("/kbs/:id/documents", valid("json", documentSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const kb = await getKb(db, scope, c.req.param("id"));
    const doc = await addDocument(db, scope, kb.id, c.req.valid("json"));
    await auditStmt(db, {
      ...auditBy(c),
      action: "CREATE",
      entity: "ai_document",
      entityId: doc.id,
      meta: { kb: kb.name, title: doc.title, chunks: doc.chunks },
    });
    return c.json({ id: doc.id, chunks: doc.chunks }, 201);
  })

  /** Rename a document or change its product code (the text is not touched). */
  .patch("/documents/:id", valid("json", updateDocumentSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const doc = await db
      .select()
      .from(aiDocuments)
      .where(and(inTenant(scope, aiDocuments), eq(aiDocuments.id, c.req.param("id"))))
      .get();
    if (!doc) throw notFound();
    const input = c.req.valid("json");
    const set = { title: input.title, ...(input.productCode !== undefined ? { productCode: input.productCode || null } : {}) };
    await db.batch([
      db
        .update(aiDocuments)
        .set(set)
        .where(and(inTenant(scope, aiDocuments), eq(aiDocuments.id, doc.id))),
      auditStmt(db, {
        ...auditBy(c),
        action: "UPDATE",
        entity: "ai_document",
        entityId: doc.id,
        meta: { before: { title: doc.title, productCode: doc.productCode }, after: set },
      }),
    ]);
    return c.json({ ok: true });
  })

  .delete("/documents/:id", async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const doc = await db
      .select()
      .from(aiDocuments)
      .where(and(inTenant(scope, aiDocuments), eq(aiDocuments.id, c.req.param("id"))))
      .get();
    if (!doc) throw notFound();
    await deleteDocuments(db, scope, [doc.id]);
    await auditStmt(db, { ...auditBy(c), action: "DELETE", entity: "ai_document", entityId: doc.id, meta: { title: doc.title } });
    return c.body(null, 204);
  })

  /** Try a search across all knowledge bases of the GA. */
  .get("/search", valid("query", kbSearchSchema), async (c) => {
    const db = c.get("db");
    const scope = scopeOf(c.get("actor"));
    const kbs = await db.select({ id: aiKnowledgeBases.id }).from(aiKnowledgeBases).where(inTenant(scope, aiKnowledgeBases));
    const items = await searchKnowledge(db, scope, { kbIds: kbs.map((k) => k.id), query: c.req.valid("query").q, limit: 8 });
    return c.json({ items });
  })

  /** Tokens per user, assistant and model in a month (YYYY-MM, Vietnam time). */
  .get(
    "/usage",
    valid(
      "query",
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const scope = scopeOf(c.get("actor"));
      const month = c.req.valid("query").month ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
      const start = new Date(Date.parse(`${month}-01T00:00:00+07:00`));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), start.getUTCHours()));
      const where = and(
        inTenant(scope, aiMessages),
        gte(aiMessages.createdAt, start.toISOString()),
        lt(aiMessages.createdAt, end.toISOString()),
        eq(aiMessages.role, "assistant"),
      );
      const totals = {
        inputTokens: sql<number>`coalesce(sum(${aiMessages.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${aiMessages.outputTokens}), 0)`,
        answers: count(),
      };
      const [byUser, byAgent, byModel, byTask] = await Promise.all([
        db
          .select({ key: aiMessages.userId, name: users.name, ...totals })
          .from(aiMessages)
          .leftJoin(users, eq(users.id, aiMessages.userId))
          .where(where)
          .groupBy(aiMessages.userId),
        db
          .select({ key: aiMessages.agentId, name: aiAgents.name, ...totals })
          .from(aiMessages)
          .leftJoin(aiAgents, and(eq(aiAgents.tenantId, aiMessages.tenantId), eq(aiAgents.id, aiMessages.agentId)))
          .where(where)
          .groupBy(aiMessages.agentId),
        db
          .select({ key: sql<string>`${aiMessages.provider} || ' · ' || ${aiMessages.model}`, ...totals })
          .from(aiMessages)
          .where(where)
          .groupBy(aiMessages.provider, aiMessages.model),
        db
          .select({ key: sql<string>`coalesce(${aiMessages.task}, '')`, ...totals })
          .from(aiMessages)
          .where(where)
          .groupBy(aiMessages.task),
      ]);
      return c.json({ month, byUser, byAgent, byModel, byTask });
    },
  );

export const aiRoutes = new Hono<AppEnv>().route("/admin", admin).route("/", use);

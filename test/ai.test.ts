import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiProviderKeys, auditLog } from "../src/db/schema";
import { setAiFetch } from "../src/server/ai/provider";
import { Pseudonymizer } from "../src/server/ai/pseudonyms";
import { ruleRoute } from "../src/server/ai/router";
import { splitText } from "../src/server/ai/knowledge";
import { addDays, vnToday } from "../src/shared/coverage";
import { as, db, json, seedDb } from "./helpers";
import { book, client, policy, run } from "./import-helpers";

// AI assistants: scope, pseudonymisation, routing, knowledge, tools, practice scoring, budget.

type Call = { url: string; body: any; auth: string };
/** Keys the fake provider rejects with 401. */
const badKeys = new Set(["sk-bad-key-0000"]);
let calls: Call[] = [];
/** What the fake provider answers next: router JSON, streamed text, tool calls, score JSON. */
let router: unknown = { task: "LOOKUP", kb: [], query: "" };
let score: unknown = null;
let toolPlan: { name: string; arguments: string }[] = [];

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

function fakeProvider(url: string, init?: RequestInit): Response {
  if (url.endsWith("/models"))
    return Response.json({ data: [{ id: "models/gemini-3.5-flash" }, { id: "models/gemini-embedding-001" }, { id: "models/gemini-3.1-pro-preview" }] });
  const body = JSON.parse(String(init?.body));
  if (body.model === "retired-model") return Response.json({ error: { code: 404, message: "no longer available" } }, { status: 404 });
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  calls.push({ url, body, auth });
  if (badKeys.has(auth.replace("Bearer ", ""))) return new Response("unauthorized", { status: 401 });
  if (body.response_format) {
    const isScore = body.messages[0].content.includes("sales coach");
    return Response.json({
      choices: [{ message: { content: JSON.stringify(isScore ? score : router) } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
  }
  const lastIsTool = body.messages.at(-1).role === "tool";
  if (toolPlan.length && body.tools && !lastIsTool) {
    return sse([
      ...toolPlan.map((t, index) => ({
        choices: [{ delta: { tool_calls: [{ index, id: `t${index}`, type: "function", function: { name: t.name, arguments: t.arguments } }] } }],
      })),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } },
    ]);
  }
  return sse([
    { choices: [{ delta: { content: "Chào bạn, " } }] },
    { choices: [{ delta: { content: "[L1] nên được gọi lại hôm nay." }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 20 } },
  ]);
}

/** Everything sent to the provider, as one string. */
const sent = () => JSON.stringify(calls.map((c) => c.body));

async function events(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((b) => ({ event: /event: (\w+)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)![1]!) }));
}

let leadId = "";
const today = vnToday();
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

beforeAll(async () => {
  setAiFetch(async (input, init) => fakeProvider(String(input), init));
  await seedDb();
  const fc1 = await as("fc1@ga1.test");
  const res = await fc1("/api/leads", {
    json: {
      fullName: "Nguyễn Văn Khách",
      phone: "0912 345 678",
      source: "Giới thiệu",
      consent: true,
      note: "Anh thích chơi golf. Vợ bị tiểu đường, đang điều trị.",
    },
  });
  leadId = (await json(res)).id;
  await fc1(`/api/leads/${leadId}/activities`, { json: { type: "CALL", note: "Gọi cho Nguyễn Văn Khách, hẹn tuần sau, email khach@mail.vn" } });
  await run(
    fc1,
    book({
      "02_Clients": [client({ "Mã Khách Hàng": "0000000001", "Bên Mua BH": "Lê Thị An" })],
      "03_Policies": [policy({ "Số HĐBH": "009000001", "Ngày đến hạn đóng phí": ddmmyyyy(addDays(today, 10)) })],
    }),
  );
});
afterAll(() => setAiFetch(null));
beforeEach(() => {
  calls = [];
  router = { task: "LOOKUP", kb: [], query: "" };
  toolPlan = [];
});

const agentsOf = async (email: string, context = "GENERAL") => (await json(await (await as(email))(`/api/ai/agents?context=${context}`))).items as any[];
const agentId = async (email: string, kind: string, context = "GENERAL") => (await agentsOf(email, context)).find((a) => a.kind === kind).id as string;

async function start(email: string, kind: string, context: string, contextRef?: string, coach?: unknown) {
  const user = await as(email);
  const res = await user("/api/ai/conversations", { json: { agentId: await agentId(email, kind, context), context, contextRef, coach } });
  return { user, res, id: res.status === 201 ? ((await json(res)).id as string) : "" };
}

describe("access", () => {
  it("agents get the three default assistants of their own GA; Marketing has no ai.use", async () => {
    const mine = await agentsOf("fc1@ga1.test");
    expect(mine.map((a) => a.kind).sort()).toEqual(["ASSISTANT", "COACH", "OPS"]);
    const other = await agentsOf("fc1@ga2.test");
    expect(other.map((a) => a.id)).not.toContain(mine[0].id);
    expect((await (await as("marketing@ga1.test"))("/api/ai/agents")).status).toBe(403);
    // Coach is not offered on a client page.
    expect((await agentsOf("fc1@ga1.test", "CLIENT")).map((a) => a.kind)).not.toContain("COACH");
  });

  it("a lead or client out of scope, another GA's agent and another user's conversation are 404", async () => {
    expect((await start("fc3@ga1.test", "ASSISTANT", "LEAD", leadId)).res.status).toBe(404);
    expect((await start("fc3@ga1.test", "ASSISTANT", "CLIENT", "0000000001")).res.status).toBe(404);
    const fc1 = await as("fc1@ga1.test");
    const foreign = await (
      await as("fc1@ga2.test")
    )("/api/ai/conversations", { json: { agentId: await agentId("fc1@ga1.test", "ASSISTANT"), context: "GENERAL" } });
    expect(foreign.status).toBe(404);
    const { id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    expect((await (await as("fc2@ga1.test"))(`/api/ai/conversations/${id}`)).status).toBe(404);
    expect((await fc1(`/api/ai/conversations/${id}`)).status).toBe(200);
  });

  it("only ai.manage reaches the administration", async () => {
    expect((await (await as("fc1@ga1.test"))("/api/ai/admin/settings")).status).toBe(403);
    expect((await (await as("bm1@ga1.test"))("/api/ai/admin/agents")).status).toBe(403);
    expect((await (await as("head@ga1.test"))("/api/ai/admin/settings")).status).toBe(200);
  });
});

describe("pseudonymisation (PDP)", () => {
  it("the provider never sees names, phones, emails, client codes, policy numbers or health notes", async () => {
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "LEAD", leadId);
    const res = await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Nguyễn Văn Khách (0912345678) thích gì? Tóm tắt giúp tôi." } });
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);
    const out = sent();
    for (const secret of ["Nguyễn Văn Khách", "0912345678", "0912 345 678", "khach@mail.vn", "tiểu đường"]) expect(out).not.toContain(secret);
    expect(out).toContain("[L1]");
    expect(out).toContain("golf");
    expect(out).toContain("[thông tin sức khỏe đã ẩn]");
    // The browser gets the names back.
    expect(evs.at(-1)!.data.names).toEqual({ L1: "Nguyễn Văn Khách" });
    const conv = await json(await user(`/api/ai/conversations/${id}`));
    expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.messages[1].content).toBe("Chào bạn, [L1] nên được gọi lại hôm nay.");
    // Reading the lead for the AI is audited.
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "AI_READ"), eq(auditLog.entityId, leadId)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("client context: the client and policy become tokens", async () => {
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "CLIENT", "0000000001");
    await (await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Tóm tắt", task: "LOOKUP" } })).text();
    const out = sent();
    expect(out).not.toContain("Lê Thị An");
    expect(out).not.toContain("0000000001");
    expect(out).not.toContain("009000001");
    expect(out).toContain("[K1]");
    expect(out).toContain("[P1]");
  });

  it("scrubbing keeps product words and removes health sentences", () => {
    const ps = new Pseudonymizer({});
    ps.token("client", "1", "Trần Thị Bình");
    const text = ps.scrub("Chị Trần Thị Bình, Thị Bình thích gốm sứ. Chồng bị huyết áp cao. Quan tâm bảo hiểm sức khỏe và bệnh hiểm nghèo.", true);
    expect(text).toBe("Chị [K1], [K1] thích gốm sứ.[thông tin sức khỏe đã ẩn] Quan tâm bảo hiểm sức khỏe và bệnh hiểm nghèo.");
  });
});

describe("routing and models", () => {
  it("the router picks the task class, and the task class picks the tier's model", async () => {
    router = { task: "ANALYSIS", kb: [], query: "" };
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "LEAD_LIST");
    const evs = await events(await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Lead nào nên ưu tiên?" } }));
    expect(calls[0]!.body.response_format).toBeDefined();
    expect(calls[0]!.body.model).toBe("gemini-3.5-flash-lite");
    expect(calls[1]!.body.model).toBe("gemini-3.1-pro-preview");
    expect(evs[0]!.data).toMatchObject({ task: "ANALYSIS", tier: "DEEP", routedBy: "model" });
  });

  it("quick actions skip the router; an agent's own model and tier override the GA's", async () => {
    const head = await as("head@ga1.test");
    const agents = (await json(await head("/api/ai/admin/agents"))).items as any[];
    const a = agents.find((x) => x.kind === "ASSISTANT");
    const { id: _id, tenantId: _t, createdAt: _c, updatedAt: _u, createdBy: _b, ...rest } = a;
    expect(
      (
        await head(`/api/ai/admin/agents/${a.id}`, {
          method: "PATCH",
          json: { ...rest, models: { FAST: { provider: "QWEN", model: "qwen-flash" } }, taskTiers: { CREATIVE: "FAST" } },
        })
      ).status,
    ).toBe(200);
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "LEAD", leadId);
    await (await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Soạn tin nhắn", task: "CREATIVE" } })).text();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("dashscope-intl.aliyuncs.com");
    expect(calls[0]!.body.model).toBe("qwen-flash");
    await head(`/api/ai/admin/agents/${a.id}`, { method: "PATCH", json: { ...rest } });
  });

  it("falls back to keyword rules when the router answer is unusable", async () => {
    router = "not json";
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    const evs = await events(await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Sắp xếp kế hoạch hôm nay giúp tôi" } }));
    expect(evs[0]!.data).toMatchObject({ task: "PLANNING", routedBy: "rules" });
    expect(ruleRoute("Thủ tục khôi phục hợp đồng?", "OPS")).toMatchObject({ task: "KNOWLEDGE", kb: ["SERVICE"] });
    expect(ruleRoute("cảm ơn", "ASSISTANT").task).toBe("CHAT");
  });

  it("a provider without a key cannot answer", async () => {
    const head = await as("head@ga1.test");
    const s = (await json(await head("/api/ai/admin/settings"))).settings;
    await head("/api/ai/admin/settings", { method: "PUT", json: { ...s, tiers: { ...s.tiers, FAST: { provider: "DEEPSEEK", model: "deepseek-v4-flash" } } } });
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    const evs = await events(await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Tra cứu", task: "LOOKUP" } }));
    expect(evs.at(-1)).toMatchObject({ event: "error", data: { error: "ai_provider_missing" } });
    await head("/api/ai/admin/settings", {
      method: "PUT",
      json: { enabled: s.enabled, tiers: s.tiers, router: s.router, monthlyTokenLimit: s.monthlyTokenLimit },
    });
  });
});

describe("knowledge", () => {
  it("documents are chunked, searched without diacritics and cited; linked bases only", async () => {
    const head = await as("head@ga1.test");
    const kb = (await json(await head("/api/ai/admin/kbs", { json: { name: "Điều khoản sản phẩm", category: "PRODUCT", enabled: true } }))).id;
    const doc = await head(`/api/ai/admin/kbs/${kb}/documents`, {
      json: {
        title: "Quy tắc An Tâm Song Hành",
        productCode: "TMP_CSUT247",
        text: "# Thời gian chờ\nThời gian chờ đối với bệnh hiểm nghèo là 90 ngày kể từ ngày hiệu lực.\n# Loại trừ\nKhông chi trả khi tự tử trong 2 năm đầu.",
      },
    });
    expect(await json(doc)).toMatchObject({ chunks: 2 });
    const found = (await json(await head("/api/ai/admin/search?q=thoi%20gian%20cho%20benh%20hiem%20ngheo"))).items;
    expect(found[0].heading).toBe("Thời gian chờ");
    // Not linked to the operations expert yet: nothing is retrieved.
    router = { task: "KNOWLEDGE", kb: ["PRODUCT"], query: "thời gian chờ bệnh hiểm nghèo" };
    let conv = await start("fc1@ga1.test", "OPS", "GENERAL");
    await (await conv.user(`/api/ai/conversations/${conv.id}/messages`, { json: { text: "Thời gian chờ bệnh hiểm nghèo?" } })).text();
    expect(sent()).not.toContain("90 ngày");
    const ops = ((await json(await head("/api/ai/admin/agents"))).items as any[]).find((x) => x.kind === "OPS");
    const { id: _id, tenantId: _t, createdAt: _c, updatedAt: _u, createdBy: _b, ...rest } = ops;
    await head(`/api/ai/admin/agents/${ops.id}`, { method: "PATCH", json: { ...rest, kbIds: [kb] } });
    calls = [];
    conv = await start("fc1@ga1.test", "OPS", "GENERAL");
    const evs = await events(await conv.user(`/api/ai/conversations/${conv.id}/messages`, { json: { text: "Thời gian chờ bệnh hiểm nghèo?" } }));
    expect(sent()).toContain("[S1] Quy tắc An Tâm Song Hành › Thời gian chờ");
    expect(evs[0]!.data.sources[0]).toMatchObject({ n: 1, title: "Quy tắc An Tâm Song Hành" });
    // Another GA cannot see it.
    expect((await json(await (await as("head@ga2.test"))("/api/ai/admin/search?q=benh%20hiem%20ngheo"))).items).toEqual([]);
  });

  it("splits long text under its headings", () => {
    const parts = splitText(`Điều 1. Phạm vi\n${"Nội dung dài. ".repeat(200)}\nĐiều 2. Hiệu lực\nNgắn.`);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0]!.heading).toBe("Điều 1. Phạm vi");
    expect(parts.at(-1)).toEqual({ heading: "Điều 2. Hiệu lực", body: "Ngắn." });
  });
});

describe("tools", () => {
  it("the model may call CRM tools; results come back pseudonymised", async () => {
    router = { task: "PLANNING", kb: [], query: "" };
    toolPlan = [{ name: "list_leads", arguments: "{}" }];
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "CLIENT", "0000000001");
    const evs = await events(await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Hôm nay tôi nên gọi ai?" } }));
    expect(evs.map((e) => e.event)).toContain("tool");
    const final = calls.at(-1)!.body;
    const toolMsg = final.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("[L1]");
    expect(toolMsg.content).not.toContain("Nguyễn Văn Khách");
    expect(final.messages.find((m: any) => m.tool_calls)?.tool_calls[0].function.name).toBe("list_leads");
  });

  it("get_lead resolves only tokens of this conversation", async () => {
    toolPlan = [{ name: "get_lead", arguments: JSON.stringify({ lead: "L9" }) }];
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    await (await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Xem lead", task: "LOOKUP" } })).text();
    expect(calls.at(-1)!.body.messages.find((m: any) => m.role === "tool").content).toBe("Không tìm thấy lead này.");
  });
});

describe("objection practice", () => {
  it("role-plays without tools or router, then scores once and closes the practice", async () => {
    const { user, id } = await start("fc1@ga1.test", "COACH", "LEAD", undefined, { scenario: "ASK_SPOUSE", difficulty: "HARD", leadId });
    await (await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Chào anh, em là tư vấn viên Dai-ichi." } })).text();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(calls[0]!.body.messages[0].content).toContain("Difficulty HARD");
    expect(calls[0]!.body.messages[0].content).toContain("[L1]");
    expect((await user(`/api/ai/conversations/${id}/score`, { method: "POST" })).status).toBe(400);
    await (
      await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Anh có thể hỏi ý kiến chị, em gửi tài liệu để anh chị cùng xem nhé." } })
    ).text();
    score = {
      overall: 72,
      criteria: ["OPENING", "DISCOVERY", "EMPATHY", "OBJECTION", "LANGUAGE", "CLOSING"].map((key) => ({ key, score: 7, comment: "Ổn" })),
      strengths: ["Lịch sự"],
      improvements: ["Hỏi thêm về gia đình"],
      betterLines: [{ original: "Chào anh", suggestion: "Chào anh, cảm ơn anh đã dành thời gian" }],
      persuasionOptions: ["Mời cả hai vợ chồng gặp"],
      verdict: "Khá tốt.",
    };
    const res = await user(`/api/ai/conversations/${id}/score`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await json(res)).score.overall).toBe(72);
    expect(calls.at(-1)!.body.model).toBe("gemini-3.1-pro-preview");
    expect((await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Tiếp" } })).status).toBe(409);
  });

  it("a malformed score is rejected", async () => {
    const { user, id } = await start("fc1@ga1.test", "COACH", "GENERAL", undefined, { scenario: "NO_MONEY", difficulty: "EASY" });
    for (const text of ["Chào chị", "Chị cho em 5 phút nhé"]) await (await user(`/api/ai/conversations/${id}/messages`, { json: { text } })).text();
    score = { overall: "cao" };
    expect((await user(`/api/ai/conversations/${id}/score`, { method: "POST" })).status).toBe(502);
  });
});

describe("custom agents", () => {
  it("the GA Head creates an agent with its own name, role, abilities and quick prompts", async () => {
    const head = await as("head@ga1.test");
    const res = await head("/api/ai/admin/agents", {
      json: {
        kind: "CUSTOM",
        name: "Chuyên gia tài chính gia đình",
        description: "Lập kế hoạch bảo vệ",
        enabled: true,
        instructions: "Bạn là chuyên gia tài chính gia đình, luôn hỏi về mục tiêu tài chính.",
        contexts: ["GENERAL", "LEAD"],
        models: {},
        taskTiers: {},
        kbIds: [],
        config: { crmData: false, tools: false, quickPrompts: [{ label: "Lập kế hoạch", text: "Lập kế hoạch tài chính cho gia đình 4 người" }] },
      },
    });
    expect(res.status).toBe(201);
    const custom = (await agentsOf("fc1@ga1.test", "LEAD")).find((x) => x.name === "Chuyên gia tài chính gia đình");
    expect(custom).toMatchObject({ kind: "CUSTOM", quickPrompts: [{ label: "Lập kế hoạch" }] });
    expect((await agentsOf("fc1@ga1.test", "CLIENT")).map((x) => x.name)).not.toContain("Chuyên gia tài chính gia đình");

    // No CRM data and no tools: the lead is not read, the role is the GA's.
    router = { task: "PLANNING", kb: [], query: "" };
    const user = await as("fc1@ga1.test");
    const conv = (await json(await user("/api/ai/conversations", { json: { agentId: custom.id, context: "LEAD", contextRef: leadId } }))).id;
    await (await user(`/api/ai/conversations/${conv}/messages`, { json: { text: "Giúp tôi lập kế hoạch" } })).text();
    const answer = calls.at(-1)!.body;
    expect(answer.tools).toBeUndefined();
    expect(answer.messages[0].content).toContain("defined by the GA's instructions");
    expect(answer.messages[0].content).toContain("chuyên gia tài chính gia đình");
    expect(answer.messages[0].content).not.toContain("CRM DATA");
    expect(answer.messages[0].content).not.toContain("LEAD [L1]");
  });
});

describe("provider keys", () => {
  it("a GA stores its own key: encrypted, never returned, used instead of the platform's, invisible to other GAs", async () => {
    const head = await as("head@ga1.test");
    const provider = async (who = head, p = "DEEPSEEK") => ((await json(await who("/api/ai/admin/settings"))).providers as any[]).find((x) => x.provider === p);
    expect(await provider()).toMatchObject({ ready: false, keySource: null });
    expect((await (await as("fc1@ga1.test"))("/api/ai/admin/keys/DEEPSEEK", { method: "PUT", json: { apiKey: "sk-deepseek-ga1-secret-1234" } })).status).toBe(
      403,
    );
    expect((await head("/api/ai/admin/keys/DEEPSEEK", { method: "PUT", json: { apiKey: "sk-deepseek-ga1-secret-1234" } })).status).toBe(200);

    const stored = await db.select().from(aiProviderKeys);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.encryptedKey).not.toContain("secret");
    expect(stored[0]!.last4).toBe("1234");
    const view = await head("/api/ai/admin/settings");
    const text = await view.clone().text();
    expect(text).not.toContain("sk-deepseek");
    expect(await provider()).toMatchObject({ ready: true, keySource: "GA", last4: "1234", keyUnreadable: false });
    const audit = (await db.select().from(auditLog).where(eq(auditLog.entity, "ai_provider_key")))[0]!;
    expect(audit.meta).not.toContain("secret");

    // Answers on a DeepSeek model now use the GA's key.
    const s = (await json(await head("/api/ai/admin/settings"))).settings;
    await head("/api/ai/admin/settings", { method: "PUT", json: { ...s, tiers: { ...s.tiers, FAST: { provider: "DEEPSEEK", model: "deepseek-v4-flash" } } } });
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    calls = [];
    await (await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Tra cứu", task: "LOOKUP" } })).text();
    expect(calls[0]!.url).toContain("api.deepseek.com");
    expect(calls[0]!.auth).toBe("Bearer sk-deepseek-ga1-secret-1234");
    // A GA key also overrides the platform key; GA-2 keeps the platform's.
    await head("/api/ai/admin/keys/GEMINI", { method: "PUT", json: { apiKey: "sk-gemini-ga1-5678" } });
    calls = [];
    expect((await json(await head("/api/ai/admin/keys/GEMINI/test", { method: "POST" }))).model).toBe("gemini-3.5-flash-lite");
    expect(calls[0]!.auth).toBe("Bearer sk-gemini-ga1-5678");
    expect(await provider(await as("head@ga2.test"), "GEMINI")).toMatchObject({ keySource: "PLATFORM", last4: null });
    expect(await provider(await as("head@ga2.test"))).toMatchObject({ keySource: null });

    // A rejected key is reported as such.
    await head("/api/ai/admin/keys/GEMINI", { method: "PUT", json: { apiKey: "sk-bad-key-0000" } });
    const bad = await head("/api/ai/admin/keys/GEMINI/test", { method: "POST" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("ai_key_invalid");

    // Removing the GA's key falls back to the platform's.
    expect((await head("/api/ai/admin/keys/GEMINI", { method: "DELETE" })).status).toBe(204);
    expect(await provider(head, "GEMINI")).toMatchObject({ keySource: "PLATFORM" });
    await head("/api/ai/admin/keys/DEEPSEEK", { method: "DELETE" });
    await head("/api/ai/admin/settings", {
      method: "PUT",
      json: { enabled: s.enabled, tiers: s.tiers, router: s.router, monthlyTokenLimit: s.monthlyTokenLimit },
    });
  });
});

describe("models", () => {
  it("the settings page gets the provider's live chat models; a retired model is reported clearly", async () => {
    const head = await as("head@ga1.test");
    expect((await json(await head("/api/ai/admin/keys/GEMINI/models"))).items).toEqual(["gemini-3.1-pro-preview", "gemini-3.5-flash"]);
    expect((await json(await head("/api/ai/admin/keys/DEEPSEEK/models"))).error).toBe("ai_provider_missing");
    const s = (await json(await head("/api/ai/admin/settings"))).settings;
    await head("/api/ai/admin/settings", { method: "PUT", json: { ...s, tiers: { ...s.tiers, FAST: { provider: "GEMINI", model: "retired-model" } } } });
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    const evs = await events(await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Tra cứu", task: "LOOKUP" } }));
    expect(evs.at(-1)).toMatchObject({ event: "error", data: { error: "ai_model_unavailable" } });
    await head("/api/ai/admin/settings", {
      method: "PUT",
      json: { enabled: s.enabled, tiers: s.tiers, router: s.router, monthlyTokenLimit: s.monthlyTokenLimit },
    });
  });
});

describe("documents", () => {
  it("title and product code can be changed after upload, within the GA only", async () => {
    const head = await as("head@ga1.test");
    const kb = (await json(await head("/api/ai/admin/kbs", { json: { name: "Dịch vụ", category: "SERVICE", enabled: true } }))).id;
    const doc = (await json(await head(`/api/ai/admin/kbs/${kb}/documents`, { json: { title: "scan_001", text: "Khôi phục hợp đồng trong 24 tháng." } }))).id;
    expect(
      (await head(`/api/ai/admin/documents/${doc}`, { method: "PATCH", json: { title: "Quy trình khôi phục hợp đồng", productCode: "ABC" } })).status,
    ).toBe(200);
    const docs = (await json(await head(`/api/ai/admin/kbs/${kb}/documents`))).items;
    expect(docs[0]).toMatchObject({ title: "Quy trình khôi phục hợp đồng", productCode: "ABC", chunks: 1 });
    // The new title is what the assistant cites.
    expect((await json(await head("/api/ai/admin/search?q=khoi%20phuc"))).items[0].title).toBe("Quy trình khôi phục hợp đồng");
    expect((await head(`/api/ai/admin/documents/${doc}`, { method: "PATCH", json: { title: "" } })).status).toBe(400);
    expect((await (await as("head@ga2.test"))(`/api/ai/admin/documents/${doc}`, { method: "PATCH", json: { title: "X" } })).status).toBe(404);
    expect((await (await as("fc1@ga1.test"))(`/api/ai/admin/documents/${doc}`, { method: "PATCH", json: { title: "X" } })).status).toBe(403);
  });
});

describe("budget and usage", () => {
  it("usage is reported per user, agent, model and task; the monthly limit stops new questions", async () => {
    const head = await as("head@ga1.test");
    const usage = await json(await head("/api/ai/admin/usage"));
    expect(usage.byUser.find((u: any) => u.name === "Nguyễn Thị Demo").answers).toBeGreaterThan(3);
    expect(usage.byModel.map((m: any) => m.key)).toContain("GEMINI · gemini-3.1-pro-preview");
    const s = (await json(await head("/api/ai/admin/settings"))).settings;
    await head("/api/ai/admin/settings", { method: "PUT", json: { enabled: true, tiers: s.tiers, router: s.router, monthlyTokenLimit: 10 } });
    const { user, id } = await start("fc1@ga1.test", "ASSISTANT", "GENERAL");
    const res = await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Xin chào" } });
    expect(res.status).toBe(429);
    expect((await json(res)).error).toBe("ai_budget_exceeded");
    await head("/api/ai/admin/settings", { method: "PUT", json: { enabled: false, tiers: s.tiers, router: s.router, monthlyTokenLimit: 0 } });
    expect((await user(`/api/ai/conversations/${id}/messages`, { json: { text: "Xin chào" } })).status).toBe(403);
  });
});

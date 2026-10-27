import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { agents, clients, crmActivities, leadComments, leads, leadTasks, users } from "../../db/schema";
import { vnToday } from "../../shared/coverage";
import { vi } from "../../i18n/vi";
import { clientOfAgents, clientInScope, inTenant, visibleLeads, type Scope } from "../scope";
import { loadClient360, signalSql, SIGNALS } from "../routes/clients";
import type { Pseudonymizer } from "./pseudonyms";

/**
 * CRM data as the assistant sees it: compact Vietnamese text, scoped exactly like the
 * screens (scope.ts), with every person replaced by a token (pseudonyms.ts).
 * Each builder returns the entities it read, for the AI_READ audit row.
 */

export type Built = {
  text: string;
  read: { entity: "lead" | "client"; id: string }[];
  /** Products the person holds or is interested in: product documents rank first in knowledge search. */
  productCodes?: string[];
};

const day = 86_400_000;
const daysAgo = (iso: string | null | undefined) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / day)) : null);
const ago = (iso: string | null | undefined) => {
  const d = daysAgo(iso);
  return d === null ? "chưa" : d === 0 ? "hôm nay" : `${d} ngày trước`;
};
const vnd = (n: number | null | undefined) => (n ? `${Math.round(n / 1000).toLocaleString("vi-VN")}k đ` : "");
const ageOf = (dob: string | null | undefined) => {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const today = vnToday();
  let age = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  if (today.slice(5) < dob.slice(5)) age--;
  return age;
};
/** Birthday as distance, not as a date (dd/mm in clients.birth_day_month). */
function birthdayHint(dayMonth: string | null | undefined): string | null {
  const m = dayMonth?.match(/^(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const today = vnToday();
  let next = `${today.slice(0, 4)}-${m[2]}-${m[1]}`;
  if (next < today) next = `${Number(today.slice(0, 4)) + 1}-${m[2]}-${m[1]}`;
  const days = Math.round((Date.parse(next) - Date.parse(today)) / day);
  return days === 0 ? "sinh nhật hôm nay" : days <= 60 ? `sinh nhật sau ${days} ngày` : `sinh nhật tháng ${Number(m[2])}`;
}
const line = (parts: (string | number | null | undefined | false)[]) => parts.filter((p) => p !== 0 && !!p).join(" · ");

async function userNames(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; agentCode: string | null }>();
  const rows = await db
    .select({ id: users.id, name: users.name, agentCode: users.agentCode })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)].slice(0, 90)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Who wrote something: "bạn" for the FC, a token for colleagues. */
const author = (ps: Pseudonymizer, scope: Scope, u: { name: string; agentCode: string | null } | undefined, id: string) =>
  id === scope.userId ? "bạn" : ps.token("agent", u?.agentCode ?? id, u?.name ?? "");

/* ---------- One lead ---------- */

export async function leadContext(db: Db, scope: Scope, id: string, ps: Pseudonymizer): Promise<Built | null> {
  const lead = await db
    .select()
    .from(leads)
    .where(and(visibleLeads(scope), eq(leads.id, id)))
    .get();
  if (!lead) return null;
  const [acts, comments, tasks] = await Promise.all([
    db
      .select()
      .from(crmActivities)
      .where(and(inTenant(scope, crmActivities), eq(crmActivities.leadId, id)))
      .orderBy(asc(crmActivities.occurredAt))
      .limit(60),
    db
      .select()
      .from(leadComments)
      .where(and(inTenant(scope, leadComments), eq(leadComments.leadId, id)))
      .orderBy(asc(leadComments.createdAt))
      .limit(30),
    db
      .select()
      .from(leadTasks)
      .where(and(inTenant(scope, leadTasks), eq(leadTasks.leadId, id), eq(leadTasks.status, "OPEN")))
      .orderBy(asc(leadTasks.dueAt)),
  ]);
  const names = await userNames(db, [...acts.map((a) => a.createdBy), ...comments.map((c) => c.authorUserId)]);
  const t = ps.token("lead", lead.id, lead.fullName);
  const age = lead.age ?? ageOf(lead.dob);
  const L = vi.leads;
  const out = [
    `LEAD ${t}`,
    line([
      age ? `${age} tuổi` : lead.ageBand && `nhóm tuổi ${lead.ageBand}`,
      lead.gender,
      lead.region && `khu vực ${lead.region}`,
      lead.province,
      `nguồn ${lead.source}`,
      lead.phoneSource && `cách lấy số: ${lead.phoneSource}`,
      lead.origin === "FC_OWN" && "lead tự khai thác",
    ]),
    line([
      `nhận lead ${ago(lead.assignedAt ?? lead.leadDate)}`,
      `giai đoạn: ${L.stages[lead.stage]}`,
      `nhu cầu: ${lead.interest ? L.interests[lead.interest] : "chưa phân loại"}`,
      `trạng thái: ${lead.careStatus ? L.careStatuses[lead.careStatus] : "chưa có"}`,
      lead.lostReason && `lý do chốt xịt: ${ps.scrub(lead.lostReason, true)}`,
    ]),
    line([
      lead.productInterest && `quan tâm sản phẩm: ${lead.productInterest}`,
      lead.productSecondary && `sản phẩm phụ: ${lead.productSecondary}`,
      lead.valueVnd && `giá trị dự kiến ${vnd(lead.valueVnd)}`,
      `liên hệ lần đầu: ${ago(lead.firstContactAt)}`,
      `gần nhất: ${ago(lead.lastContactAt)}`,
    ]),
    lead.need && `Nhu cầu ghi nhận: ${ps.scrub(lead.need, true)}`,
    lead.extraInfo && `Thông tin thêm: ${ps.scrub(lead.extraInfo, true)}`,
    lead.progressNote && `Tiến độ (file GA): ${ps.scrub(lead.progressNote, true)}`,
    acts.length ? "Ghi chú và liên hệ (cũ → mới):" : "Chưa có ghi chú hay liên hệ.",
    ...acts.map(
      (a) =>
        `- ${a.occurredAt.slice(0, 10)} ${vi.leads.activityTypes[a.type]} (${author(ps, scope, names.get(a.createdBy), a.createdBy)})${a.outcome ? ` [${a.outcome}]` : ""}: ${ps.scrub(a.note, true) || "—"}`,
    ),
    comments.length ? "Góp ý của quản lý (cũ → mới):" : null,
    ...comments.map((c) => `- ${c.createdAt.slice(0, 10)} ${author(ps, scope, names.get(c.authorUserId), c.authorUserId)}: ${ps.scrub(c.body, true)}`),
    tasks.length ? "Việc đang mở:" : null,
    ...tasks.map((k) => `- ${k.title}, hạn ${k.dueAt.slice(0, 16).replace("T", " ")}${k.dueAt < new Date().toISOString() ? " (quá hạn)" : ""}`),
  ];
  return { text: out.filter(Boolean).join("\n"), read: [{ entity: "lead", id: lead.id }] };
}

/* ---------- One client (client 360) ---------- */

export async function clientContext(db: Db, scope: Scope, code: string, ps: Pseudonymizer): Promise<Built | null> {
  let d: Awaited<ReturnType<typeof loadClient360>>;
  try {
    d = await loadClient360(db, scope, code);
  } catch {
    return null;
  }
  const c = d.client;
  const C = vi.clients;
  const t = ps.token("client", code, c.name);
  const person = (p: string) => (p === code ? t : ps.token("client", p, d.clientNames[p] ?? ""));
  const policy = (no: string) => ps.token("policy", no, no);
  const names = await userNames(db, d.notes.map((n) => n.createdBy).concat(d.activities.map((a) => a.createdBy)));
  const coverage = (cov: (typeof d)["coverage"]) =>
    !cov.covered
      ? "chưa có bảo hiểm đang hiệu lực"
      : !cov.hasDetail
        ? `${cov.activePolicies.length} HĐ đang hiệu lực, chưa có chi tiết sản phẩm`
        : line([
            ...Object.entries(cov.groups).map(([g, sum]) => `${C.groups[g as keyof typeof C.groups]} ${vnd(sum)}`),
            cov.gaps?.length ? `CHƯA CÓ: ${cov.gaps.map((g) => C.groups[g]).join(", ")}` : null,
          ]);
  const out = [
    `KHÁCH HÀNG ${t}`,
    line([
      ageOf(c.dob) ? `${ageOf(c.dob)} tuổi` : c.ageBand && `nhóm tuổi ${c.ageBand}`,
      c.gender,
      c.maritalStatus,
      c.tier && `hạng ${c.tier}`,
      birthdayHint(c.birthDayMonth),
      c.usesDconnect === false ? "chưa dùng D-Connect" : c.usesDconnect ? "có dùng D-Connect" : null,
    ]),
    `Quyền lợi của ${t}: ${coverage(d.coverage)}`,
    d.coverage.items.length
      ? `Sản phẩm của ${t}: ${d.coverage.items.map((i) => `${i.productName} (${C.groups[i.group]}, STBH ${vnd(i.sumAssuredVnd)})`).join("; ")}`
      : null,
    "Hợp đồng:",
    ...d.policies.map((p) =>
      line([
        `- ${policy(p.policyNo)}`,
        p.status,
        `vai trò: ${p.roles.map((r) => C.roles[r as keyof typeof C.roles] ?? r).join(", ")}`,
        `hiệu lực từ ${p.effectiveDate}`,
        p.plannedPremiumVnd && `phí ${vnd(p.plannedPremiumVnd)}/${p.premiumFrequency ?? "kỳ"}`,
        p.premiumDueDate && `hạn phí ${p.premiumDueDate}`,
        p.maturityDate && `đáo hạn ${p.maturityDate}`,
        (p.unpaidPremiumVnd ?? 0) > 0 && `nợ phí ${vnd(p.unpaidPremiumVnd)}`,
        (p.aplDebtVnd ?? 0) > 0 && `nợ APL ${vnd(p.aplDebtVnd)}`,
        p.products.length > 0 && `SP: ${p.products.map((pp) => `${pp.productName ?? pp.productCode} [${pp.productCode}]`).join(", ")}`,
      ]),
    ),
    d.family.length ? "Gia đình:" : "Chưa ghi nhận người thân.",
    ...d.family.map((m) =>
      m.kind === "CLIENT"
        ? line([
            `- ${person(m.clientCode)}`,
            m.label ? C.relations[m.label.relation] : "có chung hợp đồng",
            m.gender,
            ageOf(m.dob) ? `${ageOf(m.dob)} tuổi` : m.ageBand,
            m.isClient ? "là khách hàng" : "chỉ có trên hợp đồng",
            `quyền lợi: ${coverage(m.coverage)}`,
          ])
        : line([
            `- ${ps.token("relative", m.id, m.name)}`,
            C.relations[m.relation],
            m.gender,
            m.birthYear && `${Number(vnToday().slice(0, 4)) - m.birthYear} tuổi`,
            "chưa là khách hàng",
            m.note && ps.scrub(m.note, true),
          ]),
    ),
    d.signals.length ? "Tín hiệu chăm sóc:" : null,
    ...d.signals.map((s) =>
      line([
        `- ${s.kind}`,
        s.policyNo && policy(s.policyNo),
        s.date && s.kind !== "BIRTHDAY" && s.date,
        s.amount && s.kind !== "LAPSED" && vnd(s.amount),
        s.name && s.kind !== "NOT_ACTIVE" ? ps.scrub(s.name) : s.name,
        s.groups?.map((g) => C.groups[g as keyof typeof C.groups]).join(", "),
      ]),
    ),
    d.applications.length
      ? `Hồ sơ YCBH: ${d.applications.map((a) => line([a.productCode, a.status, a.createdDate, a.apeVnd && `APE ${vnd(a.apeVnd)}`])).join("; ")}`
      : null,
    d.notes.length || d.activities.length ? "Ghi chú và liên hệ (cũ → mới):" : "Chưa có ghi chú.",
    ...[...d.notes, ...d.activities]
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .slice(-40)
      .map(
        (a) =>
          `- ${a.occurredAt.slice(0, 10)} ${vi.leads.activityTypes[a.type]} (${author(ps, scope, names.get(a.createdBy), a.createdBy)}): ${ps.scrub(a.note, true) || "—"}`,
      ),
  ];
  const productCodes = [...new Set(d.policies.flatMap((p) => p.products.map((pp) => pp.productCode)))];
  return { text: out.filter(Boolean).join("\n"), read: [{ entity: "client", id: code }], productCodes };
}

/* ---------- Lists ---------- */

const HOURS_48 = 48 * 3600 * 1000;

/** The FC's leads (managers: their line) that matter most now, newest activity last. */
export async function leadListContext(
  db: Db,
  scope: Scope,
  ps: Pseudonymizer,
  opts: { view?: "all" | "overdue" | "new" | "caring"; limit?: number } = {},
): Promise<Built> {
  const now = new Date().toISOString();
  const overdue = sql`(${leads.assignedAgentCode} is not null and ${leads.firstContactAt} is null and ${leads.interest} is null and ${leads.careStatus} is null and ${leads.assignedAt} < ${new Date(Date.now() - HOURS_48).toISOString()})`;
  const open = sql`(${leads.careStatus} is null or ${leads.careStatus} = 'CARING')`;
  const mine = scope.agentCode ? eq(leads.assignedAgentCode, scope.agentCode) : undefined;
  const where = and(
    visibleLeads(scope),
    scope.reach === "OWN" ? mine : undefined,
    open,
    opts.view === "overdue"
      ? overdue
      : opts.view === "new"
        ? sql`${leads.assigneeSeenAt} is null`
        : opts.view === "caring"
          ? eq(leads.careStatus, "CARING")
          : undefined,
  );
  const rows = await db
    .select({
      id: leads.id,
      fullName: leads.fullName,
      source: leads.source,
      leadDate: leads.leadDate,
      assignedAt: leads.assignedAt,
      stage: leads.stage,
      interest: leads.interest,
      careStatus: leads.careStatus,
      productInterest: leads.productInterest,
      firstContactAt: leads.firstContactAt,
      lastContactAt: leads.lastContactAt,
      nextActionAt: leads.nextActionAt,
      agentCode: leads.assignedAgentCode,
      agentName: agents.name,
      age: leads.age,
      overdue: sql<number>`${overdue}`,
      contacts: sql<number>`(select count(*) from crm_activities ca where ca.tenant_id = ${leads.tenantId} and ca.lead_id = ${leads.id} and ca.type <> 'NOTE')`,
    })
    .from(leads)
    .leftJoin(agents, and(eq(agents.tenantId, leads.tenantId), eq(agents.agentCode, leads.assignedAgentCode)))
    .where(where)
    .orderBy(desc(sql`${overdue}`), sql`coalesce(${leads.nextActionAt}, '9999')`, desc(leads.assignedAt))
    .limit(opts.limit ?? 40);
  const L = vi.leads;
  const out = [
    `DANH SÁCH LEAD ĐANG MỞ (${rows.length} lead${rows.length === (opts.limit ?? 40) ? ", ưu tiên nhất trước" : ""}; ${now.slice(0, 10)}):`,
    ...rows.map((r) =>
      line([
        `- ${ps.token("lead", r.id, r.fullName)}`,
        r.age && `${r.age} tuổi`,
        r.source,
        `nhận ${ago(r.assignedAt ?? r.leadDate)}`,
        L.stages[r.stage],
        r.interest ? L.interests[r.interest] : "chưa phân loại",
        r.careStatus && L.careStatuses[r.careStatus],
        r.productInterest,
        `${r.contacts} lần liên hệ, gần nhất ${ago(r.lastContactAt)}`,
        r.nextActionAt && `hẹn ${r.nextActionAt.slice(0, 10)}`,
        r.overdue ? "QUÁ 48 GIỜ CHƯA LIÊN HỆ" : null,
        scope.reach !== "OWN" && r.agentCode !== scope.agentCode && r.agentCode ? `FC ${ps.token("agent", r.agentCode, r.agentName)}` : null,
      ]),
    ),
  ];
  return { text: out.join("\n"), read: [] };
}

/** The FC's own clients with care signals first. */
export async function clientListContext(
  db: Db,
  scope: Scope,
  ps: Pseudonymizer,
  opts: { signal?: (typeof SIGNALS)[number]; limit?: number } = {},
): Promise<Built> {
  const today = vnToday();
  const own = scope.agentCode ? clientOfAgents(scope, clients.clientCode, [scope.agentCode]) : clientInScope(scope, clients.clientCode);
  const flags = Object.fromEntries(SIGNALS.map((s) => [s, sql<number>`case when ${signalSql(scope, s, today)} then 1 else 0 end`]));
  const rows = await db
    .select({
      clientCode: clients.clientCode,
      name: clients.name,
      tier: clients.tier,
      dob: clients.dob,
      gender: clients.gender,
      ageBand: clients.ageBand,
      activePolicies: clients.activePolicies,
      birthDayMonth: clients.birthDayMonth,
      ...flags,
    })
    .from(clients)
    .where(and(inTenant(scope, clients), own, opts.signal ? signalSql(scope, opts.signal, today) : undefined))
    .orderBy(desc(sql`${sql.join(Object.values(flags), sql` + `)}`), clients.nameNorm)
    .limit(opts.limit ?? 40);
  const label: Record<string, string> = {
    due: "đến hạn phí 30 ngày",
    debt: "nợ phí/APL",
    maturity: "đáo hạn 12 tháng",
    birthday: "sinh nhật tháng này",
    lapsed: "có HĐ mất hiệu lực",
  };
  const out = [
    `DANH SÁCH KHÁCH HÀNG CỦA BẠN (${rows.length}, có tín hiệu trước):`,
    ...rows.map((r) =>
      line([
        `- ${ps.token("client", r.clientCode, r.name)}`,
        ageOf(r.dob) ? `${ageOf(r.dob)} tuổi` : r.ageBand,
        r.gender,
        r.tier,
        `${r.activePolicies ?? 0} HĐ hiệu lực`,
        SIGNALS.filter((s) => (r as unknown as Record<string, number>)[s])
          .map((s) => label[s])
          .join(", "),
      ]),
    ),
  ];
  return { text: out.join("\n"), read: [] };
}

/* ---------- The FC's day ---------- */

export async function myDayContext(db: Db, scope: Scope, ps: Pseudonymizer): Promise<Built> {
  const today = vnToday();
  // End of today in Vietnam (UTC+7), as UTC ISO.
  const endOfDay = new Date(Date.parse(`${today}T23:59:59+07:00`)).toISOString();
  const tasks = scope.agentCode
    ? await db
        .select({ title: leadTasks.title, dueAt: leadTasks.dueAt, leadId: leadTasks.leadId, name: leads.fullName })
        .from(leadTasks)
        .innerJoin(leads, and(eq(leads.tenantId, leadTasks.tenantId), eq(leads.id, leadTasks.leadId)))
        .where(
          and(
            inTenant(scope, leadTasks),
            eq(leadTasks.agentCode, scope.agentCode),
            eq(leadTasks.status, "OPEN"),
            lte(leadTasks.dueAt, addDaysIso(endOfDay, 1)),
          ),
        )
        .orderBy(asc(leadTasks.dueAt))
        .limit(30)
    : [];
  const unread = scope.agentCode
    ? await db
        .select({ id: leads.id, name: leads.fullName })
        .from(leads)
        .where(
          and(
            inTenant(scope, leads),
            eq(leads.assignedAgentCode, scope.agentCode),
            sql`${leads.lastCommentAt} is not null and ${leads.lastCommentBy} <> ${scope.userId} and ${leads.lastCommentAt} > coalesce(${leads.assigneeViewedAt}, '')`,
          ),
        )
        .limit(20)
    : [];
  const [leadList, clientList] = await Promise.all([
    leadListContext(db, scope, ps, { limit: 15 }),
    scope.reach === "NONE" ? Promise.resolve({ text: "", read: [] }) : clientListContext(db, scope, ps, { limit: 15 }),
  ]);
  const out = [
    `HÔM NAY ${today} (giờ Việt Nam).`,
    tasks.length ? "Việc cần làm đến hết ngày mai:" : "Không có việc đến hạn đến hết ngày mai.",
    ...tasks.map(
      (k) =>
        `- ${k.dueAt < new Date().toISOString() ? "QUÁ HẠN " : ""}${k.dueAt.slice(0, 16).replace("T", " ")} UTC: ${k.title} (lead ${ps.token("lead", k.leadId, k.name)})`,
    ),
    unread.length ? `Lead có góp ý mới chưa đọc: ${unread.map((u) => ps.token("lead", u.id, u.name)).join(", ")}` : null,
    leadList.text,
    clientList.text,
  ];
  return { text: out.filter(Boolean).join("\n"), read: [] };
}

const addDaysIso = (iso: string, n: number) => new Date(Date.parse(iso) + n * day).toISOString();

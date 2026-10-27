import { sql, type SQL } from "drizzle-orm";
import { SHEETS } from "../../shared/import/template";
import { vi } from "../../i18n/vi";
import { field } from "./sql";

const raw = sql.raw;
const def = SHEETS["13_Leads"];

/** A UUID v4 made by SQLite, for rows created set-based. */
export const SQL_UUID = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;

/**
 * When a lead row was last updated, as UTC ISO: its NGÀY CẬP NHẬT LEAD at 00:00 Vietnam time
 * (the file has no time of day, so on the same day a CRM change wins). Null when the row has no date.
 */
export const leadRowTime = (row: string) =>
  `(case when ${field(row, "lead_date")} is not null then strftime('%Y-%m-%dT%H:%M:%fZ', ${field(row, "lead_date")} || ' 00:00:00', '-7 hours') end)`;

/**
 * Stage implied by care status and interest (same rule as stageFor() in shared/enums.ts),
 * as SQL over the new care status, the new interest and the current stage.
 */
const stageSql = (care: string, interest: string, current: string) => `case
  when ${care} = 'WON' then case when ${current} = 'ISSUED' then 'ISSUED' else 'SUBMITTED' end
  when ${care} in ('DROPPED', 'NOT_INTERESTED') then 'LOST'
  when ${current} in ('LOST', 'NEW') then case when ${interest} is not null or ${care} is not null then 'CONTACTED' else ${current} end
  else ${current} end`;

/**
 * Statements that write the staged 13_Leads rows: campaigns, lead history and activities,
 * and the leads themselves (matched by phone). An empty cell never wipes what the CRM already
 * has. Rows older than the CRM's data were set aside in validate.ts (the later record wins).
 */
export function leadStatements(importId: string, present: readonly number[], userId: string, now: string) {
  const cols = new Set(present.map((i) => def.columns[i]!.db));
  const has = (c: string) => cols.has(c);
  const staged = sql`r.import_id = ${importId} and r.sheet = '13_Leads' and r.status = 'OK'`;
  const join = raw(`join leads t on t.tenant_id = r.tenant_id and t.phone = ${field("r", "phone")}`);
  const N = (c: string) => field("r", c);
  const keep = (c: string) => `coalesce(${N(c)}, t.${c})`;
  // The time of the change: the row's update date, or the import time when it has none.
  const at = has("lead_date") ? `coalesce(${leadRowTime("r")}, ${q(now)})` : q(now);
  const before: SQL[] = [];
  const after: SQL[] = [];

  if (has("campaign_name")) {
    before.push(sql`
      insert into campaigns (id, tenant_id, name, type, status, created_at)
      select ${raw(SQL_UUID)}, tenant_id, name, 'OTHER', 'ACTIVE', ${now}
      from (select distinct r.tenant_id as tenant_id, trim(${raw(N("campaign_name"))}) as name from import_rows r
            where ${staged} and trim(coalesce(${raw(N("campaign_name"))}, '')) <> '') where true
      on conflict (tenant_id, name) do nothing`);
  }

  // History of existing leads, before their values change.
  const history = (fieldName: string, oldSql: string, newSql: string) =>
    sql`insert into lead_history (id, tenant_id, lead_id, field, old_value, new_value, import_id, changed_by, changed_at)
      select ${raw(SQL_UUID)}, t.tenant_id, t.id, ${fieldName}, ${raw(oldSql)}, ${raw(newSql)}, ${importId}, ${userId}, ${raw(at)}
      from import_rows r ${join} where ${staged} and ${raw(`${newSql} is not null and ${oldSql} is not ${newSql}`)}`;
  if (has("interest")) before.push(history("interest", "t.interest", N("interest")));
  if (has("care_status")) before.push(history("care_status", "t.care_status", N("care_status")));
  if (has("assigned_agent_code")) before.push(history("assignee", "t.assigned_agent_code", N("assigned_agent_code")));
  if (has("interest") || has("care_status")) {
    const next = stageSql(has("care_status") ? keep("care_status") : "t.care_status", has("interest") ? keep("interest") : "t.interest", "t.stage");
    before.push(history("stage", "t.stage", next));
  }
  if (has("progress_note")) {
    before.push(sql`
      insert into crm_activities (id, tenant_id, agent_code, lead_id, type, note, occurred_at, source, created_by, created_at)
      select ${raw(SQL_UUID)}, t.tenant_id, ${raw(has("assigned_agent_code") ? keep("assigned_agent_code") : "t.assigned_agent_code")},
             t.id, 'NOTE', ${raw(N("progress_note"))}, ${raw(at)}, 'IMPORT', ${userId}, ${now}
      from import_rows r ${join} where ${staged} and ${raw(`${N("progress_note")} is not null and t.progress_note is not ${N("progress_note")}`)}`);
  }

  // The upsert. Columns from the file, then the ones the CRM derives.
  const fileCols = [...cols].filter((c) => c !== "campaign_name" && c !== "phone");
  const derived: [string, string, string][] = [
    // [column, value on insert (over r), value on update (over excluded / leads)]
    ["name_norm", N("name_norm"), "excluded.name_norm"],
    ["lead_date", has("lead_date") ? `coalesce(${N("lead_date")}, substr(${q(now)}, 1, 10))` : `substr(${q(now)}, 1, 10)`, "coalesce(leads.lead_date, excluded.lead_date)"],
    [
      "campaign_id",
      has("campaign_name") ? `(select c.id from campaigns c where c.tenant_id = r.tenant_id and c.name = trim(${N("campaign_name")}))` : "null",
      "coalesce(excluded.campaign_id, leads.campaign_id)",
    ],
    [
      "stage",
      stageSql(has("care_status") ? N("care_status") : "null", has("interest") ? N("interest") : "null", "'NEW'"),
      stageSql("coalesce(excluded.care_status, leads.care_status)", "coalesce(excluded.interest, leads.interest)", "leads.stage"),
    ],
    [
      "assigned_by",
      has("assigned_agent_code") ? `case when ${N("assigned_agent_code")} is not null then ${q(userId)} end` : "null",
      "case when excluded.assigned_agent_code is not null and excluded.assigned_agent_code is not leads.assigned_agent_code then excluded.assigned_by else leads.assigned_by end",
    ],
    [
      "assigned_at",
      has("assigned_agent_code") ? `case when ${N("assigned_agent_code")} is not null then ${at} end` : "null",
      "case when excluded.assigned_agent_code is not null and excluded.assigned_agent_code is not leads.assigned_agent_code then excluded.assigned_at else leads.assigned_at end",
    ],
    [
      "assignee_seen_at",
      "null",
      "case when excluded.assigned_agent_code is not null and excluded.assigned_agent_code is not leads.assigned_agent_code then null else leads.assignee_seen_at end",
    ],
    // Consent is only ever granted by a file, never withdrawn.
    ["consent_marketing", has("consent_marketing") ? `coalesce(${N("consent_marketing")}, 0)` : "0", "max(leads.consent_marketing, excluded.consent_marketing)"],
    ["consent_source", has("consent_marketing") ? `case when ${N("consent_marketing")} = 1 then 'IMPORT' end` : "null", "coalesce(leads.consent_source, excluded.consent_source)"],
    ["consent_at", has("consent_marketing") ? `case when ${N("consent_marketing")} = 1 then ${q(now)} end` : "null", "coalesce(leads.consent_at, excluded.consent_at)"],
    ["origin", "'IMPORT'", "leads.origin"],
    ["created_by", q(userId), "leads.created_by"],
    ["created_at", q(now), "leads.created_at"],
    ["updated_at", at, "excluded.updated_at"],
    ["last_import_id", q(importId), "excluded.last_import_id"],
  ];
  const plain = fileCols.filter((c) => !derived.some(([d]) => d === c));
  const insertCols = ["id", "tenant_id", "phone", ...plain, ...derived.map(([c]) => c)];
  const values = [SQL_UUID, "r.tenant_id", N("phone"), ...plain.map(N), ...derived.map(([, v]) => v)];
  const updates = [
    // An empty cell keeps the current value.
    ...plain.map((c) => `${c} = coalesce(excluded.${c}, leads.${c})`),
    ...derived.filter(([c]) => c !== "created_by" && c !== "created_at").map(([c, , u]) => `${c} = ${u}`),
  ];
  const upsert = sql`${raw(`insert into leads (${insertCols.join(", ")}) select ${values.join(", ")} from import_rows r`)}
    where ${staged}
    ${raw(`on conflict (tenant_id, phone) do update set ${updates.join(", ")}`)}`;

  // Leads created by this import: their first assignment and note.
  const created = raw(`join leads t on t.tenant_id = r.tenant_id and t.phone = ${field("r", "phone")} and t.created_at = ${q(now)} and t.last_import_id = ${q(importId)}`);
  if (has("assigned_agent_code")) {
    after.push(sql`
      insert into lead_history (id, tenant_id, lead_id, field, old_value, new_value, import_id, changed_by, changed_at)
      select ${raw(SQL_UUID)}, t.tenant_id, t.id, 'assignee', null, t.assigned_agent_code, ${importId}, ${userId}, t.updated_at
      from import_rows r ${created} where ${staged} and t.assigned_agent_code is not null`);
  }
  if (has("progress_note")) {
    after.push(sql`
      insert into crm_activities (id, tenant_id, agent_code, lead_id, type, note, occurred_at, source, created_by, created_at)
      select ${raw(SQL_UUID)}, t.tenant_id, t.assigned_agent_code, t.id, 'NOTE', t.progress_note, t.updated_at, 'IMPORT', ${userId}, ${now}
      from import_rows r ${created} where ${staged} and t.progress_note is not null`);
  }
  if (has("assigned_agent_code")) {
    // A lead given to an agent by this import: cancel the previous agent's open contact task,
    // and give the new one "contact within 48 h", unless the lead was already contacted.
    const assignedHere = `t.last_import_id = ${q(importId)} and t.assigned_agent_code is not null and t.assigned_at = ${at}`;
    after.push(sql`
      update lead_tasks set status = 'CANCELLED'
      where status = 'OPEN' and source = 'AUTO_ASSIGN' and exists (
        select 1 from import_rows r ${join} where ${staged} and ${raw(assignedHere)}
          and lead_tasks.lead_id = t.id and lead_tasks.tenant_id = t.tenant_id and lead_tasks.agent_code is not t.assigned_agent_code)`);
    after.push(sql`
      insert into lead_tasks (id, tenant_id, lead_id, agent_code, title, due_at, status, source, created_by, created_at)
      select ${raw(SQL_UUID)}, t.tenant_id, t.id, t.assigned_agent_code, ${vi.leads.autoTasks.contact},
             strftime('%Y-%m-%dT%H:%M:%fZ', t.assigned_at, '+48 hours'), 'OPEN', 'AUTO_ASSIGN', ${userId}, ${now}
      from import_rows r ${join} where ${staged} and ${raw(assignedHere)}
        and t.first_contact_at is null and t.interest is null and t.care_status is null
        and not exists (select 1 from lead_tasks x where x.tenant_id = t.tenant_id and x.lead_id = t.id
                        and x.source = 'AUTO_ASSIGN' and x.status = 'OPEN' and x.agent_code = t.assigned_agent_code)`);
  }
  return { before, upsert, after };
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

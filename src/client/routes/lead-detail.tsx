import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, FilterTab, PageTitle } from "@/client/components/ui/card";
import { Field, Input, Select } from "@/client/components/ui/input";
import { api, errorText, formatDateTime, leadQuery, type LeadDetail } from "@/client/lib/api";
import { NotesCard, type ContactType, type NoteItem } from "@/client/components/notes";
import { AssigneeSelect, careTone, formatDate } from "@/client/routes/leads";
import { vi } from "@/i18n/vi";
import { LEAD_CARE_STATUSES, LEAD_INTERESTS } from "@/shared/enums";

const t = vi.leads;
type Tab = "info" | "tasks" | "history";
const textarea = "w-full rounded-md bg-card px-3 py-2 text-base shadow-ring sm:text-sm";

export function LeadDetailPage() {
  const { id } = useParams({ from: "/app/leads/$id" });
  const detail = useQuery(leadQuery(id));
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("info");
  // Opening a lead clears its "new" and "new comment" flags for the assignee.
  useEffect(() => {
    if (detail.data) void queryClient.invalidateQueries({ queryKey: ["leads", "list"] });
    if (detail.data) void queryClient.invalidateQueries({ queryKey: ["leads", "counts"] });
  }, [detail.data?.lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (detail.isPending) return <p className="text-sm text-muted-foreground">{vi.common.loading}</p>;
  if (detail.isError) return <ErrorText>{errorText(detail.error)}</ErrorText>;
  const { lead, canWork } = detail.data;
  const openTasks = detail.data.tasks.filter((x) => x.status === "OPEN").length;

  return (
    <>
      <Link to="/leads" className="text-sm text-muted-foreground hover:text-foreground">
        {t.back}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <PageTitle caps={false}>{lead.fullName}</PageTitle>
        {lead.careStatus && <Badge tone={careTone[lead.careStatus]}>{t.careStatuses[lead.careStatus]}</Badge>}
        {lead.origin === "FC_OWN" && <Badge tone="success">{t.origins.FC_OWN}</Badge>}
        {lead.overdue && <Badge tone="destructive">{t.badgeOverdue}</Badge>}
      </div>
      {canWork ? (
        <a href={`tel:${lead.phone}`} className="w-fit font-mono text-primary">
          {lead.phone}
        </a>
      ) : (
        <span className="w-fit font-mono text-muted-foreground">{lead.phone}</span>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {(["info", "tasks", "history"] as Tab[]).map((k) => (
          <FilterTab key={k} active={tab === k} onClick={() => setTab(k)}>
            {k === "tasks" ? `${t.tabs.tasks} (${openTasks})` : t.tabs[k]}
          </FilterTab>
        ))}
      </div>

      {tab === "info" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-4">
            <InfoCard detail={detail.data} />
            <Comments detail={detail.data} />
          </div>
          <div className="grid content-start gap-4">
            {canWork ? <StatusForm detail={detail.data} /> : <p className="rounded-lg bg-blue-10 p-4 text-sm text-nav shadow-ring-highlight">{t.viewOnly}</p>}
            <Notes detail={detail.data} />
          </div>
        </div>
      )}
      {tab === "tasks" && <Tasks detail={detail.data} />}
      {tab === "history" && <Timeline detail={detail.data} />}
    </>
  );
}

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["leads", "detail", id] }),
      queryClient.invalidateQueries({ queryKey: ["leads", "list"] }),
      queryClient.invalidateQueries({ queryKey: ["leads", "counts"] }),
    ]);
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[9rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value ?? vi.common.none}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Thông tin": the assigned FC updates the customer's details and "Nhu cầu" while talking to them. */
function InfoCard({ detail }: { detail: LeadDetail }) {
  const { lead, campaign, assignee, canWork, canManage, interestLocked } = detail;
  const refresh = useRefresh(lead.id);
  const [form, setForm] = useState({
    fullName: lead.fullName,
    phone: lead.phone,
    dob: lead.dob ?? "",
    region: lead.region ?? "",
    province: lead.province ?? "",
    email: lead.email ?? "",
    consent: lead.consentMarketing ? "yes" : "no",
    interest: lead.interest ?? "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  // Read first; the FC switches to editing when the customer gives new details.
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        json: {
          fullName: form.fullName,
          phone: form.phone,
          dob: form.dob || null,
          region: form.region || null,
          province: form.province || null,
          email: form.email || null,
          consent: form.consent === "yes",
          ...(interestLocked ? {} : { interest: form.interest || null }),
        },
      }),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
  });

  const fixed: [string, ReactNode][] = [
    [t.date, formatDate(lead.leadDate)],
    [t.source, lead.source],
    [t.phoneSource, lead.phoneSource],
    [t.campaign, campaign?.name ?? null],
    [t.agent, assignee ? `${assignee.name} (${assignee.agentCode})` : t.unassigned],
    [t.stage, t.stages[lead.stage]],
    ...(lead.applicationNo ? [[t.applicationNo, <span className="font-mono">{lead.applicationNo}</span>] as [string, ReactNode]] : []),
    ...(lead.policyNo ? [[t.policyNo, <span className="font-mono">{lead.policyNo}</span>] as [string, ReactNode]] : []),
  ];

  if (!canWork || !editing) {
    return (
      <Card className="grid content-start gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t.info}</CardTitle>
          {canWork && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                save.reset();
                setForm({
                  fullName: lead.fullName,
                  phone: lead.phone,
                  dob: lead.dob ?? "",
                  region: lead.region ?? "",
                  province: lead.province ?? "",
                  email: lead.email ?? "",
                  consent: lead.consentMarketing ? "yes" : "no",
                  interest: lead.interest ?? "",
                });
                setEditing(true);
              }}
            >
              {vi.common.edit}
            </Button>
          )}
        </div>
        <Rows
          rows={[
            [t.name, lead.fullName],
            [t.phone, lead.phone],
            [t.dob, lead.dob ? formatDate(lead.dob) : null],
            [t.region, lead.region],
            [t.province, lead.province],
            [t.email, lead.email],
            [t.consent, lead.consentMarketing ? t.consentYes : t.consentNo],
            [t.interest, lead.interest ? t.interests[lead.interest] : null],
            ...fixed,
          ]}
        />
        {save.isSuccess && <p className="text-sm text-success">{t.saved}</p>}
        {canManage && <Assign id={lead.id} current={lead.assignedAgentCode} />}
      </Card>
    );
  }
  return (
    <Card className="grid content-start gap-3">
      <CardTitle>{t.info}</CardTitle>
      <form
        className="grid gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.name} htmlFor="f-name">
            <Input id="f-name" required maxLength={200} value={form.fullName} onChange={set("fullName")} />
          </Field>
          <Field label={t.phone} htmlFor="f-phone">
            <Input id="f-phone" type="tel" inputMode="tel" required value={form.phone} onChange={set("phone")} />
          </Field>
          <Field label={t.dob} htmlFor="f-dob">
            <Input id="f-dob" type="date" value={form.dob} onChange={set("dob")} />
          </Field>
          <Field label={t.email} htmlFor="f-email">
            <Input id="f-email" type="email" value={form.email} onChange={set("email")} />
          </Field>
          <Field label={t.region} htmlFor="f-region">
            <Input id="f-region" maxLength={200} value={form.region} onChange={set("region")} />
          </Field>
          <Field label={t.province} htmlFor="f-province">
            <Input id="f-province" maxLength={200} value={form.province} onChange={set("province")} />
          </Field>
          <Field label={t.consent} htmlFor="f-consent">
            <Select id="f-consent" value={form.consent} onChange={set("consent")}>
              <option value="yes">{t.consentYes}</option>
              <option value="no">{t.consentNo}</option>
            </Select>
          </Field>
          <Field label={t.interest} htmlFor="f-interest" hint={interestLocked ? t.interestLocked : t.interestHint}>
            <Select id="f-interest" value={form.interest} disabled={interestLocked} onChange={set("interest")}>
              <option value="">{vi.common.none}</option>
              {LEAD_INTERESTS.map((i) => (
                <option key={i} value={i}>
                  {t.interests[i]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ErrorText>{save.isError ? errorText(save.error) : null}</ErrorText>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t.saveInfo}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            {vi.common.cancel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** "Ghi chú": notes and contacts in one story, oldest first; a chip logs the contact with its note. */
function Notes({ detail }: { detail: LeadDetail }) {
  const refresh = useRefresh(detail.lead.id);
  const id = detail.lead.id;
  const name = (u: string) => detail.userNames[u] ?? null;
  const items: NoteItem[] = [
    ...detail.notes.map((n) => ({ id: n.id, kind: "NOTE" as const, body: n.note, at: n.occurredAt, by: name(n.createdBy), tag: n.source === "IMPORT" ? t.fromImport : null })),
    ...detail.contacts.map((a) => ({ id: a.id, kind: a.type as ContactType, body: a.note, outcome: a.outcome, at: a.occurredAt, by: name(a.createdBy), tag: a.source === "IMPORT" ? t.fromImport : null })),
  ];
  return (
    <NotesCard
      items={items}
      help={vi.notes.leadHelp}
      firstLabel={t.firstNote}
      canAdd={detail.canWork}
      onAdd={async (kind, body) => {
        await (kind ? api(`/api/leads/${id}/activities`, { json: { type: kind, note: body } }) : api(`/api/leads/${id}/notes`, { json: { body } }));
        await refresh();
      }}
    />
  );
}

function StatusForm({ detail }: { detail: LeadDetail }) {
  const { lead } = detail;
  const refresh = useRefresh(lead.id);
  const [care, setCare] = useState(lead.careStatus ?? "");
  const [reason, setReason] = useState(lead.lostReason ?? "");
  const [next, setNext] = useState(lead.nextActionAt ? toLocalInput(lead.nextActionAt) : "");
  const [applicationNo, setApplicationNo] = useState(lead.applicationNo ?? "");
  const [policyNo, setPolicyNo] = useState(lead.policyNo ?? "");
  const save = useMutation({
    mutationFn: () =>
      api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        json: {
          careStatus: care || null,
          lostReason: reason || null,
          ...(care === "WON"
            ? { applicationNo: applicationNo.trim() || null, policyNo: policyNo.trim() || null }
            : { nextActionAt: next ? new Date(next).toISOString() : null }),
        },
      }),
    onSuccess: refresh,
  });
  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-3"
      >
        <CardTitle>{t.statusTitle}</CardTitle>
        <Field label={t.careStatus} htmlFor="care">
          <Select id="care" value={care} onChange={(e) => setCare(e.target.value)}>
            <option value="">{vi.common.none}</option>
            {LEAD_CARE_STATUSES.map((c) => (
              <option key={c} value={c}>
                {t.careStatuses[c]}
              </option>
            ))}
          </Select>
        </Field>
        {care === "DROPPED" && (
          <Field label={t.lostReason} htmlFor="reason">
            <Input id="reason" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {care === "WON" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.applicationNo} htmlFor="app-no" hint={t.wonHint}>
              <Input id="app-no" className="font-mono" pattern="[A-Za-z0-9]{4,20}" required={!policyNo.trim()} value={applicationNo} onChange={(e) => setApplicationNo(e.target.value)} />
            </Field>
            <Field label={t.policyNo} htmlFor="policy-no">
              <Input id="policy-no" className="font-mono" inputMode="numeric" pattern="\d{9}" required={!applicationNo.trim()} value={policyNo} onChange={(e) => setPolicyNo(e.target.value)} />
            </Field>
          </div>
        ) : (
          <Field label={t.nextAction} htmlFor="next">
            <Input id="next" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
        )}
        <ErrorText>{save.isError ? errorText(save.error) : null}</ErrorText>
        <Button type="submit" disabled={save.isPending} className="w-fit">
          {t.save}
        </Button>
      </form>
    </Card>
  );
}

function Assign({ id, current }: { id: string; current: string | null }) {
  const refresh = useRefresh(id);
  const [agent, setAgent] = useState("");
  const assign = useMutation({
    mutationFn: () => api("/api/leads/assign", { json: { leadIds: [id], agentCode: agent === "NONE" ? null : agent } }),
    onSuccess: async () => {
      setAgent("");
      await refresh();
    },
  });
  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <p className="text-sm font-semibold text-nav">{t.assignTitle}</p>
      <div className="flex flex-wrap gap-2">
        <div className="min-w-60 grow">
          <AssigneeSelect value={agent} onChange={setAgent} />
        </div>
        <Button size="sm" disabled={!agent || agent === current || assign.isPending} onClick={() => assign.mutate()}>
          {t.assign}
        </Button>
      </div>
      <ErrorText>{assign.isError ? errorText(assign.error) : null}</ErrorText>
    </div>
  );
}

/** "Việc cần làm": tasks with a due date and time (a calendar will come later). */
function Tasks({ detail }: { detail: LeadDetail }) {
  const refresh = useRefresh(detail.lead.id);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const add = useMutation({
    mutationFn: () => api(`/api/leads/${detail.lead.id}/tasks`, { json: { title, dueAt: new Date(due).toISOString() } }),
    onSuccess: async () => {
      setTitle("");
      setDue("");
      await refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (task: { id: string; done: boolean }) => api(`/api/leads/${detail.lead.id}/tasks/${task.id}`, { method: "PATCH", json: { done: task.done } }),
    onSuccess: refresh,
  });
  const now = new Date().toISOString();
  const open = detail.tasks.filter((x) => x.status === "OPEN");
  const closed = detail.tasks.filter((x) => x.status !== "OPEN");

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card className="grid content-start gap-3">
        <CardTitle>{t.taskOpen}</CardTitle>
        {open.length === 0 && <p className="text-sm text-muted-foreground">{t.tasksEmpty}</p>}
        <ul className="grid gap-2">
          {[...open, ...closed].map((task) => (
            <li key={task.id} className={`flex items-start gap-3 rounded-md p-3 text-sm ${task.status === "OPEN" ? "bg-card shadow-ring" : "bg-blue-10 text-muted-foreground"}`}>
              {detail.canWork && task.status !== "CANCELLED" && (
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--brand-blue-100)]"
                  aria-label={task.title}
                  checked={task.status === "DONE"}
                  disabled={toggle.isPending}
                  onChange={(e) => toggle.mutate({ id: task.id, done: e.target.checked })}
                />
              )}
              <div className="grid min-w-0 grow gap-0.5">
                <p className={task.status === "DONE" ? "line-through" : "font-medium text-nav"}>{task.title}</p>
                <p className="text-xs text-muted-foreground">
                  {t.taskDue}: {formatDateTime(task.dueAt)}
                  {task.source !== "APP" ? ` · ${t.taskAuto}` : ""}
                  {task.status !== "OPEN" ? ` · ${t.taskStatus[task.status]}` : ""}
                </p>
              </div>
              {task.status === "OPEN" && task.dueAt < now && <Badge tone="destructive">{t.taskOverdue}</Badge>}
            </li>
          ))}
        </ul>
      </Card>
      {detail.canWork && (
        <Card className="content-start">
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <CardTitle>{t.addTask}</CardTitle>
            <Field label={t.taskTitle} htmlFor="task-title">
              <Input id="task-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label={t.taskDue} htmlFor="task-due">
              <Input id="task-due" type="datetime-local" required value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <ErrorText>{add.isError ? errorText(add.error) : null}</ErrorText>
            <Button type="submit" size="sm" className="w-fit" disabled={add.isPending}>
              {t.addTask}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

/** Coaching thread: managers of the line comment, the FC reads and answers. */
function Comments({ detail }: { detail: LeadDetail }) {
  const refresh = useRefresh(detail.lead.id);
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () => api(`/api/leads/${detail.lead.id}/comments`, { json: { body } }),
    onSuccess: async () => {
      setBody("");
      await refresh();
    },
  });
  return (
    <Card className="grid gap-3">
      <div>
        <CardTitle>{t.commentsTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">{t.commentsHelp}</p>
      </div>
      {detail.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.commentsEmpty}</p>
      ) : (
        <ul className="grid gap-2">
          {detail.comments.map((m) => (
            <li key={m.id} className="rounded-md bg-blue-10 p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-nav">{detail.userNames[m.authorUserId] ?? vi.common.none}</span> · {formatDateTime(m.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-line">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <textarea rows={2} maxLength={2000} aria-label={t.commentsTitle} placeholder={t.commentPlaceholder} className={textarea} value={body} onChange={(e) => setBody(e.target.value)} />
        <ErrorText>{send.isError ? errorText(send.error) : null}</ErrorText>
        <Button type="submit" size="sm" className="w-fit" disabled={send.isPending || !body.trim()}>
          {t.comment}
        </Button>
      </form>
    </Card>
  );
}

/** "Lịch sử": every change and contact, newest first, with who made it. */
function Timeline({ detail }: { detail: LeadDetail }) {
  const label = (field: string, v: string | null) => {
    if (v === null) return vi.common.none;
    if (field === "interest") return t.interests[v as keyof typeof t.interests] ?? v;
    if (field === "care_status") return t.careStatuses[v as keyof typeof t.careStatuses] ?? v;
    if (field === "stage") return t.stages[v as keyof typeof t.stages] ?? v;
    if (field === "assignee") return detail.agentNames[v] ?? v;
    if (field === "consent_marketing") return v === "1" ? t.consentYes : t.consentNo;
    if (field === "dob") return formatDate(v);
    return v;
  };
  const items = [
    ...detail.history.map((h) => ({
      at: h.changedAt,
      key: h.id,
      title: t.historyLine(t.historyFields[h.field] ?? h.field, label(h.field, h.oldValue), label(h.field, h.newValue)),
      body: h.note,
      tag: h.importId ? t.fromImport : null,
      by: detail.userNames[h.changedBy] ?? null,
    })),
    ...detail.contacts.map((a) => ({
      at: a.occurredAt,
      key: a.id,
      title: [t.activityTypes[a.type], a.outcome].filter(Boolean).join(" · "),
      body: a.note,
      tag: a.source === "IMPORT" ? t.fromImport : null,
      by: detail.userNames[a.createdBy] ?? null,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Card className="grid gap-3">
      <CardTitle>{t.timeline}</CardTitle>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.timelineEmpty}</p>
      ) : (
        <ol className="grid gap-3 border-l-2 border-border pl-4">
          {items.map((i) => (
            <li key={i.key} className="grid gap-0.5 text-sm">
              <p className="text-xs text-muted-foreground">
                {formatDateTime(i.at)}
                {i.by ? ` · ${t.by(i.by)}` : ""}
                {i.tag ? ` · ${i.tag}` : ""}
              </p>
              <p className="font-medium">{i.title}</p>
              {i.body && <p className="whitespace-pre-line text-muted-foreground">{i.body}</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

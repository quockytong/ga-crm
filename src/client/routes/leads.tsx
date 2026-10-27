import { keepPreviousData, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, FilterTab, PageTitle } from "@/client/components/ui/card";
import { Field, Input, Select } from "@/client/components/ui/input";
import {
  api,
  ApiError,
  assigneesQuery,
  can,
  errorText,
  leadCountsQuery,
  leadFacetsQuery,
  leadsQuery,
  meQuery,
  type LeadFilters,
} from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import { LEAD_CARE_STATUSES, LEAD_INTERESTS } from "@/shared/enums";

const t = vi.leads;
type View = "all" | "mine" | "unassigned" | "overdue" | "isNew" | "newComment";

export const careTone = { CARING: "warning", WON: "success", DROPPED: "destructive", NOT_INTERESTED: "neutral" } as const;
export const formatDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

export function LeadsPage() {
  const { data: me } = useSuspenseQuery(meQuery);
  const manages = can(me, "leads.manage");
  const [view, setView] = useState<View>(manages ? "all" : "mine");
  const [filters, setFilters] = useState<LeadFilters>({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const viewFilter: LeadFilters =
    view === "unassigned" ? { assignee: "NONE" } : view === "overdue" ? { overdue: "1" } : view === "isNew" ? { isNew: "1" } : view === "newComment" ? { newComment: "1" } : view === "mine" && me.user.agentCode ? { assignee: me.user.agentCode } : {};
  const list = useQuery({ ...leadsQuery(page, { ...filters, ...viewFilter }), placeholderData: keepPreviousData });
  const facets = useQuery(leadFacetsQuery);
  const counts = useQuery(leadCountsQuery);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const set = (key: keyof LeadFilters) => (value: string) => {
    setPage(1);
    setSelected([]);
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  };
  const views: View[] = manages ? ["all", "unassigned", "overdue"] : ["mine", "isNew", "newComment", "overdue", ...(me.reach === "DOWNLINE" ? (["all"] as View[]) : [])];

  return (
    <>
      <PageTitle
        actions={
          <>
          {can(me, "leads.import") && (
            <Link to="/leads/import" className="inline-flex h-9 items-center rounded-md bg-card px-3 text-sm font-semibold text-nav shadow-ring hover:bg-blue-10">
              {t.importLeads}
            </Link>
          )}
          {(manages || !!me.user.agentCode) && !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              {t.add}
            </Button>
          )}
          </>
        }
      >
        {t.title}
      </PageTitle>

      {adding && <NewLead manages={manages} onClose={() => setAdding(false)} />}

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {views.map((v) => (
          <FilterTab
            key={v}
            active={view === v}
            onClick={() => {
              setView(v);
              setPage(1);
              setSelected([]);
            }}
          >
            {counts.data ? `${t.views[v]} (${counts.data[v]})` : t.views[v]}
          </FilterTab>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Input type="search" className="sm:col-span-3 lg:col-span-2" placeholder={t.searchPlaceholder} aria-label={vi.common.search} value={filters.q ?? ""} onChange={(e) => set("q")(e.target.value)} />
        <Select aria-label={t.interest} value={filters.interest ?? ""} onChange={(e) => set("interest")(e.target.value)}>
          <option value="">{t.interest}: {t.allValues}</option>
          {LEAD_INTERESTS.map((i) => (
            <option key={i} value={i}>
              {t.interests[i]}
            </option>
          ))}
          <option value="NONE">{t.none}</option>
        </Select>
        <Select aria-label={t.careStatus} value={filters.care ?? ""} onChange={(e) => set("care")(e.target.value)}>
          <option value="">{t.careStatus}: {t.allValues}</option>
          {LEAD_CARE_STATUSES.map((c) => (
            <option key={c} value={c}>
              {t.careStatuses[c]}
            </option>
          ))}
          <option value="NONE">{t.none}</option>
        </Select>
        <Select aria-label={t.source} value={filters.source ?? ""} onChange={(e) => set("source")(e.target.value)}>
          <option value="">{t.source}: {t.allValues}</option>
          {facets.data?.sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select aria-label={t.campaign} value={filters.campaignId ?? ""} onChange={(e) => set("campaignId")(e.target.value)}>
          <option value="">{t.campaign}: {t.allValues}</option>
          {facets.data?.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {(manages || me.reach === "DOWNLINE" || me.reach === "TENANT") && view !== "unassigned" && view !== "mine" && (
          <Select aria-label={t.agent} value={filters.assignee ?? ""} onChange={(e) => set("assignee")(e.target.value)}>
            <option value="">{t.agent}: {t.allValues}</option>
            {facets.data?.assignees.map((a) => (
              <option key={a.agentCode} value={a.agentCode}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
        <Input type="date" aria-label={t.from} title={t.from} value={filters.from ?? ""} onChange={(e) => set("from")(e.target.value)} />
        <Input type="date" aria-label={t.to} title={t.to} value={filters.to ?? ""} onChange={(e) => set("to")(e.target.value)} />
      </div>

      {manages && selected.length > 0 && <BulkAssign ids={selected} onDone={() => setSelected([])} />}

      <Card className="overflow-x-auto p-0 sm:p-0">
        {list.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : list.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(list.error)}</ErrorText>
          </div>
        ) : list.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{view === "mine" ? t.emptyMine : t.empty}</p>
        ) : (
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                {manages && (
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--brand-blue-100)]"
                      aria-label={t.selected(list.data.items.length)}
                      checked={list.data.items.every((l) => selected.includes(l.id))}
                      onChange={(e) => setSelected(e.target.checked ? list.data.items.map((l) => l.id) : [])}
                    />
                  </th>
                )}
                <th className="px-3 py-2.5 font-medium">{t.date}</th>
                <th className="px-3 py-2.5 font-medium">{t.customer}</th>
                <th className="px-3 py-2.5 font-medium">{t.source}</th>
                <th className="px-3 py-2.5 font-medium">{t.agent}</th>
                <th className="px-3 py-2.5 font-medium">{t.interest}</th>
                <th className="px-3 py-2.5 font-medium">{t.careStatus}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.data.items.map((l) => (
                <tr key={l.id} className="hover:bg-muted/40">
                  {manages && (
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--brand-blue-100)]"
                        aria-label={l.fullName}
                        checked={selected.includes(l.id)}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))}
                      />
                    </td>
                  )}
                  <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">{formatDate(l.leadDate)}</td>
                  <td className="px-3 py-3">
                    <Link to="/leads/$id" params={{ id: l.id }} className="font-medium hover:text-primary hover:underline">
                      {l.fullName}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{l.phone}</p>
                    <span className="mt-1 flex gap-1">
                      {l.isNew && <Badge tone="primary">{t.badgeNew}</Badge>}
                      {l.newComment && <Badge tone="warning">{t.badgeComment}</Badge>}
                      {l.origin === "FC_OWN" && <Badge tone="success">{t.origins.FC_OWN}</Badge>}
                      {l.overdue && <Badge tone="destructive">{t.badgeOverdue}</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <p>{l.source}</p>
                    <p className="text-xs text-muted-foreground">{l.campaignName ?? ""}</p>
                  </td>
                  <td className="px-3 py-3">{l.agentName ?? <span className="text-muted-foreground">{t.unassigned}</span>}</td>
                  <td className="px-3 py-3">{l.interest ? t.interests[l.interest] : <span className="text-muted-foreground">{vi.common.none}</span>}</td>
                  <td className="px-3 py-3">{l.careStatus ? <Badge tone={careTone[l.careStatus]}>{t.careStatuses[l.careStatus]}</Badge> : <span className="text-muted-foreground">{vi.common.none}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {list.data && list.data.total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{vi.common.total(list.data.total)}</span>
          <span className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {vi.common.prev}
            </Button>
            {vi.common.pageOf(page, pages)}
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {vi.common.next}
            </Button>
          </span>
        </div>
      )}
    </>
  );
}

/** F4.1 / F4.2: assign the selected leads. */
export function AssigneeSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const assignees = useQuery(assigneesQuery);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t.assignTo}>
      <option value="">{t.assignTo}…</option>
      <option value="NONE">{t.unassign}</option>
      {assignees.data?.items.map((a) => (
        <option key={a.agentCode} value={a.agentCode}>
          {t.pickerOption(a.name, a.agentCode)}
        </option>
      ))}
    </Select>
  );
}

function BulkAssign({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState("");
  const assign = useMutation({
    mutationFn: () => api<{ assigned: number }>("/api/leads/assign", { json: { leadIds: ids, agentCode: agent === "NONE" ? null : agent } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["leads"] });
      onDone();
    },
  });
  return (
    <Card className="flex flex-wrap items-center gap-3 bg-highlight py-3 shadow-ring-highlight">
      <span className="text-sm font-medium">{t.selected(ids.length)}</span>
      <div className="min-w-64 grow sm:grow-0">
        <AssigneeSelect value={agent} onChange={setAgent} />
      </div>
      <Button size="sm" disabled={!agent || assign.isPending} onClick={() => assign.mutate()}>
        {t.assign}
      </Button>
      <ErrorText>{assign.isError ? errorText(assign.error) : null}</ErrorText>
    </Card>
  );
}

function NewLead({ onClose, manages }: { onClose: () => void; manages: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const facets = useQuery(leadFacetsQuery);
  const [form, setForm] = useState({ fullName: "", phone: "", source: manages ? "" : "Tự khai thác", consent: "", campaignId: "", region: "", dob: "", note: "", agent: "" });
  const [existing, setExisting] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/leads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName,
          phone: form.phone,
          source: form.source,
          consent: form.consent === "yes",
          campaignId: form.campaignId || null,
          region: form.region || null,
          dob: form.dob || null,
          note: form.note || null,
          assignedAgentCode: manages && form.agent && form.agent !== "NONE" ? form.agent : null,
        }),
      });
      const body = (await res.json()) as { id?: string; error?: string; leadId?: string };
      if (res.status === 409 && body.leadId) {
        setExisting(body.leadId);
        throw new ApiError(409, "phone_exists");
      }
      if (!res.ok) throw new ApiError(res.status, body.error ?? "internal");
      return body.id!;
    },
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ["leads"] });
      onClose();
      await navigate({ to: "/leads/$id", params: { id } });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setExisting(null);
    create.mutate();
  }

  return (
    <Card>
      <form onSubmit={submit} className="grid gap-4">
        <CardTitle>{t.newTitle}</CardTitle>
        {!manages && <p className="text-sm text-muted-foreground">{t.ownLeadHint}</p>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t.customer} htmlFor="lead-name">
            <Input id="lead-name" required maxLength={200} value={form.fullName} onChange={set("fullName")} />
          </Field>
          <Field label={t.phone} htmlFor="lead-phone">
            <Input id="lead-phone" type="tel" inputMode="tel" required value={form.phone} onChange={set("phone")} />
          </Field>
          <Field label={t.source} htmlFor="lead-source">
            <Input id="lead-source" required list="lead-sources" value={form.source} onChange={set("source")} />
            <datalist id="lead-sources">
              {facets.data?.sources.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label={t.consent} htmlFor="lead-consent">
            <Select id="lead-consent" required value={form.consent} onChange={set("consent")}>
              <option value="">…</option>
              <option value="yes">{t.consentYes}</option>
              <option value="no">{t.consentNo}</option>
            </Select>
          </Field>
          <Field label={t.dob} htmlFor="lead-dob">
            <Input id="lead-dob" type="date" value={form.dob} onChange={set("dob")} />
          </Field>
          {manages && (
          <Field label={t.campaign} htmlFor="lead-campaign">
            <Select id="lead-campaign" value={form.campaignId} onChange={set("campaignId")}>
              <option value="">{vi.common.none}</option>
              {facets.data?.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          )}
          {manages && (
            <Field label={t.agent} htmlFor="lead-agent">
              <AssigneeSelect id="lead-agent" value={form.agent} onChange={(v) => setForm({ ...form, agent: v })} />
            </Field>
          )}
        </div>
        <Field label={t.note} htmlFor="lead-note" hint={t.healthNote}>
          <textarea id="lead-note" rows={2} maxLength={4000} className="w-full rounded-md bg-card px-3 py-2 text-base shadow-ring sm:text-sm" value={form.note} onChange={set("note")} />
        </Field>
        <ErrorText>{create.isError ? errorText(create.error) : null}</ErrorText>
        {existing && (
          <Link to="/leads/$id" params={{ id: existing }} className="text-sm font-medium text-primary underline">
            {t.openExisting}
          </Link>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {t.create}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {vi.common.cancel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

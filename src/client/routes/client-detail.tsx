import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, FilterTab, PageTitle } from "@/client/components/ui/card";
import { Field, Input, Select } from "@/client/components/ui/input";
import {
  api,
  clientQuery,
  clientSearchQuery,
  errorText,
  formatDateTime,
  formatVnd,
  type ClientDetail,
  type ClientSignal,
  type Coverage,
  type FamilyClient,
  type FamilyMember,
} from "@/client/lib/api";
import { NotesCard, type NoteItem } from "@/client/components/notes";
import { formatDate } from "@/client/routes/leads";
import { vi } from "@/i18n/vi";
import { ACTIVE_STATUS, COVERAGE_GROUPS, GAP_GROUPS } from "@/shared/coverage";
import { FAMILY_RELATIONS, type FamilyRelation } from "@/shared/enums";

const t = vi.clients;
type Tab = "overview" | "policies" | "family" | "history";
const yesNo = (v: boolean | null) => (v === null ? null : v ? t.yes : t.no);
const date = (v: string | null | undefined) => (v ? formatDate(v) : null);

export function ClientDetailPage() {
  const { code } = useParams({ from: "/app/clients/$code" });
  const detail = useQuery(clientQuery(code));
  const [tab, setTab] = useState<Tab>("overview");

  if (detail.isPending) return <p className="text-sm text-muted-foreground">{vi.common.loading}</p>;
  if (detail.isError) return <ErrorText>{errorText(detail.error)}</ErrorText>;
  const d = detail.data;
  const counts: Partial<Record<Tab, number>> = { policies: d.policies.length, family: d.family.length };

  return (
    <>
      <Link to="/clients" className="text-sm text-muted-foreground hover:text-foreground">
        {t.back}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <PageTitle caps={false}>{d.client.name}</PageTitle>
        {d.client.tier && <Badge tone="warning">{d.client.tier}</Badge>}
      </div>
      <p className="font-mono text-sm text-muted-foreground">
        {t.code} {d.client.clientCode}
      </p>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {(["overview", "policies", "family", "history"] as Tab[]).map((k) => (
          <FilterTab key={k} active={tab === k} onClick={() => setTab(k)}>
            {counts[k] === undefined ? t.tabs[k] : `${t.tabs[k]} (${counts[k]})`}
          </FilterTab>
        ))}
      </div>

      {!d.canEdit && tab === "family" && (
        <p className="rounded-lg bg-blue-10 p-4 text-sm text-nav shadow-ring-highlight">{t.viewOnly}</p>
      )}
      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-4">
            <InfoCard detail={d} />
            <CoverageCard detail={d} />
          </div>
          <div className="grid content-start gap-4">
            <Signals signals={d.signals} />
            {!d.canEdit && <p className="rounded-lg bg-blue-10 p-4 text-sm text-nav shadow-ring-highlight">{t.viewOnly}</p>}
            <Notes detail={d} />
          </div>
        </div>
      )}
      {tab === "policies" && <Policies detail={d} />}
      {tab === "family" && <Family detail={d} />}
      {tab === "history" && <History detail={d} />}
    </>
  );
}

function useRefresh(code: string) {
  const queryClient = useQueryClient();
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: ["clients", "detail", code] }), queryClient.invalidateQueries({ queryKey: ["clients", "list"] })]);
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value ?? vi.common.none}</dd>
        </div>
      ))}
    </dl>
  );
}

function signalText(s: ClientSignal) {
  const m = formatVnd(s.amount ?? null) ?? "";
  switch (s.kind) {
    case "PREMIUM_DUE":
      return t.signal.PREMIUM_DUE(s.policyNo!, date(s.date) ?? "", m);
    case "UNPAID":
      return t.signal.UNPAID(s.policyNo!, m);
    case "APL":
      return t.signal.APL(s.policyNo!, m);
    case "MATURITY":
      return t.signal.MATURITY(s.policyNo!, date(s.date) ?? "");
    case "NOT_ACTIVE":
      return t.signal.NOT_ACTIVE(s.policyNo!, s.name ?? "");
    case "LAPSED":
      return t.signal.LAPSED(String(s.amount ?? ""));
    case "BIRTHDAY":
      return t.signal.BIRTHDAY(s.date ?? "");
    case "GAP":
      return t.signal.GAP(s.name ?? "", (s.groups ?? []).map((g) => t.groups[g]).join(", "));
    case "FAMILY_UNCOVERED":
      return t.signal.FAMILY_UNCOVERED(s.name ?? "");
    case "NO_DCONNECT":
      return t.signal.NO_DCONNECT();
  }
}
const urgent = new Set(["UNPAID", "APL", "NOT_ACTIVE", "LAPSED"]);

/** "Cơ hội chăm sóc": facts from the data that call for a contact. */
function Signals({ signals }: { signals: ClientSignal[] }) {
  return (
    <Card className="grid content-start gap-3">
      <CardTitle>{t.signalsTitle}</CardTitle>
      {signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noSignals}</p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {signals.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${urgent.has(s.kind) ? "bg-destructive" : "bg-primary"}`} />
              <span>{signalText(s)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t.signalsHelp}</p>
    </Card>
  );
}

function InfoCard({ detail }: { detail: ClientDetail }) {
  const c = detail.client;
  return (
    <Card className="grid content-start gap-3">
      <CardTitle>{t.info}</CardTitle>
      <Rows
        rows={[
          [t.code, <span className="font-mono">{c.clientCode}</span>],
          [t.tier, c.tier],
          [t.dob, date(c.dob)],
          [t.ageBand, c.ageBand],
          [t.gender, c.gender],
          [t.marital, c.maritalStatus],
          [t.loyalty, c.loyaltyPoints === null ? null : c.loyaltyPoints.toLocaleString("vi-VN")],
          [t.dconnect, c.usesDconnect ? (c.dconnectLastLoginAt ? t.dconnectLast(formatDateTime(c.dconnectLastLoginAt) ?? "") : t.yes) : yesNo(c.usesDconnect)],
          [t.ekyc, c.ekycRegistered ? [t.yes, date(c.ekycRegisteredAt)].filter(Boolean).join(" · ") : yesNo(c.ekycRegistered)],
          [t.idUpdated, yesNo(c.idUpdated)],
        ]}
      />
    </Card>
  );
}

/** Coverage per person (the client and family members who are clients), by group. */
function CoverageCard({ detail }: { detail: ClientDetail }) {
  const people: { key: string; name: string; sub: string; link: boolean; coverage: Coverage }[] = [
    { key: detail.client.clientCode, name: detail.client.name, sub: t.self, link: false, coverage: detail.coverage },
    ...detail.family
      .filter((m): m is FamilyClient => m.kind === "CLIENT")
      .map((m) => ({ key: m.clientCode, name: m.name, sub: m.label ? t.relations[m.label.relation] : t.noRelation, link: m.isClient, coverage: m.coverage })),
  ];
  const members = detail.family.filter((m): m is FamilyMember => m.kind === "MEMBER");
  const shownGroups = COVERAGE_GROUPS.filter((g) => (GAP_GROUPS as readonly string[]).includes(g) || people.some((p) => g in p.coverage.groups));
  const cell = (cov: Coverage, g: (typeof COVERAGE_GROUPS)[number]) => {
    if (!cov.covered) return <span className="text-destructive">{t.notCovered}</span>;
    if (!cov.hasDetail) return <span className="text-muted-foreground">{t.noDetailShort}</span>;
    if (g in cov.groups) return formatVnd(cov.groups[g]!);
    return <span className={(GAP_GROUPS as readonly string[]).includes(g) ? "text-destructive" : "text-muted-foreground"}>{t.notCovered}</span>;
  };
  return (
    <Card className="grid content-start gap-3 overflow-x-auto">
      <CardTitle>{t.coverageTitle}</CardTitle>
      <table className="w-full text-sm">
        <thead className="border-b border-border text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 text-left font-medium whitespace-nowrap">{t.person}</th>
            {people.map((p) => (
              <th key={p.key} className="px-2 py-2 text-right font-medium">
                {!p.link ? (
                  <span className="block text-foreground">{p.name}</span>
                ) : (
                  <Link to="/clients/$code" params={{ code: p.key }} className="block text-foreground hover:text-primary hover:underline">
                    {p.name}
                  </Link>
                )}
                <span className="font-normal">{p.sub}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          <tr>
            <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{t.tabs.policies}</td>
            {people.map((p) => (
              <td key={p.key} className="px-2 py-2 text-right tabular-nums">
                {t.policiesCount(p.coverage.activePolicies.length)}
              </td>
            ))}
          </tr>
          {shownGroups.map((g) => (
            <tr key={g}>
              <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{t.groups[g]}</td>
              {people.map((p) => (
                <td key={p.key} className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                  {cell(p.coverage, g)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {people.some((p) => p.coverage.covered && !p.coverage.hasDetail) && <p className="text-xs text-muted-foreground">{t.noDetail}</p>}
      {members.length > 0 && (
        <p className="text-sm">
          {members.map((m) => (
            <span key={m.id} className="mr-3 inline-block">
              {m.name} ({t.relations[m.relation]}): <span className="text-destructive">{t.notCovered}</span>
            </span>
          ))}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t.coverageHelp}</p>
    </Card>
  );
}

function Policies({ detail }: { detail: ClientDetail }) {
  return (
    <div className="grid gap-4">
      {detail.policies.length === 0 && <p className="text-sm text-muted-foreground">{t.noPolicies}</p>}
      {detail.policies.map((p) => (
        <Card key={p.policyNo} className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="font-mono">{p.policyNo}</CardTitle>
            <Badge tone={p.status === ACTIVE_STATUS ? "success" : "destructive"}>{p.status}</Badge>
            {p.roles.map((r) => (
              <Badge key={r} tone="neutral">
                {t.roles[r]}
              </Badge>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Rows
              rows={[
                [t.insured, p.insuredClientCode && detail.clientNames[p.insuredClientCode] ? detail.clientNames[p.insuredClientCode] : p.insuredName],
                [t.effective, date(p.effectiveDate)],
                [t.maturity, date(p.maturityDate)],
                [t.beneficiary, yesNo(p.hasBeneficiary)],
                [t.agents, p.agents.map((a) => `${a.name ?? a.agentCode}${t.share(a.splitPercent)}${a.isServicing ? ` (${t.servicing})` : ""}`).join(", ") || null],
              ]}
            />
            <Rows
              rows={[
                [t.frequency, p.premiumFrequency],
                [t.dueDate, date(p.premiumDueDate)],
                [t.plannedPremium, formatVnd(p.plannedPremiumVnd)],
                [t.unpaid, (p.unpaidPremiumVnd ?? 0) > 0 ? <span className="text-destructive">{formatVnd(p.unpaidPremiumVnd)}</span> : formatVnd(p.unpaidPremiumVnd)],
                [t.apl, (p.aplDebtVnd ?? 0) > 0 ? <span className="text-destructive">{formatVnd(p.aplDebtVnd)}</span> : formatVnd(p.aplDebtVnd)],
              ]}
            />
          </div>
          {p.products.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noDetail}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 text-left font-medium">{t.product}</th>
                    <th className="px-2 py-2 text-left font-medium">{t.productRole}</th>
                    <th className="px-2 py-2 text-left font-medium">{t.person}</th>
                    <th className="px-2 py-2 text-right font-medium">{t.sumAssured}</th>
                    <th className="px-2 py-2 text-right font-medium">{t.annualPremium}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {p.products.map((pp) => (
                    <tr key={`${pp.productCode}|${pp.insuredCode}`}>
                      <td className="py-2 pr-3">
                        {pp.productName ?? pp.productCode}
                        <span className="block text-xs text-muted-foreground">{t.groups[pp.group]}</span>
                      </td>
                      <td className="px-2 py-2">{pp.productRole}</td>
                      <td className="px-2 py-2">{(pp.insuredCode && detail.clientNames[pp.insuredCode]) || pp.insuredCode || vi.common.none}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatVnd(pp.sumAssuredVnd) ?? vi.common.none}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatVnd(pp.annualPremiumVnd) ?? vi.common.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
      {detail.applications.length > 0 && (
        <Card className="grid gap-3 overflow-x-auto">
          <CardTitle>{t.applications}</CardTitle>
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 text-left font-medium">{t.applicationNo}</th>
                <th className="px-2 py-2 text-left font-medium">{t.created}</th>
                <th className="px-2 py-2 text-left font-medium">{t.status}</th>
                <th className="px-2 py-2 text-left font-medium">{t.policy}</th>
                <th className="px-2 py-2 text-right font-medium">{t.ape}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {detail.applications.map((a) => (
                <tr key={a.applicationNo}>
                  <td className="py-2 pr-3 font-mono">{a.applicationNo}</td>
                  <td className="px-2 py-2">{date(a.createdDate)}</td>
                  <td className="px-2 py-2">{a.status}</td>
                  <td className="px-2 py-2 font-mono">{a.policyNo ?? vi.common.none}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatVnd(a.apeVnd) ?? vi.common.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function RelationSelect({ value, onChange, id, placeholder }: { value: string; onChange: (v: FamilyRelation) => void; id?: string; placeholder?: string }) {
  return (
    <Select id={id} value={value} aria-label={t.relation} onChange={(e) => onChange(e.target.value as FamilyRelation)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {FAMILY_RELATIONS.map((r) => (
        <option key={r} value={r}>
          {t.relations[r]}
        </option>
      ))}
    </Select>
  );
}

/** "Gia đình": people linked through policies, labelled by the FC, and members who are not clients yet. */
function Family({ detail }: { detail: ClientDetail }) {
  const code = detail.client.clientCode;
  const refresh = useRefresh(code);
  const label = useMutation({
    mutationFn: (v: { related: string; relation: FamilyRelation }) => api(`/api/clients/${code}/family`, { json: { relation: v.relation, relatedClientCode: v.related } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/clients/${code}/family/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const [making, setMaking] = useState<string | null>(null);
  const th = "px-3 py-2.5 font-medium";
  const td = "px-3 py-3 align-top";
  return (
    <div className="grid gap-4">
      <Card className="grid gap-3 p-0 sm:p-0">
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">
          <CardTitle>{t.familyTitle}</CardTitle>
          <p className="text-xs text-muted-foreground">{t.familyHelp}</p>
        </div>
        {detail.family.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-6 sm:pb-6">{t.familyEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="border-y border-border text-xs text-muted-foreground">
                <tr>
                  <th className={th}>{t.fullName}</th>
                  <th className={th}>{t.relation}</th>
                  <th className={th}>{t.birth}</th>
                  <th className={th}>{t.link}</th>
                  <th className={th}>{t.coverageCol}</th>
                  {detail.canEdit && <th className={th} />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.family.map((m) =>
                  m.kind === "CLIENT" ? (
                    <tr key={m.clientCode}>
                      <td className={td}>
                        {m.isClient ? (
                          <Link to="/clients/$code" params={{ code: m.clientCode }} className="font-medium hover:text-primary hover:underline">
                            {m.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{m.name}</span>
                        )}
                        <span className="block text-xs text-muted-foreground">
                          <span className="font-mono">{m.clientCode}</span>
                          {m.isClient ? "" : ` · ${t.policyOnlyShort}`}
                        </span>
                      </td>
                      <td className={td}>
                        {detail.canEdit ? (
                          <RelationSelect
                            value={m.label?.relation ?? ""}
                            placeholder={m.label ? undefined : t.setRelation}
                            onChange={(relation) => label.mutate({ related: m.clientCode, relation })}
                          />
                        ) : m.label ? (
                          t.relations[m.label.relation]
                        ) : (
                          <span className="text-muted-foreground">{t.noRelation}</span>
                        )}
                      </td>
                      <td className={td}>{[date(m.dob) ?? m.ageBand, m.gender].filter(Boolean).join(" · ") || vi.common.none}</td>
                      <td className={`${td} text-xs text-muted-foreground`}>
                        {m.sharedPolicies.length === 0
                          ? t.linkedByFc
                          : m.sharedPolicies.map((s) => (
                              <span key={s.policyNo} className="block">
                                {t.viaPolicy(s.policyNo, s.myRoles.map((r) => t.roles[r].toLowerCase()).join(", "), s.theirRoles.map((r) => t.roles[r].toLowerCase()).join(", "))}
                              </span>
                            ))}
                      </td>
                      <td className={td}>
                        <CoverageSummary coverage={m.coverage} />
                      </td>
                      {detail.canEdit && (
                        <td className={`${td} text-right`}>
                          {m.label && (
                            <Button variant="outline" size="sm" aria-label={t.remove} onClick={() => confirm(t.removeConfirm(m.name)) && remove.mutate(m.label!.id)}>
                              ✕
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ) : (
                    <MemberRows
                      key={m.id}
                      detail={detail}
                      member={m}
                      making={making === m.id}
                      onMake={(on) => setMaking(on ? m.id : null)}
                      onRemove={() => confirm(t.removeConfirm(m.name)) && remove.mutate(m.id)}
                    />
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <ErrorText>{label.isError ? errorText(label.error) : remove.isError ? errorText(remove.error) : null}</ErrorText>
        </div>
      </Card>
      {detail.canEdit && <AddMember code={code} />}
    </div>
  );
}

function CoverageSummary({ coverage }: { coverage: Coverage }) {
  if (!coverage.covered) return <span className="text-destructive">{t.uncovered}</span>;
  return (
    <span>
      {t.policiesCount(coverage.activePolicies.length)}
      {coverage.gaps?.length ? <span className="block text-xs text-destructive">{`${t.notCovered}: ${coverage.gaps.map((g) => t.groups[g]).join(", ")}`}</span> : null}
    </span>
  );
}

/** dd/mm/yyyy with the parts the FC knows: "12/05", "1990", "12/05/1990". */
const birthText = (m: FamilyMember) => {
  const p = (n: number) => String(n).padStart(2, "0");
  const dayMonth = m.birthDay && m.birthMonth ? `${p(m.birthDay)}/${p(m.birthMonth)}` : m.birthMonth ? `${t.monthShort} ${p(m.birthMonth)}` : null;
  return [dayMonth, m.birthYear].filter(Boolean).join(dayMonth && m.birthDay ? "/" : " · ") || null;
};

function MemberRows({
  detail,
  member,
  making,
  onMake,
  onRemove,
}: {
  detail: ClientDetail;
  member: FamilyMember;
  making: boolean;
  onMake: (on: boolean) => void;
  onRemove: () => void;
}) {
  const code = detail.client.clientCode;
  const refresh = useRefresh(code);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const make = useMutation({
    mutationFn: async () => {
      const lead = await api<{ id: string }>("/api/leads", {
        json: { fullName: member.name, phone, source: t.leadSource, consent, note: t.leadNote(`${detail.client.name} (${code})`, t.relations[member.relation]) },
      });
      await api(`/api/clients/${code}/family/${member.id}/lead`, { json: { leadId: lead.id } });
    },
    onSuccess: async () => {
      onMake(false);
      await refresh();
    },
  });
  const td = "px-3 py-3 align-top";
  return (
    <>
      <tr>
        <td className={td}>
          <span className="font-medium">{member.name}</span>
          <span className="block text-xs text-muted-foreground">{t.notClient}</span>
          {member.note && <span className="block text-xs text-muted-foreground">{member.note}</span>}
        </td>
        <td className={td}>{t.relations[member.relation]}</td>
        <td className={td}>{[birthText(member), member.gender].filter(Boolean).join(" · ") || vi.common.none}</td>
        <td className={`${td} text-xs text-muted-foreground`}>{t.addedByFc}</td>
        <td className={td}>
          <span className="text-destructive">{t.uncovered}</span>
        </td>
        {detail.canEdit ? (
          <td className={`${td} text-right whitespace-nowrap`}>
            <span className="inline-flex gap-2">
              {member.leadId ? (
                <Link to="/leads/$id" params={{ id: member.leadId }} className="inline-flex h-8 items-center text-link hover:underline">
                  {t.openLead}
                </Link>
              ) : (
                !making && (
                  <Button variant="outline" size="sm" onClick={() => onMake(true)}>
                    {t.makeLead}
                  </Button>
                )
              )}
              <Button variant="outline" size="sm" aria-label={t.remove} onClick={onRemove}>
                ✕
              </Button>
            </span>
          </td>
        ) : null}
      </tr>
      {making && (
        <tr>
          <td colSpan={6} className="bg-blue-10 px-3 py-3">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                make.mutate();
              }}
            >
              <Field label={t.leadPhone} htmlFor={`phone-${member.id}`}>
                <Input id={`phone-${member.id}`} required inputMode="tel" className="w-48" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
              <label className="flex h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--brand-blue-100)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                {t.consent}
              </label>
              <Button type="submit" size="sm" disabled={make.isPending || !phone.trim()}>
                {t.makeLead}
              </Button>
              <Button variant="outline" size="sm" onClick={() => onMake(false)}>
                {vi.common.cancel}
              </Button>
              <div className="w-full">
                <ErrorText>{make.isError ? errorText(make.error) : null}</ErrorText>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const emptyPerson = { fullName: "", birthDay: "", birthMonth: "", birthYear: "", gender: "", note: "" };

function AddMember({ code }: { code: string }) {
  const refresh = useRefresh(code);
  const [kind, setKind] = useState<"person" | "client">("person");
  const [relation, setRelation] = useState<FamilyRelation>("SPOUSE");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ clientCode: string; name: string } | null>(null);
  const [form, setForm] = useState(emptyPerson);
  const search = useQuery(clientSearchQuery(q));
  const num = (v: string) => (v ? Number(v) : null);
  const add = useMutation({
    mutationFn: () =>
      api(`/api/clients/${code}/family`, {
        json:
          kind === "client"
            ? { relation, relatedClientCode: picked!.clientCode }
            : {
                relation,
                fullName: form.fullName,
                birthDay: num(form.birthDay),
                birthMonth: num(form.birthMonth),
                birthYear: num(form.birthYear),
                gender: form.gender || null,
                note: form.note || null,
              },
      }),
    onSuccess: async () => {
      setForm(emptyPerson);
      setPicked(null);
      setQ("");
      await refresh();
    },
  });
  const matches = (search.data?.items ?? []).filter((c) => c.clientCode !== code);
  return (
    <Card>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <CardTitle>{t.addMember}</CardTitle>
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <legend className="sr-only">{t.addMember}</legend>
          {(["person", "client"] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="fam-kind" className="size-4 accent-[var(--brand-blue-100)]" checked={kind === k} onChange={() => setKind(k)} />
              {k === "person" ? t.addPerson : t.addClient}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.relation} htmlFor="fam-relation">
            <RelationSelect id="fam-relation" value={relation} onChange={setRelation} />
          </Field>
          {kind === "client" ? (
            <div className="relative sm:col-span-1 lg:col-span-3">
              <Field label={t.pickClient} htmlFor="fam-search" hint={t.pickClientHint}>
                <Input
                  id="fam-search"
                  type="search"
                  autoComplete="off"
                  value={picked ? `${picked.name} (${picked.clientCode})` : q}
                  onChange={(e) => {
                    setPicked(null);
                    setQ(e.target.value);
                  }}
                />
              </Field>
              {!picked && matches.length > 0 && (
                <ul className="absolute top-[4.5rem] right-0 left-0 z-10 max-h-64 divide-y divide-border overflow-y-auto rounded-md bg-card shadow-ring">
                  {matches.map((c) => (
                    <li key={c.clientCode}>
                      <button type="button" className="w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-blue-10" onClick={() => setPicked(c)}>
                        {c.name} <span className="font-mono text-xs text-muted-foreground">{c.clientCode}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="sm:col-span-1 lg:col-span-2">
                <Field label={t.fullName} htmlFor="fam-name">
                  <Input id="fam-name" required maxLength={200} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                </Field>
              </div>
              <Field label={t.gender} htmlFor="fam-gender">
                <Select id="fam-gender" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                  <option value="">{vi.common.none}</option>
                  <option value="Nam">Nam</option>
                  <option value="Nữ">Nữ</option>
                </Select>
              </Field>
              <Field label={t.birthDay} htmlFor="fam-day">
                <Select id="fam-day" value={form.birthDay} onChange={(e) => setForm({ ...form, birthDay: e.target.value })}>
                  <option value="">{vi.common.none}</option>
                  {DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.birthMonth} htmlFor="fam-month">
                <Select id="fam-month" value={form.birthMonth} onChange={(e) => setForm({ ...form, birthMonth: e.target.value })}>
                  <option value="">{vi.common.none}</option>
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.birthYear} htmlFor="fam-year">
                <Input id="fam-year" inputMode="numeric" pattern="(19|20)[0-9]{2}" maxLength={4} placeholder="1990" value={form.birthYear} onChange={(e) => setForm({ ...form, birthYear: e.target.value })} />
              </Field>
              <Field label={t.note} htmlFor="fam-note">
                <Input id="fam-note" maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <ErrorText>{add.isError ? errorText(add.error) : null}</ErrorText>
        <Button type="submit" className="w-fit" disabled={add.isPending || (kind === "client" ? !picked : !form.fullName.trim())}>
          {t.add}
        </Button>
      </form>
    </Card>
  );
}

/** "Ghi chú": what the FC learns about the client and every contact, oldest first. */
function Notes({ detail }: { detail: ClientDetail }) {
  const code = detail.client.clientCode;
  const refresh = useRefresh(code);
  const name = (u: string) => detail.userNames[u] ?? null;
  const items: NoteItem[] = [
    ...detail.notes.map((n) => ({ id: n.id, kind: "NOTE" as const, body: n.note, at: n.occurredAt, by: name(n.createdBy) })),
    ...detail.activities.map((a) => ({ id: a.id, kind: a.type, body: a.note, outcome: a.outcome, at: a.occurredAt, by: name(a.createdBy) })),
  ];
  return (
    <NotesCard
      items={items}
      help={vi.notes.clientHelp}
      canAdd={detail.canEdit}
      onAdd={async (kind, body) => {
        await (kind ? api(`/api/clients/${code}/activities`, { json: { type: kind, note: body } }) : api(`/api/clients/${code}/notes`, { json: { body } }));
        await refresh();
      }}
    />
  );
}

/** Field changes Success imports made to the client and their policies (record_changes). */
function History({ detail }: { detail: ClientDetail }) {
  return (
    <Card className="grid gap-3">
      <CardTitle>{t.historyTitle}</CardTitle>
      {detail.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.historyEmpty}</p>
      ) : (
        <ol className="grid gap-3 border-l-2 border-border pl-4">
          {detail.history.map((h) => (
            <li key={h.id} className="grid gap-0.5 text-sm">
              <p className="text-xs text-muted-foreground">
                {formatDateTime(h.changedAt)}
                {detail.userNames[h.changedBy] ? ` · ${t.by(detail.userNames[h.changedBy]!)}` : ""}
              </p>
              <p>{t.historyLine(`${t.entities[h.entity] ?? h.entity} ${h.entityKey.split("|")[0]}`, h.field, h.oldValue ?? vi.common.none, h.newValue ?? vi.common.none)}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

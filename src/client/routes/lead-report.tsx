import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { HierarchyReport, type Metrics, type ReportColumn } from "@/client/components/hierarchy-report";
import { Card, ErrorText } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { todayInVietnam } from "@/client/features/import/upload";
import { errorText, leadReportQuery, type LeadReportRow } from "@/client/lib/api";
import { vi } from "@/i18n/vi";

const t = vi.leads;
const pct = (a = 0, b = 0) => (b ? `${Math.round((a / b) * 100)}%` : vi.common.none);
const KEYS = ["total", "contacted", "timedContacts", "contactedIn24h", "overdue", "notReached", "undetermined", "notInterested", "life", "healthCard", "caring", "won", "dropped"] as const;
const metricsOf = (r: LeadReportRow): Metrics => Object.fromEntries(KEYS.map((k) => [k, r[k]]));

/** "Báo cáo chuyển đổi" along the line: lead managers see everyone, a manager their team, an FC themselves. */
export function LeadReportPage() {
  const today = todayInVietnam();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const report = useQuery(leadReportQuery(from, to));
  const rows = report.data?.items ?? [];
  const metrics = Object.fromEntries(rows.filter((r) => r.agentCode).map((r) => [r.agentCode!, metricsOf(r)]));
  const unassignedRow = rows.find((r) => r.agentCode === null);
  const n = (k: string) => (m: Metrics) => m[k] ?? 0;
  const columns: ReportColumn[] = [
    { label: t.total, value: n("total") },
    { label: t.contacted, value: n("contacted") },
    { label: t.in24h, value: (m) => pct(m.contactedIn24h, m.timedContacts) },
    { label: t.badgeOverdue, value: n("overdue") },
    { label: t.interests.NOT_REACHED, value: n("notReached") },
    { label: t.interests.UNDETERMINED, value: n("undetermined") },
    { label: t.interests.NOT_INTERESTED, value: n("notInterested") },
    { label: t.interests.LIFE, value: n("life") },
    { label: t.interests.HEALTH_CARD, value: n("healthCard") },
    { label: t.opportunities, value: (m) => (m.life ?? 0) + (m.healthCard ?? 0) },
    { label: t.careStatuses.CARING, value: n("caring") },
    { label: t.careStatuses.WON, value: n("won") },
    { label: t.careStatuses.DROPPED, value: n("dropped") },
    { label: t.conversion, value: (m) => pct(m.won, m.total) },
  ];

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t.reportHelp} {vi.reports.hierarchyHelp}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input type="date" className="w-44" aria-label={t.from} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" className="w-44" aria-label={t.to} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Card className="overflow-x-auto p-0 sm:p-0">
        {report.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : report.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(report.error)}</ErrorText>
          </div>
        ) : (
          <HierarchyReport metrics={metrics} unassigned={unassignedRow ? metricsOf(unassignedRow) : null} columns={columns} />
        )}
      </Card>
    </>
  );
}

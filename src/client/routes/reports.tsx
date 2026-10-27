import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { Card, ErrorText, PageTitle } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { todayInVietnam } from "@/client/features/import/upload";
import { HierarchyReport, type Metrics, type ReportColumn } from "@/client/components/hierarchy-report";
import { activityReportQuery, errorText } from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import { ACTION_KINDS } from "@/shared/enums";

const t = vi.reports;
const tab = "-mb-px h-[35px] shrink-0 border-b-2 border-transparent px-[11.4px] text-base leading-7 font-bold whitespace-nowrap text-muted-foreground hover:text-nav";

/** Báo cáo: its own menu section, one tab per report. */
export function ReportsLayout() {
  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <nav className="flex gap-1 overflow-x-auto border-b border-border">
        <Link to="/reports/conversion" className={tab} activeProps={{ className: "border-blue-100! text-link!" }}>
          {t.conversion}
        </Link>
        <Link to="/reports/activities" className={tab} activeProps={{ className: "border-blue-100! text-link!" }}>
          {t.activities}
        </Link>
      </nav>
      <Outlet />
    </>
  );
}

/** "Hoạt động đại lý" along the line: actions per agent, the leading signal for conversion. */
export function ActivityReportPage() {
  const today = todayInVietnam();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const report = useQuery(activityReportQuery(from, to));
  const metrics: Record<string, Metrics> = Object.fromEntries(
    (report.data?.items ?? []).map((r) => [r.agentCode, { ...r.counts, total: r.total, won: r.won, fromCrm: r.fromCrm, fromSuccess: r.fromSuccess }]),
  );
  const n = (k: string) => (m: Metrics) => m[k] ?? 0;
  const columns: ReportColumn[] = [
    ...ACTION_KINDS.map((k) => ({ label: t.kinds[k], value: n(k) })),
    { label: t.total, value: n("total") },
    { label: t.won, value: n("won") },
    { label: t.fromCrm, value: n("fromCrm") },
    { label: t.fromSuccess, value: n("fromSuccess") },
  ];

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t.activitiesHelp} {t.hierarchyHelp}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input type="date" className="w-44" aria-label={vi.leads.from} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" className="w-44" aria-label={vi.leads.to} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Card className="overflow-x-auto p-0 sm:p-0">
        {report.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : report.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(report.error)}</ErrorText>
          </div>
        ) : (
          <HierarchyReport metrics={metrics} columns={columns} />
        )}
      </Card>
    </>
  );
}

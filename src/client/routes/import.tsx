import { keepPreviousData, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, PageTitle } from "@/client/components/ui/card";
import { Field, Input } from "@/client/components/ui/input";
import { downloadSuccessTemplate } from "@/client/features/import/templates";
import { checkWorkbook, downloadErrorReport, todayInVietnam, totals, WorkbookError } from "@/client/features/import/upload";
import { api, can, errorText, formatDateTime, importErrorsQuery, importsQuery, meQuery, rejectedQuery, type Import } from "@/client/lib/api";
import { importReasons } from "@/i18n/vi";
import { vi } from "@/i18n/vi";

const t = vi.imports;

export function ImportPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [snapshotDate, setSnapshotDate] = useState(todayInVietnam);
  const [progress, setProgress] = useState<string | null>(null);
  const [checked, setChecked] = useState<Import | null>(null);
  const [done, setDone] = useState<Import | null>(null);

  const refreshHistory = () => queryClient.invalidateQueries({ queryKey: ["imports"] });
  const check = useMutation({
    mutationFn: () => checkWorkbook(file!, snapshotDate, setProgress),
    onSuccess: setChecked,
    onSettled: () => {
      setProgress(null);
      void refreshHistory();
    },
  });
  const commit = useMutation({
    mutationFn: (id: string) => api<Import>(`/api/imports/${id}/commit`, { method: "POST" }),
    onSuccess: (imp) => {
      setChecked(null);
      setDone(imp);
      void refreshHistory();
      // The agent tree may have changed.
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  function reset() {
    setFile(null);
    setChecked(null);
    setDone(null);
    check.reset();
    commit.reset();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (file) check.mutate();
  }

  return (
    <>
      <PageTitle>{t.title}</PageTitle>

      {done || checked ? (
        <ImportPreview
          imp={(done ?? checked)!}
          committing={commit.isPending}
          commitError={commit.error}
          onCommit={() => checked && commit.mutate(checked.id)}
          onReset={reset}
        />
      ) : (
        <Card>
          <form onSubmit={submit} className="grid gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <p className="text-sm text-muted-foreground">{t.intro}</p>
                <p className="text-sm text-muted-foreground">{vi.templates.successHint}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void downloadSuccessTemplate()}>
                {vi.templates.download}
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <Field label={t.file} htmlFor="import-file">
                <Input
                  id="import-file"
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  required
                  className="py-2"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Field>
              <Field label={t.snapshotDate} htmlFor="import-date">
                <Input id="import-date" type="date" required max={todayInVietnam()} value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)} />
              </Field>
            </div>
            <ErrorText>{check.isError ? (check.error instanceof WorkbookError ? check.error.message : errorText(check.error)) : null}</ErrorText>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!file || check.isPending}>
                {t.check}
              </Button>
              {progress && (
                <span role="status" className="text-sm text-muted-foreground">
                  {progress}
                </span>
              )}
            </div>
          </form>
        </Card>
      )}

      <History />
    </>
  );
}

/** The preview of a checked import with the confirm button, or the result once committed. */
export function ImportPreview({
  imp,
  committing,
  commitError,
  onCommit,
  onReset,
}: {
  imp: Import;
  committing: boolean;
  commitError: unknown;
  onCommit: () => void;
  onReset: () => void;
}) {
  const sums = totals(imp);
  if (imp.status === "COMMITTED") {
    return (
      <Card className="grid gap-3 bg-highlight shadow-ring-highlight">
        <CardTitle>{t.doneTitle}</CardTitle>
        <p className="text-sm">{t.doneSummary(sums.inserted, sums.updated, sums.rejected)}</p>
        {!imp.fileKept && <p className="text-sm text-muted-foreground">{t.fileNotKept}</p>}
        <SheetTable imp={imp} />
        <Reimport imp={imp} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={onReset}>{t.another}</Button>
          <ErrorReportButton imp={imp} />
        </div>
      </Card>
    );
  }
  const rows = sums.inserted + sums.updated;
  return (
    <Card className="grid gap-4">
      <div>
        <CardTitle>{t.previewTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {imp.fileName} · {t.previewHelp}
        </p>
      </div>
      <SheetTable imp={imp} />
      <Reimport imp={imp} />
      <ErrorList imp={imp} />
      <ErrorText>{commitError ? errorText(commitError) : null}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button disabled={committing || rows === 0} onClick={onCommit}>
          {committing ? t.progress.committing : t.confirm(rows)}
        </Button>
        <Button variant="ghost" disabled={committing} onClick={onReset}>
          {t.discard}
        </Button>
      </div>
      {rows === 0 && <p className="text-sm text-muted-foreground">{t.nothingToImport}</p>}
    </Card>
  );
}

function SheetTable({ imp }: { imp: Import }) {
  const tone = { READY: "success", BLOCKED: "destructive", LATER: "neutral" } as const;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t.sheet}</th>
            {[t.found, t.inserted, t.updated, t.rejected, t.skipped, t.warnings].map((h) => (
              <th key={h} className="px-3 py-2 text-right font-medium">
                {h}
              </th>
            ))}
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {Object.entries(imp.sheets)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, s]) => (
              <tr key={name}>
                <td className="px-3 py-2 font-mono text-xs">{name}</td>
                {[s.found, s.inserted, s.updated, s.rejected, s.skipped ?? 0, s.warnings].map((n, i) => (
                  <td key={i} className={`px-3 py-2 text-right tabular-nums ${i === 3 && n > 0 ? "font-semibold text-destructive" : ""}`}>
                    {s.status === "READY" ? n : vi.common.none}
                  </td>
                ))}
                <td className="px-3 py-2 text-right">
                  <Badge tone={tone[s.status]}>{t.sheetStatus[s.status]}</Badge>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorList({ imp }: { imp: Import }) {
  const errors = useQuery(importErrorsQuery(imp.id));
  if (!errors.data || errors.data.total === 0) return null;
  const { items, total } = errors.data;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t.errorsTitle(total)}</h3>
        <ErrorReportButton imp={imp} />
      </div>
      <ul className="grid gap-1.5 text-sm">
        {items.map((e, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-muted/60 px-3 py-2">
            <Badge tone={e.severity === "error" ? "destructive" : "warning"}>{t.severity[e.severity]}</Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {e.sheet} · {t.rowLabel(e.row)}
              {e.column ? ` · ${e.column}` : ""}
            </span>
            <span className="basis-full">{e.message}</span>
          </li>
        ))}
      </ul>
      {total > items.length && <p className="text-sm text-muted-foreground">{t.errorsMore(total - items.length)}</p>}
    </div>
  );
}

/** Item 6: which records were not imported and must be fixed and uploaded again. */
function Reimport({ imp }: { imp: Import }) {
  const rejected = useQuery(rejectedQuery(imp.id));
  const blocked = Object.entries(imp.sheets).filter(([, s]) => s.status === "BLOCKED").map(([name]) => name);
  if (!rejected.data || (rejected.data.total === 0 && blocked.length === 0)) return null;
  const { items, bySheet, total } = rejected.data;
  const sheets = [...new Set(bySheet.map((r) => r.sheet))];
  return (
    <div className="grid gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <div>
        <h3 className="text-sm font-semibold text-destructive">{t.reimportTitle(total)}</h3>
        {blocked.length > 0 && <p className="text-sm font-medium">{t.reimportBlocked(blocked.join(", "))}</p>}
        {total > 0 && <p className="text-sm text-muted-foreground">{t.reimportHelp}</p>}
      </div>
      <ul className="grid gap-1 text-sm">
        {sheets.map((sheet) => (
          <li key={sheet}>
            <span className="font-mono text-xs">{sheet}</span>:{" "}
            {bySheet
              .filter((r) => r.sheet === sheet)
              .map((r) => `${importReasons[r.code] ?? r.code} (${r.rows})`)
              .join(", ")}
          </li>
        ))}
      </ul>
      {items.length > 0 && <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">{t.sheet}</th>
              <th className="py-1.5 pr-3 font-medium">{t.report.row}</th>
              <th className="py-1.5 pr-3 font-medium">{t.recordKey}</th>
              <th className="py-1.5 font-medium">{t.reasons}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-destructive/15">
            {items.map((r) => (
              <tr key={`${r.sheet}:${r.row}`}>
                <td className="py-1.5 pr-3 font-mono text-xs">{r.sheet}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.row}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{r.recordKey ?? vi.common.none}</td>
                <td className="py-1.5">{r.codes.map((c) => importReasons[c] ?? c).join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {total > items.length && <p className="text-sm text-muted-foreground">{t.reimportMore(total - items.length)}</p>}
    </div>
  );
}

function ErrorReportButton({ imp }: { imp: Import }) {
  const report = useMutation({ mutationFn: () => downloadErrorReport(imp) });
  const { rejected, warnings } = totals(imp);
  const blocked = Object.values(imp.sheets).some((s) => s.status === "BLOCKED");
  if (rejected + warnings === 0 && !blocked) return null;
  return (
    <Button variant="outline" size="sm" disabled={report.isPending} onClick={() => report.mutate()}>
      {t.downloadErrors}
    </Button>
  );
}

function History() {
  const { data: me } = useSuspenseQuery(meQuery);
  const seesAll = can(me, "imports.view_all");
  const [page, setPage] = useState(1);
  const history = useQuery({ ...importsQuery(page), placeholderData: keepPreviousData });
  const pages = history.data ? Math.max(1, Math.ceil(history.data.total / history.data.pageSize)) : 1;
  const tone = { COMMITTED: "success", FAILED: "neutral", PARSING: "warning", VALIDATED: "warning" } as const;

  return (
    <section className="grid gap-3">
      <h2 className="text-base font-semibold">{t.historyTitle}</h2>
      <Card className="overflow-x-auto p-0 sm:p-0">
        {history.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : history.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(history.error)}</ErrorText>
          </div>
        ) : history.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{seesAll ? t.historyEmpty : t.empty}</p>
        ) : (
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t.when}</th>
                <th className="px-4 py-2.5 font-medium">{t.fileName}</th>
                {seesAll && <th className="px-4 py-2.5 font-medium">{t.uploader}</th>}
                <th className="px-4 py-2.5 font-medium">{t.result}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.data.items.map((imp) => (
                <tr key={imp.id}>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDateTime(imp.createdAt)}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{imp.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.snapshotDate}: {imp.snapshotDate.split("-").reverse().join("/")}
                    </p>
                  </td>
                  {seesAll && <td className="px-4 py-3">{imp.userName}</td>}
                  <td className="px-4 py-3">
                    <Badge tone={tone[imp.status]}>{t.status[imp.status]}</Badge>
                    {imp.status === "COMMITTED" && (
                      <p className="mt-1 text-xs text-muted-foreground">{t.resultSummary(totals(imp).inserted, totals(imp).updated, totals(imp).rejected)}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ErrorReportButton imp={imp} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {vi.common.prev}
          </Button>
          {vi.common.pageOf(page, pages)}
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {vi.common.next}
          </Button>
        </div>
      )}
    </section>
  );
}

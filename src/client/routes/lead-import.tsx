import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Card, CardTitle, ErrorText, PageTitle } from "@/client/components/ui/card";
import { Field, Input, Select } from "@/client/components/ui/input";
import { downloadLeadTemplate } from "@/client/features/import/templates";
import { submitWorkbook, todayInVietnam } from "@/client/features/import/upload";
import { agentTreeQuery, api, errorText, type Import } from "@/client/lib/api";
import { ImportPreview } from "@/client/routes/import";
import { vi } from "@/i18n/vi";
import type { SourceSheet } from "@/shared/import/lead-sheet";
import { SHEETS } from "@/shared/import/template";

const t = vi.leads;
const def = SHEETS["13_Leads"];
type Book = { file: File; buffer: ArrayBuffer; names: string[]; wb: unknown };

/** F3.2: import a GA's own lead sheet, mapping its columns and agent names. */
export function LeadImportPage() {
  const queryClient = useQueryClient();
  const agents = useQuery(agentTreeQuery);
  const [book, setBook] = useState<Book | null>(null);
  const [sheet, setSheet] = useState<SourceSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [agentCodes, setAgentCodes] = useState<Record<string, string | null>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const [checked, setChecked] = useState<Import | null>(null);
  const lib = useQuery({ queryKey: ["lead-sheet-lib"], queryFn: () => import("@/shared/import/lead-sheet"), staleTime: Infinity });

  async function openFile(file: File) {
    const L = lib.data ?? (await import("@/shared/import/lead-sheet"));
    const buffer = await file.arrayBuffer();
    const wb = L.openWorkbook(buffer);
    const names = L.sheetNames(wb);
    setBook({ file, buffer, names, wb });
    setChecked(null);
    choose(names[0]!, wb);
  }

  function choose(name: string, wb = book?.wb) {
    const L = lib.data!;
    const s = L.readSheet(wb as Parameters<typeof L.readSheet>[0], name);
    const m = L.autoMap(s.headers);
    setSheet(s);
    setMapping(m);
    setAgentCodes(Object.fromEntries(L.distinctValues(s, m.assigned_agent_code ?? -1).map((v) => [v, L.matchAgent(v, agents.data?.items ?? [])])));
  }

  const agentValues = useMemo(() => (sheet && lib.data ? lib.data.distinctValues(sheet, mapping.assigned_agent_code ?? -1) : []), [sheet, mapping.assigned_agent_code, lib.data]);
  const banned = sheet && lib.data ? lib.data.bannedColumns(sheet.headers) : [];
  const missing = def.columns.filter((c) => c.required && (mapping[c.db] ?? -1) < 0).map((c) => c.header);

  const check = useMutation({
    mutationFn: async () => {
      const L = lib.data!;
      const leadsSheet = L.toLeadsSheet(sheet!, mapping, agentCodes);
      return submitWorkbook({ sheets: [leadsSheet], later: [] }, `${book!.file.name} · ${sheet!.name}`, book!.buffer, todayInVietnam(), setProgress, banned.length > 0);
    },
    onSuccess: setChecked,
    onSettled: () => setProgress(null),
  });
  const commit = useMutation({
    mutationFn: (id: string) => api<Import>(`/api/imports/${id}/commit`, { method: "POST" }),
    onSuccess: async (imp) => {
      setChecked(imp);
      await queryClient.invalidateQueries({ queryKey: ["leads"] });
      await queryClient.invalidateQueries({ queryKey: ["imports"] });
    },
  });

  const setAgentMapping = (column: number) => {
    const next = { ...mapping, assigned_agent_code: column };
    setMapping(next);
    if (sheet && lib.data) {
      setAgentCodes(Object.fromEntries(lib.data.distinctValues(sheet, column).map((v) => [v, lib.data!.matchAgent(v, agents.data?.items ?? [])])));
    }
  };

  return (
    <>
      <Link to="/leads" className="text-sm text-muted-foreground hover:text-foreground">
        {t.back}
      </Link>
      <PageTitle>{t.importTitle}</PageTitle>

      {checked ? (
        <ImportPreview
          imp={checked}
          committing={commit.isPending}
          commitError={commit.error}
          onCommit={() => commit.mutate(checked.id)}
          onReset={() => {
            setChecked(null);
            setBook(null);
            setSheet(null);
            commit.reset();
          }}
        />
      ) : (
        <Card className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">{t.importIntro}</p>
              <p className="text-sm text-muted-foreground">{vi.templates.leadHint}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void downloadLeadTemplate()}>
              {vi.templates.download}
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={vi.imports.file} htmlFor="lead-file">
              <Input id="lead-file" type="file" accept=".xlsx,.xls,.csv" className="py-2" onChange={(e) => e.target.files?.[0] && void openFile(e.target.files[0])} />
            </Field>
            {book && (
              <Field label={t.pickSheet} htmlFor="lead-sheet" hint={sheet ? t.headerAt(sheet.headerRow, sheet.rows.length) : undefined}>
                <Select id="lead-sheet" value={sheet?.name ?? ""} onChange={(e) => choose(e.target.value)}>
                  {book.names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {sheet && (
            <>
              {banned.length > 0 && <p className="rounded-md bg-blue-10 p-3 text-sm text-nav shadow-ring-highlight">{t.bannedNote(banned.join(", "))}</p>}
              <div className="grid gap-2">
                <CardTitle className="text-sm">{t.mappingTitle}</CardTitle>
                <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {def.columns.map((c) => (
                    <label key={c.db} className="grid grid-cols-[1fr_1.2fr] items-center gap-2 text-sm">
                      <span>
                        {c.header}
                        {c.required && <span className="text-destructive"> *</span>}
                      </span>
                      <Select
                        value={mapping[c.db] ?? -1}
                        onChange={(e) => (c.db === "assigned_agent_code" ? setAgentMapping(Number(e.target.value)) : setMapping({ ...mapping, [c.db]: Number(e.target.value) }))}
                      >
                        <option value={-1}>{t.notMapped}</option>
                        {sheet.headers.map((h, i) =>
                          h && !banned.includes(h) ? (
                            <option key={i} value={i}>
                              {h.replace(/\s+/g, " ")}
                            </option>
                          ) : null,
                        )}
                      </Select>
                    </label>
                  ))}
                </div>
              </div>

              {agentValues.length > 0 && (
                <div className="grid gap-2">
                  <CardTitle className="text-sm">{t.agentMappingTitle}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {t.agentMappingHelp} {Object.values(agentCodes).filter((v) => !v).length > 0 && <strong>{t.unmatched(Object.values(agentCodes).filter((v) => !v).length)}</strong>}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {agentValues.map((v) => (
                      <label key={v} className="grid grid-cols-[1fr_1.4fr] items-center gap-2 text-sm">
                        <span className="truncate">{v}</span>
                        <Select value={agentCodes[v] ?? ""} onChange={(e) => setAgentCodes({ ...agentCodes, [v]: e.target.value || null })}>
                          <option value="">{t.noAgent}</option>
                          {agents.data?.items.map((a) => (
                            <option key={a.agentCode} value={a.agentCode}>
                              {a.name} ({a.agentCode})
                            </option>
                          ))}
                        </Select>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {missing.length > 0 && <ErrorText>{t.missingRequired(missing.join(", "))}</ErrorText>}
              <ErrorText>{check.isError ? errorText(check.error) : null}</ErrorText>
              <div className="flex items-center gap-3">
                <Button disabled={missing.length > 0 || check.isPending || !lib.data} onClick={() => check.mutate()}>
                  {t.check}
                </Button>
                {progress && <span className="text-sm text-muted-foreground">{progress}</span>}
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge } from "@/client/components/ui/card";
import { agentTreeQuery } from "@/client/lib/api";
import { vi } from "@/i18n/vi";

export type Metrics = Record<string, number>;
export type ReportColumn = { label: string; value: (m: Metrics) => string | number };

const add = (a: Metrics, b: Metrics) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

type Row = { key: string; code: string; name: string; rank: string; depth: number; group: boolean; parents: string[]; total: Metrics };

/**
 * A report laid out along the agent tree the viewer can see (GA Head > BM > UM > FC).
 * A manager with a team gets a group row ("Ban kinh doanh D", "Phòng kinh doanh A") with the
 * whole team's total; inside it the manager's own numbers stand on a separate row, before the
 * units and the individuals below them. Groups fold. Agents without data show zeros so nobody
 * in the line is missed.
 */
export function HierarchyReport({ metrics, unassigned, columns }: { metrics: Record<string, Metrics>; unassigned?: Metrics | null; columns: ReportColumn[] }) {
  const tree = useQuery(agentTreeQuery);
  const [folded, setFolded] = useState<Set<string> | null>(null);

  const rows = useMemo(() => {
    const agents = tree.data?.items ?? [];
    const visible = new Set(agents.map((a) => a.agentCode));
    // Parent = the nearest visible manager on the path.
    const parentOf = (a: (typeof agents)[number]) => a.path.split("/").filter((c) => c && c !== a.agentCode && visible.has(c)).at(-1) ?? null;
    const children = new Map<string | null, typeof agents>();
    for (const a of agents) {
      const p = parentOf(a);
      children.set(p, [...(children.get(p) ?? []), a]);
    }
    const teamTotal = (code: string): Metrics => (children.get(code) ?? []).reduce((m, x) => add(m, teamTotal(x.agentCode)), metrics[code] ?? {});
    const hasTeam = (code: string) => (children.get(code)?.length ?? 0) > 0;
    // Units first, then individuals; by name within each.
    const ordered = (list: typeof agents) =>
      [...list].sort((a, b) => Number(hasTeam(b.agentCode)) - Number(hasTeam(a.agentCode)) || a.name.localeCompare(b.name, "vi"));

    const list: Row[] = [];
    const walk = (a: (typeof agents)[number], depth: number, parents: string[]) => {
      const own = { code: a.agentCode, name: a.name, rank: a.rank };
      if (!hasTeam(a.agentCode)) {
        list.push({ ...own, key: a.agentCode, depth, group: false, parents, total: metrics[a.agentCode] ?? {} });
        return;
      }
      const key = `group:${a.agentCode}`;
      list.push({ ...own, key, depth, group: true, parents, total: teamTotal(a.agentCode) });
      const inside = [...parents, key];
      list.push({ ...own, key: a.agentCode, depth: depth + 1, group: false, parents: inside, total: metrics[a.agentCode] ?? {} });
      for (const c of ordered(children.get(a.agentCode)!)) walk(c, depth + 1, inside);
    };
    for (const a of ordered(children.get(null) ?? [])) walk(a, 0, []);
    // Agents with data that are not (yet) in the tree.
    for (const code of Object.keys(metrics)) {
      if (!visible.has(code)) list.push({ key: code, code, name: code, rank: "FC", depth: 0, group: false, parents: [], total: metrics[code]! });
    }
    return list;
  }, [tree.data, metrics]);

  // By default, groups below the second level are folded.
  const isFolded = (key: string) => (folded ? folded.has(key) : (rows.find((r) => r.key === key)?.depth ?? 0) >= 2);
  const toggle = (key: string) => {
    const next = new Set(folded ?? rows.filter((r) => r.group && isFolded(r.key)).map((r) => r.key));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFolded(next);
  };
  const shown = rows.filter((r) => !r.parents.some(isFolded));
  const grand = add(
    Object.values(metrics).reduce((m, x) => add(m, x), {} as Metrics),
    unassigned ?? {},
  );

  if (tree.isPending) return <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>;
  return (
    <table className="w-full min-w-[72rem] text-right text-sm tabular-nums">
      <thead className="border-b border-border text-xs text-muted-foreground">
        <tr>
          <th className="px-3 py-2.5 text-left font-medium">{vi.leads.agent}</th>
          {columns.map((c) => (
            <th key={c.label} className="px-3 py-2.5 font-medium">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {shown.map((r) => (
          <tr key={r.key} className={r.group ? "bg-muted/40 font-semibold" : ""}>
            <td className="px-3 py-2.5 text-left">
              <span className="flex items-center gap-2" style={{ paddingLeft: `${r.depth * 1.25}rem` }}>
                {r.group ? (
                  <button type="button" className="w-4 cursor-pointer text-link" aria-label={vi.reports.group(r.rank, r.name)} onClick={() => toggle(r.key)}>
                    {isFolded(r.key) ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="w-4" />
                )}
                {r.group ? (
                  <span>{vi.reports.group(r.rank, r.name)}</span>
                ) : (
                  <>
                    <Badge tone={r.rank === "FC" ? "neutral" : "warning"}>{r.rank}</Badge>
                    <span>{r.name}</span>
                  </>
                )}
              </span>
            </td>
            {columns.map((c) => (
              <td key={c.label} className="px-3 py-2.5">
                {c.value(r.total)}
              </td>
            ))}
          </tr>
        ))}
        {unassigned && (
          <tr>
            <td className="px-3 py-2.5 text-left text-muted-foreground">{vi.leads.unassigned}</td>
            {columns.map((c) => (
              <td key={c.label} className="px-3 py-2.5">
                {c.value(unassigned)}
              </td>
            ))}
          </tr>
        )}
        <tr className="bg-blue-10 font-semibold">
          <td className="px-3 py-2.5 text-left">{vi.leads.totalRow}</td>
          {columns.map((c) => (
            <td key={c.label} className="px-3 py-2.5">
              {c.value(grand)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, ErrorText, FilterTab, PageTitle } from "@/client/components/ui/card";
import { Input, Select } from "@/client/components/ui/input";
import { agentTreeQuery, clientCountsQuery, clientsQuery, errorText, meQuery, type ClientFilters, type ClientSignalKey } from "@/client/lib/api";
import { formatDate } from "@/client/routes/leads";
import { vi } from "@/i18n/vi";
import { LOOKUPS } from "@/shared/enums";

const t = vi.clients;
type View = "all" | ClientSignalKey;
const VIEWS: View[] = ["all", "due", "debt", "maturity", "birthday", "lapsed"];
export const signalTone = { due: "warning", debt: "destructive", maturity: "primary", birthday: "primary", lapsed: "destructive" } as const;

/** F8.2: the FC's clients (managers: their line), with what needs care first. */
export function ClientsPage() {
  const { data: me } = useSuspenseQuery(meQuery);
  const [view, setView] = useState<View>("all");
  const [filters, setFilters] = useState<ClientFilters>({});
  const [page, setPage] = useState(1);
  // "Khách hàng của": the signed-in agent's own clients first; managers add FCs or pick everyone. null = everyone in scope.
  const [owners, setOwners] = useState<string[] | null>(me.user.agentCode ? [me.user.agentCode] : null);
  const agents = owners ? owners.join(",") : undefined;
  const list = useQuery({ ...clientsQuery(page, { ...filters, agents, signal: view === "all" ? undefined : view }), placeholderData: keepPreviousData });
  const counts = useQuery({ ...clientCountsQuery(agents), placeholderData: keepPreviousData });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const set = (key: keyof ClientFilters) => (value: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  };

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {VIEWS.map((v) => (
          <FilterTab
            key={v}
            active={view === v}
            onClick={() => {
              setView(v);
              setPage(1);
            }}
          >
            {counts.data ? `${t.views[v]} (${counts.data[v]})` : t.views[v]}
          </FilterTab>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {me.reach !== "OWN" && (
          <AgentPicker
            me={me.user.agentCode}
            value={owners}
            onChange={(v) => {
              setOwners(v);
              setPage(1);
            }}
          />
        )}
        <Input type="search" className={me.reach === "OWN" ? "sm:col-span-3" : "sm:col-span-2"} placeholder={t.searchPlaceholder} aria-label={vi.common.search} value={filters.q ?? ""} onChange={(e) => set("q")(e.target.value)} />
        <Select aria-label={t.tier} value={filters.tier ?? ""} onChange={(e) => set("tier")(e.target.value)}>
          <option value="">{t.allTiers}</option>
          {LOOKUPS.clientTier.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </Select>
      </div>

      <Card className="overflow-x-auto p-0 sm:p-0">
        {list.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : list.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(list.error)}</ErrorText>
          </div>
        ) : list.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 font-medium">{t.customer}</th>
                <th className="px-3 py-2.5 font-medium">{t.profile}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t.activePolicies}</th>
                <th className="px-3 py-2.5 font-medium">{t.nextDue}</th>
                <th className="px-3 py-2.5 font-medium">{t.agent}</th>
                <th className="px-3 py-2.5 font-medium">{t.signalsCol}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.data.items.map((c) => (
                <tr key={c.clientCode} className="hover:bg-muted/40">
                  <td className="px-3 py-3">
                    <Link to="/clients/$code" params={{ code: c.clientCode }} className="font-medium hover:text-primary hover:underline">
                      {c.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">
                      {c.clientCode}
                      {c.tier ? ` · ${c.tier}` : ""}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{[c.ageBand, c.gender].filter(Boolean).join(" · ") || vi.common.none}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.activePolicies}</td>
                  <td className="px-3 py-3 whitespace-nowrap">{c.nextDue ? formatDate(c.nextDue) : <span className="text-muted-foreground">{vi.common.none}</span>}</td>
                  <td className="px-3 py-3">{c.agentNames?.split(",").join(", ") ?? <span className="text-muted-foreground">{vi.common.none}</span>}</td>
                  <td className="px-3 py-3">
                    <span className="flex flex-wrap gap-1">
                      {(Object.keys(signalTone) as ClientSignalKey[])
                        .filter((k) => c[k])
                        .map((k) => (
                          <Badge key={k} tone={signalTone[k]}>
                            {t.badges[k]}
                          </Badge>
                        ))}
                    </span>
                  </td>
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

/** Checkbox list of the agents the viewer may see: everyone, or any set of agents (own clients by default). */
function AgentPicker({ me, value, onChange }: { me: string | null; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const tree = useQuery(agentTreeQuery);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const agents = [...(tree.data?.items ?? [])].sort((a, b) => Number(b.agentCode === me) - Number(a.agentCode === me) || a.path.localeCompare(b.path));
  const depth = (path: string) => path.split("/").filter(Boolean).length;
  const minDepth = Math.min(...agents.map((a) => depth(a.path)));
  const name = (code: string) => (code === me ? t.agentsMine : (agents.find((a) => a.agentCode === code)?.name ?? code));
  const summary = value === null ? t.agentsAll : value.length === 1 ? name(value[0]!) : value.length === 0 ? vi.common.none : t.agentsCount(value.length);
  const toggle = (code: string) => {
    const current = value ?? [];
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    onChange(next.length ? next : me ? [me] : null);
  };
  const check = "size-4 shrink-0 accent-[var(--brand-blue-100)]";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t.agentsFilter}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-md bg-card px-3 text-left text-base font-medium text-nav shadow-ring sm:text-sm"
      >
        <span className="truncate">
          <span className="text-muted-foreground">{t.agentsFilter}: </span>
          {summary}
        </span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute top-12 left-0 z-20 grid max-h-80 w-max max-w-[min(28rem,90vw)] min-w-full overflow-x-hidden overflow-y-auto rounded-md bg-card py-1 text-sm shadow-ring">
          <label className="flex cursor-pointer items-center gap-2 px-3 py-2 font-semibold hover:bg-blue-10">
            <input type="checkbox" className={check} checked={value === null} onChange={() => onChange(value === null ? (me ? [me] : null) : null)} />
            {t.agentsAll}
          </label>
          {agents.map((a) => (
            <label
              key={a.agentCode}
              className="flex cursor-pointer items-center gap-2 py-2 pr-3 hover:bg-blue-10"
              style={{ paddingLeft: `${0.75 + (a.agentCode === me ? 0 : depth(a.path) - minDepth) * 1}rem` }}
            >
              <input type="checkbox" className={check} checked={value?.includes(a.agentCode) ?? false} onChange={() => toggle(a.agentCode)} />
              <span className="truncate">
                {a.agentCode === me ? `${t.agentsMine} (${a.name})` : a.name}
                <span className="ml-1 text-xs text-muted-foreground">
                  {a.rank} · {a.agentCode}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

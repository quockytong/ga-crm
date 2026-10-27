import { useSuspenseQuery } from "@tanstack/react-query";
import { Badge, Card, PageTitle } from "@/client/components/ui/card";
import { meQuery } from "@/client/lib/api";
import { vi } from "@/i18n/vi";

export function HomePage() {
  const { data: me } = useSuspenseQuery(meQuery);
  const rows: [string, React.ReactNode][] = [
    [vi.home.tenant, me.tenant ? `${me.tenant.name} (${me.tenant.gaCode})` : vi.home.platform],
    [
      vi.home.roles,
      <span className="flex flex-wrap gap-1">
        {me.roles.map((r) => (
          <Badge key={r} tone="primary">
            {vi.roles[r]}
          </Badge>
        ))}
      </span>,
    ],
    ...(me.user.agentCode ? [[vi.home.agentCode, <span className="font-mono">{me.user.agentCode}</span>] as [string, React.ReactNode]] : []),
    ...(me.tenant ? [[vi.home.reach, vi.reach[me.reach]] as [string, React.ReactNode]] : []),
  ];
  return (
    <>
      <PageTitle>{vi.home.hello(me.user.name)}</PageTitle>
      <Card>
        <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {me.tenant && <p className="text-sm text-muted-foreground">{vi.home.comingSoon}</p>}
    </>
  );
}

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { AssistantLauncher } from "@/client/components/ai/assistant";
import { FutureLine, Logo } from "@/client/components/brand/dlvn-brand";
import { api, can, meQuery, type Me } from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import type { Role } from "@/shared/enums";

const hasRole = (me: Me, ...roles: Role[]) => roles.some((r) => me.roles.includes(r));

export function navItems(me: Me) {
  return [
    { to: "/", label: vi.nav.home, show: true },
    { to: "/leads", label: vi.nav.leads, show: !!me.tenant },
    { to: "/clients", label: vi.nav.clients, show: !!me.tenant && me.reach !== "NONE" },
    { to: "/reports", label: vi.nav.reports, show: !!me.tenant },
    { to: "/agents", label: vi.nav.agents, show: !!me.tenant },
    { to: "/import", label: vi.nav.imports, show: can(me, "imports.upload") },
    { to: "/users", label: vi.nav.users, show: can(me, "users.manage") },
    { to: "/settings/permissions", label: vi.nav.permissions, show: hasRole(me, "GA_HEAD") },
    { to: "/settings/ai", label: vi.nav.ai, show: !!me.tenant && can(me, "ai.manage") },
    { to: "/platform/tenants", label: vi.nav.tenants, show: hasRole(me, "PLATFORM_ADMIN") },
  ].filter((i) => i.show);
}

/** Page gutters: the DLVN screen frames content with very wide side gutters on large screens. */
export const gutter = "px-4 lg:px-10 2xl:px-[200px]";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** DLVN UserBadge: light-blue card with an italic greeting, the name and the role. */
function UserBadge({ me }: { me: Me }) {
  return (
    <div className="hidden items-center gap-2 rounded-sm bg-blue-20 p-2 sm:flex sm:w-[284px]">
      <span aria-hidden className="flex size-[50px] shrink-0 items-center justify-center rounded-full bg-card text-base font-semibold text-primary">
        {initials(me.user.name)}
      </span>
      <span className="grid min-w-0 gap-0.5 text-nav">
        <span className="text-[11px] font-medium italic">{vi.home.greeting}</span>
        <span className="truncate text-[13px] font-bold">{me.user.name}</span>
        <span className="truncate text-[13px] italic">{me.roles.map((r) => vi.roles[r]).join(", ")}</span>
      </span>
    </div>
  );
}

export function AppShell() {
  const { data: me } = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();

  async function signOut() {
    await api("/api/auth/sign-out", { json: {} }).catch(() => undefined);
    queryClient.clear();
    window.location.assign("/login");
  }

  return (
    <div className="min-h-dvh">
      <FutureLine style={{ width: "100%" }} />
      {/* Utility bar */}
      <div className={`flex h-9 items-center justify-between gap-3 bg-blue-20 text-sm ${gutter}`}>
        <span className="truncate text-nav">
          {vi.appName} · {me.tenant ? `${me.tenant.name} (${me.tenant.gaCode})` : vi.home.platform}
        </span>
        <button type="button" onClick={signOut} className="shrink-0 cursor-pointer font-medium text-nav hover:text-primary">
          {vi.nav.signOut}
        </button>
      </div>
      <header className="border-b border-border bg-card">
        <div className={`flex items-center justify-between gap-4 py-3 ${gutter}`}>
          <Link to="/" aria-label={vi.appName} className="shrink-0">
            <Logo state="logo daiichi life 2026" />
          </Link>
          <UserBadge me={me} />
        </div>
        <nav className={`flex overflow-x-auto ${gutter}`}>
          {navItems(me).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="flex h-[45px] shrink-0 items-center px-4 text-base leading-[23px] font-medium whitespace-nowrap text-nav hover:bg-blue-10 sm:text-lg"
              activeProps={{ className: "bg-blue-40 hover:bg-blue-40!" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className={`grid gap-5 py-6 ${gutter}`}>
        <Outlet />
      </main>
      <AssistantLauncher />
    </div>
  );
}

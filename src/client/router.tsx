import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/client/components/app-shell";
import { ApiError, can, meQuery, type Me } from "@/client/lib/api";
import { PermissionsPage } from "@/client/routes/permissions";
import { AcceptInvitePage } from "@/client/routes/accept-invite";
import { AgentsPage } from "@/client/routes/agents";
import { ClientDetailPage } from "@/client/routes/client-detail";
import { AiSettingsPage } from "@/client/routes/ai-settings";
import { ClientsPage } from "@/client/routes/clients";
import { HomePage } from "@/client/routes/home";
import { ImportPage } from "@/client/routes/import";
import { LeadDetailPage } from "@/client/routes/lead-detail";
import { LeadImportPage } from "@/client/routes/lead-import";
import { LeadReportPage } from "@/client/routes/lead-report";
import { LeadsPage } from "@/client/routes/leads";
import { ActivityReportPage, ReportsLayout } from "@/client/routes/reports";
import { LoginPage } from "@/client/routes/login";
import { TenantsPage } from "@/client/routes/tenants";
import { UsersPage } from "@/client/routes/users";
import { vi } from "@/i18n/vi";
import type { Role } from "@/shared/enums";
import type { Permission } from "@/shared/permissions";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { activated?: boolean } => ({
    activated: s.activated === true || s.activated === "true" || undefined,
  }),
  component: LoginPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: AcceptInvitePage,
});

// Everything below needs a session. These guards are for navigation only;
// the API enforces access on every request.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context }): Promise<{ me: Me }> => {
    try {
      return { me: await context.queryClient.ensureQueryData(meQuery) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw redirect({ to: "/login" });
      throw e;
    }
  },
  component: AppShell,
});

const only = (me: Me, ...roles: Role[]) => {
  if (!roles.some((r) => me.roles.includes(r))) throw redirect({ to: "/" });
};
const allowed = (me: Me, permission: Permission) => {
  if (!can(me, permission)) throw redirect({ to: "/" });
};

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });
const agentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agents",
  beforeLoad: ({ context }) => {
    if (!context.me.tenant) throw redirect({ to: "/" });
  },
  component: AgentsPage,
});
const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/users",
  beforeLoad: ({ context }) => allowed(context.me, "users.manage"),
  component: UsersPage,
});
const importRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/import",
  beforeLoad: ({ context }) => allowed(context.me, "imports.upload"),
  component: ImportPage,
});
const tenantOnly = ({ context }: { context: { me: Me } }) => {
  if (!context.me.tenant) throw redirect({ to: "/" });
};
const leadsRoute = createRoute({ getParentRoute: () => appRoute, path: "/leads", beforeLoad: tenantOnly, component: LeadsPage });
const reportsRoute = createRoute({ getParentRoute: () => appRoute, path: "/reports", beforeLoad: tenantOnly, component: ReportsLayout });
const reportsIndexRoute = createRoute({
  getParentRoute: () => reportsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/reports/conversion" });
  },
});
const conversionRoute = createRoute({ getParentRoute: () => reportsRoute, path: "/conversion", component: LeadReportPage });
const activityReportRoute = createRoute({ getParentRoute: () => reportsRoute, path: "/activities", component: ActivityReportPage });
const leadImportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/leads/import",
  beforeLoad: ({ context }) => allowed(context.me, "leads.import"),
  component: LeadImportPage,
});
const leadDetailRoute = createRoute({ getParentRoute: () => appRoute, path: "/leads/$id", beforeLoad: tenantOnly, component: LeadDetailPage });
// F8: agents (own clients, managers their line) and the GA Head; Marketing and Admin have no client scope.
const withClients = ({ context }: { context: { me: Me } }) => {
  if (!context.me.tenant || context.me.reach === "NONE") throw redirect({ to: "/" });
};
const clientsRoute = createRoute({ getParentRoute: () => appRoute, path: "/clients", beforeLoad: withClients, component: ClientsPage });
const clientDetailRoute = createRoute({ getParentRoute: () => appRoute, path: "/clients/$code", beforeLoad: withClients, component: ClientDetailPage });
const permissionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/permissions",
  beforeLoad: ({ context }) => only(context.me, "GA_HEAD"),
  component: PermissionsPage,
});
const aiSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/ai",
  beforeLoad: ({ context }) => allowed(context.me, "ai.manage"),
  component: AiSettingsPage,
});
const tenantsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/platform/tenants",
  beforeLoad: ({ context }) => only(context.me, "PLATFORM_ADMIN"),
  component: TenantsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  appRoute.addChildren([
    homeRoute,
    leadsRoute,
    reportsRoute.addChildren([reportsIndexRoute, conversionRoute, activityReportRoute]),
    leadImportRoute,
    leadDetailRoute,
    clientsRoute,
    clientDetailRoute,
    agentsRoute,
    importRoute,
    usersRoute,
    permissionsRoute,
    aiSettingsRoute,
    tenantsRoute,
  ]),
]);

export function buildRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPendingComponent: () => <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>,
    defaultErrorComponent: () => <p className="p-4 text-sm text-destructive">{vi.errors.internal}</p>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}

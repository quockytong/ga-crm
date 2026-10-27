import type { AgentRank, Role } from "../shared/enums";
import type { Db } from "./client";
import { defaultGrantRows } from "../shared/permissions";
import { accounts, agents, rolePermissions, tenants, userRoles, users } from "./schema";

/**
 * Demo data for local development and tests: 2 tenants, a full hierarchy
 * (GAD > BM > UM > FC), GA Head, Marketing and Admin users, and one Platform Admin.
 * Never run against the production database.
 */

/** Local development sign-in password for every seeded user. */
export const DEV_PASSWORD = "ga-crm-dev-2026";

type SeedAgent = { code: string; name: string; rank: AgentRank; manager: string | null };
type SeedUser = { email: string; name: string; roles: Role[]; agentCode?: string };

const tenant = (id: string, gaCode: string, name: string) => ({ id, gaCode, name });

export const GA1 = tenant("tenant-ga1", "GA-HCM-012", "GA Sài Gòn Demo");
export const GA2 = tenant("tenant-ga2", "GA-HN-007", "GA Hà Nội Demo");

export const GA1_AGENTS: SeedAgent[] = [
  { code: "9000900", name: "Lý Minh Giám Đốc", rank: "BM", manager: null },
  { code: "9000500", name: "Phạm Thị Trưởng Ban", rank: "BM", manager: "9000900" },
  { code: "9000600", name: "Đỗ Văn Trưởng Ban", rank: "BM", manager: "9000900" },
  { code: "9000100", name: "Trần Văn Quản Lý", rank: "UM", manager: "9000500" },
  { code: "9000200", name: "Vũ Thị Quản Lý", rank: "UM", manager: "9000500" },
  { code: "9000300", name: "Hồ Văn Quản Lý", rank: "UM", manager: "9000600" },
  { code: "9000001", name: "Nguyễn Thị Demo", rank: "FC", manager: "9000100" },
  { code: "9000002", name: "Lê Văn Tư Vấn", rank: "FC", manager: "9000100" },
  { code: "9000003", name: "Bùi Thị Tư Vấn", rank: "FC", manager: "9000200" },
  { code: "9000004", name: "Đặng Văn Tư Vấn", rank: "FC", manager: "9000300" },
];

export const GA2_AGENTS: SeedAgent[] = [
  { code: "9100900", name: "Ngô Văn Giám Đốc", rank: "BM", manager: null },
  { code: "9100500", name: "Dương Thị Trưởng Ban", rank: "BM", manager: "9100900" },
  { code: "9100100", name: "Đinh Văn Quản Lý", rank: "UM", manager: "9100500" },
  { code: "9100001", name: "Mai Thị Tư Vấn", rank: "FC", manager: "9100100" },
  { code: "9100002", name: "Cao Văn Tư Vấn", rank: "FC", manager: "9100100" },
];

export const GA1_USERS: SeedUser[] = [
  { email: "head@ga1.test", name: "Trương Thị Chủ GA", roles: ["GA_HEAD"] },
  { email: "marketing@ga1.test", name: "Phan Thị Marketing", roles: ["MARKETING"] },
  { email: "admin@ga1.test", name: "Võ Văn Admin", roles: ["ADMIN"] },
  { email: "gad@ga1.test", name: "Lý Minh Giám Đốc", roles: ["GAD", "BM"], agentCode: "9000900" },
  { email: "bm1@ga1.test", name: "Phạm Thị Trưởng Ban", roles: ["BM"], agentCode: "9000500" },
  { email: "bm2@ga1.test", name: "Đỗ Văn Trưởng Ban", roles: ["BM"], agentCode: "9000600" },
  { email: "um1@ga1.test", name: "Trần Văn Quản Lý", roles: ["UM"], agentCode: "9000100" },
  { email: "um2@ga1.test", name: "Vũ Thị Quản Lý", roles: ["UM"], agentCode: "9000200" },
  { email: "um3@ga1.test", name: "Hồ Văn Quản Lý", roles: ["UM"], agentCode: "9000300" },
  { email: "fc1@ga1.test", name: "Nguyễn Thị Demo", roles: ["FC"], agentCode: "9000001" },
  { email: "fc2@ga1.test", name: "Lê Văn Tư Vấn", roles: ["FC"], agentCode: "9000002" },
  { email: "fc3@ga1.test", name: "Bùi Thị Tư Vấn", roles: ["FC"], agentCode: "9000003" },
  { email: "fc4@ga1.test", name: "Đặng Văn Tư Vấn", roles: ["FC"], agentCode: "9000004" },
];

export const GA2_USERS: SeedUser[] = [
  { email: "head@ga2.test", name: "Tạ Văn Chủ GA", roles: ["GA_HEAD"] },
  { email: "marketing@ga2.test", name: "Lâm Thị Marketing", roles: ["MARKETING"] },
  { email: "admin@ga2.test", name: "Kiều Văn Admin", roles: ["ADMIN"] },
  { email: "gad@ga2.test", name: "Ngô Văn Giám Đốc", roles: ["GAD", "BM"], agentCode: "9100900" },
  { email: "bm1@ga2.test", name: "Dương Thị Trưởng Ban", roles: ["BM"], agentCode: "9100500" },
  { email: "um1@ga2.test", name: "Đinh Văn Quản Lý", roles: ["UM"], agentCode: "9100100" },
  { email: "fc1@ga2.test", name: "Mai Thị Tư Vấn", roles: ["FC"], agentCode: "9100001" },
  { email: "fc2@ga2.test", name: "Cao Văn Tư Vấn", roles: ["FC"], agentCode: "9100002" },
];

export const PLATFORM_USER: SeedUser = {
  email: "platform@dlvn.test",
  name: "DLVN Innovation",
  roles: ["PLATFORM_ADMIN"],
};

export const userId = (email: string) => `user-${email}`;

function pathOf(code: string, all: SeedAgent[]): string {
  const a = all.find((x) => x.code === code)!;
  return `${a.manager ? pathOf(a.manager, all) : "/"}${code}/`;
}

async function inChunks<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

export async function seed(db: Db, passwordHash: string) {
  const now = new Date();
  const sets = [
    { tenant: GA1, agents: GA1_AGENTS, users: GA1_USERS },
    { tenant: GA2, agents: GA2_AGENTS, users: GA2_USERS },
  ];

  await db.insert(tenants).values(
    sets.map((s) => ({ ...s.tenant, status: "active" as const, createdAt: now.toISOString() })),
  );

  for (const s of sets) {
    await inChunks(defaultGrantRows(s.tenant.id), 30, (chunk) => db.insert(rolePermissions).values(chunk));
    await inChunks(s.agents, 10, (chunk) =>
      db.insert(agents).values(
        chunk.map((a) => ({
          tenantId: s.tenant.id,
          agentCode: a.code,
          name: a.name,
          rank: a.rank,
          managerCode: a.manager,
          path: pathOf(a.code, s.agents),
          status: "Đang hoạt động",
        })),
      ),
    );
  }

  const allUsers = [
    ...sets.flatMap((s) => s.users.map((u) => ({ ...u, tenantId: s.tenant.id as string | null }))),
    { ...PLATFORM_USER, tenantId: null },
  ];
  await inChunks(allUsers, 10, (chunk) =>
    db.insert(users).values(
      chunk.map((u) => ({
        id: userId(u.email),
        tenantId: u.tenantId,
        email: u.email,
        emailVerified: true,
        name: u.name,
        agentCode: u.agentCode ?? null,
        status: "ACTIVE" as const,
        createdAt: now,
        updatedAt: now,
      })),
    ),
  );
  await inChunks(
    allUsers.flatMap((u) => u.roles.map((role) => ({ userId: userId(u.email), role }))),
    40,
    (chunk) => db.insert(userRoles).values(chunk),
  );
  await inChunks(allUsers, 10, (chunk) =>
    db.insert(accounts).values(
      chunk.map((u) => ({
        id: `account-${u.email}`,
        userId: userId(u.email),
        accountId: userId(u.email),
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      })),
    ),
  );
  return { tenants: sets.length, agents: GA1_AGENTS.length + GA2_AGENTS.length, users: allUsers.length };
}

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents } from "../db/schema";

type Node = { agentCode: string; managerCode: string | null };

/**
 * Materialized path for every agent: `/root/.../manager/self/`.
 * A manager code that is not in the tenant (not imported yet) makes the agent a root.
 * Agents on a manager cycle are cut loose as roots and reported in `cycles`.
 */
export function computePaths(nodes: readonly Node[]): { paths: Map<string, string>; cycles: string[] } {
  const managerOf = new Map(nodes.map((n) => [n.agentCode, n.managerCode]));
  const paths = new Map<string, string>();
  const cycles: string[] = [];

  for (const { agentCode } of nodes) {
    if (paths.has(agentCode)) continue;
    // Walk up until a root or an agent whose path is already known.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = agentCode;
    let base = "/";
    while (cur !== null) {
      const known = paths.get(cur);
      if (known !== undefined) {
        base = known;
        break;
      }
      if (seen.has(cur)) {
        // Everything from the first visit of `cur` onwards is the cycle.
        const loop = chain.splice(chain.indexOf(cur));
        for (const c of loop) paths.set(c, `/${c}/`);
        cycles.push(...loop);
        // What is left of the chain hangs below a cycle member, which is now a root.
        base = chain.length ? paths.get(managerOf.get(chain[chain.length - 1]!)!)! : "/";
        break;
      }
      seen.add(cur);
      chain.push(cur);
      const m: string | null = managerOf.get(cur) ?? null;
      cur = m !== null && managerOf.has(m) ? m : null;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      base = `${base}${chain[i]}/`;
      paths.set(chain[i]!, base);
    }
  }
  return { paths, cycles };
}

/** Update statements for every agent of the tenant whose stored path differs from the computed one. */
export function pathUpdates(
  db: Db,
  tenantId: string,
  rows: readonly (Node & { path: string })[],
) {
  const { paths, cycles } = computePaths(rows);
  const stmts = rows
    .filter((r) => paths.get(r.agentCode) !== r.path)
    .map((r) =>
      db
        .update(agents)
        .set({ path: paths.get(r.agentCode)! })
        .where(and(eq(agents.tenantId, tenantId), eq(agents.agentCode, r.agentCode))),
    );
  return { stmts, cycles };
}

/** Rebuild `agents.path` for a tenant. Call after every Agents import. */
export async function rebuildAgentPaths(db: Db, tenantId: string) {
  const rows = await db
    .select({ agentCode: agents.agentCode, managerCode: agents.managerCode, path: agents.path })
    .from(agents)
    .where(eq(agents.tenantId, tenantId));
  const { stmts, cycles } = pathUpdates(db, tenantId, rows);
  for (let i = 0; i < stmts.length; i += 50) {
    const chunk = stmts.slice(i, i + 50);
    await db.batch([chunk[0]!, ...chunk.slice(1)]);
  }
  return { updated: stmts.length, cycles };
}

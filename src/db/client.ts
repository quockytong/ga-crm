import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

const d1Of = new WeakMap<Db, D1Database>();
const dialect = new SQLiteSyncDialect();

export function createDb(d1: D1Database): Db {
  const db = drizzle(d1, { schema });
  d1Of.set(db, d1);
  return db;
}

type Statement = SQL | { toSQL(): { sql: string; params: unknown[] } };

/**
 * One D1 batch (a single transaction) of raw `sql` statements and query builders.
 * Drizzle's own `db.batch()` cannot take raw `sql`, which the import uses for
 * its set-based `INSERT ... SELECT` statements.
 */
export async function sqlBatch(db: Db, statements: readonly Statement[]) {
  const d1 = d1Of.get(db)!;
  if (statements.length === 0) return [];
  return d1.batch(
    statements.map((s) => {
      const q = "toSQL" in s ? s.toSQL() : dialect.sqlToQuery(s);
      return d1.prepare(q.sql).bind(...q.params);
    }),
  );
}

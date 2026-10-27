import { zValidator } from "@hono/zod-validator";
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors";

/** Zod validation that answers 400 `{ error: "invalid_input", issues }`. */
export const valid = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "invalid_input",
          issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      );
    }
  });

/** Case-insensitive "contains" on any of the columns, with LIKE wildcards in the term escaped. */
export function contains(term: string, ...cols: AnySQLiteColumn[]): SQL {
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  // Parenthesised: this is AND-ed with the scope filter, and a bare OR would escape it.
  return sql`(${sql.join(
    cols.map((c) => sql`${c} like ${pattern} escape '\\'`),
    sql` or `,
  )})`;
}

/** A non-empty tuple for `db.batch()`. */
export function batchOf<T>(stmts: readonly T[]): [T, ...T[]] {
  if (stmts.length === 0) throw new ApiError(400, "nothing_to_do");
  return stmts as unknown as [T, ...T[]];
}

/** Splits a list so each statement stays under D1's 100 bound parameters. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Local Postgres (PGlite/WASM) with a minimal Supabase shim: roles anon/authenticated/service_role,
 * auth.users and auth.uid() reading request.jwt.claim.sub — the same mechanism Supabase uses.
 * Runs the real migrations from supabase/migrations.
 */
const MIGRATIONS = join(__dirname, "../../../../supabase/migrations");

const SHIM = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text not null);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
`;

export type Db = PGlite & {
  as: <T = Record<string, unknown>>(who: Who, sql: string, params?: unknown[]) => Promise<T[]>;
  one: <T = Record<string, unknown>>(who: Who, sql: string, params?: unknown[]) => Promise<T>;
};
export type Who = { role: "anon" } | { role: "authenticated"; userId: string } | { role: "service_role" } | { role: "owner" };

export async function createDb(): Promise<Db> {
  const db = new PGlite() as Db;
  await db.exec(SHIM);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !f.includes("supabase_only")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  db.as = async (who, sql, params = []) => {
    return db.transaction(async (tx) => {
      if (who.role !== "owner") {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.role === "authenticated" ? who.userId : ""]);
        await tx.exec(`set local role ${who.role}`);
      }
      const r = await tx.query(sql, params);
      return r.rows as never;
    });
  };
  db.one = async (who, sql, params) => {
    const rows = await db.as(who, sql, params);
    return rows[0] as never;
  };
  return db;
}

export async function createUser(db: Db, email: string): Promise<string> {
  const r = await db.query<{ id: string }>(`insert into auth.users(email) values ($1) returning id`, [email]);
  return r.rows[0]!.id;
}

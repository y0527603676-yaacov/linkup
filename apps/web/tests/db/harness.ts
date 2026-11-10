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
-- Test stand-ins for Supabase-provided extensions (vault, pg_net, pg_cron, pgcrypto's gen_random_bytes).
create schema extensions;
create function extensions.gen_random_bytes(n int) returns bytea language sql as $$
  select substring(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for n) $$;
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
  language sql as $$ insert into vault.secrets(secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void
  language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
create schema net;
create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net.calls(url, headers, body) values (url, headers, body) returning id $$;
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job(jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
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

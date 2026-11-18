// Applies db/migrations/*.sql in lexical order, once each, inside a transaction.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.MIGRATIONS_DIR ?? path.resolve(here, "../../db/migrations");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("select pg_advisory_lock(727274)");
  await client.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values ($1)", [f]);
      await client.query("commit");
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query("rollback");
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
} finally {
  await client.query("select pg_advisory_unlock(727274)").catch(() => {});
  await client.end();
}

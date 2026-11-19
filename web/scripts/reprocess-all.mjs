// Queue a re-parse of every ready replay whose original demo is still stored, e.g. after a worker
// upgrade that adds new data (player stats). The current revision stays playable until the new one
// is published.
//
//   node scripts/reprocess-all.mjs              # dry run: lists what would be queued
//   node scripts/reprocess-all.mjs --go         # queue them
//   node scripts/reprocess-all.mjs --go --owner coach@example.com
//
// Needs DATABASE_URL. Replays whose source was deleted after parsing (the default unless
// KEEP_SOURCE_AFTER_PARSE=1) cannot be re-parsed: upload the demo again.
import pg from "pg";

const args = process.argv.slice(2);
const go = args.includes("--go");
const ownerIdx = args.indexOf("--owner");
const owner = ownerIdx >= 0 ? args[ownerIdx + 1] : null;
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(2); }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const params = [];
  let where = "r.deleted_at is null and r.status = 'ready' and r.source_key is not null";
  if (owner) {
    params.push(owner);
    where += ` and r.owner_id = (select id from "auth_user" where lower(email) = lower($${params.length}))`;
  }
  const rows = (await db.query(
    `select r.id, coalesce(r.title, r.source_filename, r.id) as label from replays r where ${where}
       and not exists (select 1 from jobs j where j.replay_id = r.id and j.kind = 'parse' and j.status in ('queued','running'))
     order by r.created_at`, params)).rows;
  const missing = (await db.query("select count(*)::int as n from replays where deleted_at is null and status = 'ready' and source_key is null")).rows[0].n;
  console.log(`${rows.length} replay(s) can be re-parsed; ${missing} cannot (source no longer stored).`);
  for (const r of rows) console.log(`  ${r.id}  ${r.label}`);
  if (!go) {
    console.log("Dry run. Add --go to queue them.");
  } else {
    for (const r of rows) {
      await db.query("begin");
      const rev = (await db.query("update replays set revision = revision + 1, updated_at = now() where id = $1 returning revision", [r.id])).rows[0].revision;
      await db.query("insert into jobs(replay_id, revision, kind) values ($1, $2, 'parse')", [r.id, rev]);
      await db.query("commit");
    }
    console.log(`Queued ${rows.length} re-parse job(s). The worker publishes each as it finishes.`);
  }
} catch (e) {
  await db.query("rollback").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}

// Grant or end a plan by hand (comps, partners, testing) without Stripe.
//
//   node scripts/grant-plan.mjs personal <email> [--until 2027-01-31] [--note "why"]
//   node scripts/grant-plan.mjs team <team id or exact team name> [--until ...] [--note ...]
//   node scripts/grant-plan.mjs revoke personal <email>
//   node scripts/grant-plan.mjs revoke team <team id or name>
//   node scripts/grant-plan.mjs list
//
// Needs DATABASE_URL. Manual plans never touch Stripe; paid plans are managed in Stripe.
import pg from "pg";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const until = flag("--until");
const note = flag("--note");
const usage = () => { console.error("usage: grant-plan.mjs personal <email> | team <team> | revoke personal|team <who> | list  [--until YYYY-MM-DD] [--note text]"); process.exit(2); };
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(2); }
if (until && Number.isNaN(Date.parse(until))) { console.error("--until must be a date, e.g. 2027-01-31"); process.exit(2); }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const id = () => [...randomBytes(16)].map((b) => "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[b % 62]).join("");

async function owner(kind, who) {
  if (kind === "personal") {
    const r = await db.query('select id, email from "auth_user" where lower(email) = lower($1)', [who]);
    if (!r.rows[0]) throw new Error(`no account with email ${who}`);
    return { col: "user_id", id: r.rows[0].id, label: r.rows[0].email };
  }
  if (kind === "team") {
    const r = await db.query("select id, name from teams where id = $1 or name = $1", [who]);
    if (r.rows.length !== 1) throw new Error(r.rows.length ? `"${who}" matches several teams; use the team id` : `no team ${who}`);
    return { col: "team_id", id: r.rows[0].id, label: r.rows[0].name };
  }
  usage();
}

try {
  const [cmd, a, b] = args;
  if (cmd === "list") {
    const r = await db.query(`select s.kind, coalesce(u.email, t.name) as who, s.provider, s.status, s.current_period_end, s.note
      from subscriptions s left join "auth_user" u on u.id = s.user_id left join teams t on t.id = s.team_id order by s.updated_at desc limit 200`);
    console.table(r.rows);
  } else if (cmd === "revoke") {
    if (!a || !b) usage();
    const o = await owner(a, b);
    const r = await db.query(`update subscriptions set status = 'canceled', updated_at = now() where ${o.col} = $1 and provider = 'manual' and status <> 'canceled'`, [o.id]);
    console.log(`ended ${r.rowCount} manual ${a} plan(s) for ${o.label}${r.rowCount ? "" : " (Stripe plans are cancelled in Stripe)"}`);
  } else if (cmd === "personal" || cmd === "team") {
    if (!a) usage();
    const o = await owner(cmd, a);
    await db.query(
      `insert into subscriptions(id, kind, ${o.col}, provider, status, current_period_end, note) values ($1,$2,$3,'manual','active',$4,$5)`,
      [id(), cmd, o.id, until ? new Date(until).toISOString() : null, note]);
    console.log(`granted a ${cmd} plan to ${o.label}${until ? ` until ${until}` : " with no end date"}`);
  } else usage();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}

import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { body, json, route } from "@/lib/http";
import { teamKey } from "@/lib/statIndex";

export const dynamic = "force-dynamic";

/** Teams you watch. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const rows = await q<{ team_key: string; team_name: string; last_seen_at: string }>(
    "select team_key, team_name, last_seen_at from team_watches where user_id = $1 order by team_name", [user.id]);
  return json({ watches: rows.map((r) => ({ key: r.team_key, name: r.team_name, lastSeenAt: r.last_seen_at })) });
});

const Watch = z.object({ name: z.string().trim().min(1).max(80) });

/** Watch a team (by in-game name). Watching again is a no-op. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { name } = await body(req, Watch);
  await q(
    `insert into team_watches(user_id, team_key, team_name) values ($1,$2,$3)
     on conflict (user_id, team_key) do update set team_name = excluded.team_name`,
    [user.id, teamKey(name), name]);
  return json({ ok: true }, { status: 201 });
});

/** Stop watching (?name=). */
export const DELETE = route(async (req: Request) => {
  const user = await requireUser(req);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  await q("delete from team_watches where user_id = $1 and team_key = $2", [user.id, teamKey(name)]);
  return json({ ok: true });
});

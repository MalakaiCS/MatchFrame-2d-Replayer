import { z } from "zod";
import { replayAccess } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { badRequest, body, forbidden, json, route } from "@/lib/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Team review sharing: the owner grants view access to whole teams (or single users by email). */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden();
  const grants = await q(
    `select g.team_id as "teamId", t.name as "teamName", g.user_id as "userId", u.email as "userEmail", g.created_at as "createdAt"
       from replay_grants g left join teams t on t.id = g.team_id left join "auth_user" u on u.id = g.user_id
      where g.replay_id = $1 order by g.created_at`,
    [id],
  );
  return json({ grants });
});

const Grant = z.union([z.object({ teamId: z.string().max(64) }), z.object({ email: z.string().email().max(200) })]);

export const POST = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden("Only the owner can share this replay.");
  const p = await body(req, Grant);
  if ("teamId" in p) {
    if (!a.teams.some((t) => t.team_id === p.teamId)) throw badRequest("You can only share with teams you belong to.");
    await q("insert into replay_grants(replay_id, team_id, granted_by) values ($1,$2,$3) on conflict do nothing", [id, p.teamId, a.user!.id]);
  } else {
    const u = await q1<{ id: string }>('select id from "auth_user" where lower(email) = lower($1)', [p.email]);
    if (!u) throw badRequest("No Matchframe account uses that email.", "NO_ACCOUNT");
    await q("insert into replay_grants(replay_id, user_id, granted_by) values ($1,$2,$3) on conflict do nothing", [id, u.id, a.user!.id]);
  }
  return json({ ok: true }, { status: 201 });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id, { planCheck: false });
  if (a.via !== "owner") throw forbidden();
  const u = new URL(req.url);
  const teamId = u.searchParams.get("teamId");
  const userId = u.searchParams.get("userId");
  if (teamId) await q("delete from replay_grants where replay_id = $1 and team_id = $2", [id, teamId]);
  else if (userId) await q("delete from replay_grants where replay_id = $1 and user_id = $2", [id, userId]);
  else throw badRequest("teamId or userId is required.");
  return json({ ok: true });
});

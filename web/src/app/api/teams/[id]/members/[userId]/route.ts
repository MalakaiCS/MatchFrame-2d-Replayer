import { z } from "zod";
import { MANAGE_ROLES, requireUser, userTeams } from "@/lib/access";
import { syncTeamSeats } from "@/lib/billing";
import { q, q1 } from "@/lib/db";
import { badRequest, body, forbidden, json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; userId: string }> };

async function guard(req: Request, ctx: Ctx) {
  const user = await requireUser(req);
  const { id, userId } = await ctx.params;
  const me = (await userTeams(user.id)).find((t) => t.team_id === id);
  if (!me) throw notFound();
  const target = await q1<{ role: string }>("select role from team_members where team_id = $1 and user_id = $2", [id, userId]);
  if (!target) throw notFound();
  const self = userId === user.id;
  if (!self && !MANAGE_ROLES.includes(me.role)) throw forbidden("Only team owners and coaches can change members.");
  if (target.role === "owner" && me.role !== "owner") throw forbidden("Only an owner can change another owner.");
  return { id, userId, me };
}

async function assertOwnerRemains(teamId: string, userId: string) {
  const owners = await q1<{ n: number }>(
    "select count(*)::int as n from team_members where team_id = $1 and role = 'owner' and user_id <> $2", [teamId, userId]);
  if (!owners?.n) throw badRequest("A team needs at least one owner.", "LAST_OWNER");
}

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const { id, userId, me } = await guard(req, ctx);
  const { role } = await body(req, z.object({ role: z.enum(["owner", "coach", "analyst", "player", "viewer"]) }));
  if (role === "owner" && me.role !== "owner") throw forbidden("Only an owner can grant ownership.");
  if (role !== "owner") await assertOwnerRemains(id, userId);
  await q("update team_members set role = $3 where team_id = $1 and user_id = $2", [id, userId, role]);
  return json({ ok: true });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const { id, userId } = await guard(req, ctx);
  await assertOwnerRemains(id, userId);
  await q("delete from team_members where team_id = $1 and user_id = $2", [id, userId]);
  await syncTeamSeats(id);
  return json({ ok: true });
});

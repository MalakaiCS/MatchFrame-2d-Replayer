import { z } from "zod";
import { MANAGE_ROLES, requireUser, userTeams } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { body, forbidden, json, notFound, route } from "@/lib/http";
import { newId, newToken, sha256 } from "@/lib/ids";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function manager(req: Request, ctx: Ctx) {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const me = (await userTeams(user.id)).find((t) => t.team_id === id);
  if (!me) throw notFound();
  if (!MANAGE_ROLES.includes(me.role)) throw forbidden("Only team owners and coaches can manage invite links.");
  return { user, id };
}

/** Active invite links (tokens are never shown again). */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const { id } = await manager(req, ctx);
  const invites = await q(
    `select i.id, i.role, i.created_at as "createdAt", i.expires_at as "expiresAt", i.max_uses as "maxUses", i.uses, u.name as "createdBy"
       from team_invites i join "auth_user" u on u.id = i.created_by
      where i.team_id = $1 and i.revoked_at is null and i.expires_at > now() and (i.max_uses is null or i.uses < i.max_uses)
      order by i.created_at desc`, [id]);
  return json({ invites });
});

const Create = z.object({
  role: z.enum(["coach", "analyst", "player", "viewer"]).default("player"),
  days: z.number().int().min(1).max(30).default(7),
  maxUses: z.number().int().min(1).max(100).nullable().default(null),
});

/** Create an invite link. Coaches may invite any role except owner (owners are added by email). */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const { user, id } = await manager(req, ctx);
  const p = await body(req, Create);
  const token = newToken();
  const row = await q1<{ id: string; expires_at: string }>(
    `insert into team_invites(id, team_id, token_hash, role, created_by, expires_at, max_uses)
     values ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7) returning id, expires_at`,
    [newId(), id, sha256(token), p.role, user.id, p.days, p.maxUses]);
  return json({ id: row!.id, token, expiresAt: row!.expires_at }, { status: 201 });
});

/** Revoke one invite link (?inviteId=) or all of them. */
export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const { id } = await manager(req, ctx);
  const inviteId = new URL(req.url).searchParams.get("inviteId");
  await q(`update team_invites set revoked_at = now() where team_id = $1 and revoked_at is null ${inviteId ? "and id = $2" : ""}`,
    inviteId ? [id, inviteId] : [id]);
  return json({ ok: true });
});

import { z } from "zod";
import { MANAGE_ROLES, requireUser, userTeams } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { badRequest, body, forbidden, json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";

const Add = z.object({
  email: z.string().email().max(200),
  role: z.enum(["owner", "coach", "analyst", "player", "viewer"]),
});

/** Add an existing Matchframe account to the team. Coaches may add any role except owner. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const me = (await userTeams(user.id)).find((t) => t.team_id === id);
  if (!me) throw notFound();
  if (!MANAGE_ROLES.includes(me.role)) throw forbidden("Only team owners and coaches can add members.");
  const p = await body(req, Add);
  if (p.role === "owner" && me.role !== "owner") throw forbidden("Only an owner can add another owner.");
  const target = await q1<{ id: string }>('select id from "auth_user" where lower(email) = lower($1)', [p.email]);
  if (!target) throw badRequest("No Matchframe account uses that email. Ask them to sign up first.", "NO_ACCOUNT");
  await q(
    `insert into team_members(team_id, user_id, role) values ($1,$2,$3)
     on conflict (team_id, user_id) do update set role = excluded.role`,
    [id, target.id, p.role],
  );
  return json({ ok: true, userId: target.id }, { status: 201 });
});

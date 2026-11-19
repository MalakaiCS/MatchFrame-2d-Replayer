import { z } from "zod";
import { requireUser } from "@/lib/access";
import { billing, planFor } from "@/lib/billing";
import { tx } from "@/lib/db";
import { badRequest, body, json, notFound, route } from "@/lib/http";
import { sha256 } from "@/lib/ids";

export const dynamic = "force-dynamic";

const validToken = (t: string | null) => !!t && /^[A-Za-z0-9_-]{20,100}$/.test(t);
const LIVE = "i.revoked_at is null and i.expires_at > now() and (i.max_uses is null or i.uses < i.max_uses)";

/** What an invite link is for (signed-in users only), so the join page can show it before accepting. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const token = new URL(req.url).searchParams.get("token");
  if (!validToken(token)) throw notFound();
  return tx(async (c) => {
    const inv = (await c.query(
      `select i.role, i.expires_at as "expiresAt", t.id as "teamId", t.name as "teamName"
         from team_invites i join teams t on t.id = i.team_id where i.token_hash = $1 and ${LIVE}`, [sha256(token!)])).rows[0];
    if (!inv) throw notFound();
    const member = (await c.query("select role from team_members where team_id = $1 and user_id = $2", [inv.teamId, user.id])).rows[0];
    return json({ ...inv, alreadyMember: !!member, currentRole: member?.role ?? null });
  });
});

const Accept = z.object({ token: z.string().min(20).max(100) });

/**
 * Join the team with the invite's role. Existing members keep their current role. Counts a use and
 * respects the team plan's member cap.
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { token } = await body(req, Accept);
  if (!validToken(token)) throw notFound();
  return tx(async (c) => {
    const inv = (await c.query(
      `select i.id, i.team_id, i.role from team_invites i where i.token_hash = $1 and ${LIVE} for update`, [sha256(token)])).rows[0];
    if (!inv) throw notFound();
    const member = (await c.query("select role from team_members where team_id = $1 and user_id = $2", [inv.team_id, user.id])).rows[0];
    if (member) return json({ teamId: inv.team_id, joined: false, role: member.role });
    const limit = billing.teamMemberLimit();
    if (billing.enabled() && limit && (await planFor({ teamId: inv.team_id }))?.active) {
      const n = (await c.query("select count(*)::int as n from team_members where team_id = $1", [inv.team_id])).rows[0].n;
      if (n >= limit) throw badRequest(`This team is full: the team plan includes up to ${limit} members.`, "TEAM_FULL");
    }
    await c.query("insert into team_members(team_id, user_id, role) values ($1,$2,$3)", [inv.team_id, user.id, inv.role]);
    await c.query("update team_invites set uses = uses + 1 where id = $1", [inv.id]);
    return json({ teamId: inv.team_id, joined: true, role: inv.role }, { status: 201 });
  });
});

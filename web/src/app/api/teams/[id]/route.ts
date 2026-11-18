import { requireUser, userTeams } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const me = (await userTeams(user.id)).find((t) => t.team_id === id);
  if (!me) throw notFound();
  const team = await q1("select id, name, created_at as \"createdAt\" from teams where id = $1", [id]);
  const members = await q(
    `select u.id, u.name, u.email, m.role from team_members m join "auth_user" u on u.id = m.user_id
      where m.team_id = $1 order by m.role, u.name`,
    [id],
  );
  return json({ team, role: me.role, members });
});

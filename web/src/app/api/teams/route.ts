import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q, tx } from "@/lib/db";
import { body, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const teams = await q(
    `select t.id, t.name, m.role, (select count(*)::int from team_members x where x.team_id = t.id) as members
       from teams t join team_members m on m.team_id = t.id and m.user_id = $1 order by t.name`,
    [user.id],
  );
  return json({ teams });
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { name } = await body(req, z.object({ name: z.string().trim().min(1).max(80) }));
  const id = "tm_" + newId();
  await tx(async (c) => {
    await c.query("insert into teams(id, name, created_by) values ($1,$2,$3)", [id, name, user.id]);
    await c.query("insert into team_members(team_id, user_id, role) values ($1,$2,'owner')", [id, user.id]);
  });
  return json({ id }, { status: 201 });
});

import { z } from "zod";
import { requireUser, REVIEW_ROLES, userTeams } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { badRequest, body, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { BoardData } from "@/lib/tactics";
import { getMapDef } from "@/viewer/maps";

export const dynamic = "force-dynamic";

/** Your boards and your teams' boards. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const boards = await q(
    `select b.id, b.name, b.map_id as "mapId", b.team_id as "teamId", t.name as "teamName", b.updated_at as "updatedAt",
            b.owner_id = $1 as mine, u.name as "ownerName"
       from tactic_boards b join "auth_user" u on u.id = b.owner_id left join teams t on t.id = b.team_id
      where b.owner_id = $1 or b.team_id in (select team_id from team_members where user_id = $1)
      order by b.updated_at desc limit 300`, [user.id]);
  return json({ boards });
});

const Create = z.object({
  name: z.string().trim().min(1).max(120),
  mapId: z.string().max(40),
  teamId: z.string().max(64).nullable().optional(),
  data: BoardData.optional(),
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const p = await body(req, Create);
  if (!getMapDef(p.mapId)) throw badRequest("Unknown map.");
  if (p.teamId) {
    const role = (await userTeams(user.id)).find((t) => t.team_id === p.teamId)?.role;
    if (!role || !REVIEW_ROLES.includes(role)) throw badRequest("You cannot add boards to that team.");
  }
  const id = newId();
  const row = await q1<{ id: string }>(
    "insert into tactic_boards(id, owner_id, team_id, name, map_id, data) values ($1,$2,$3,$4,$5,$6) returning id",
    [id, user.id, p.teamId ?? null, p.name, p.mapId, JSON.stringify(p.data ?? { floor: 0, tokens: [], strokes: [] })]);
  return json({ id: row!.id }, { status: 201 });
});

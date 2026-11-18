import { z } from "zod";
import { REVIEW_ROLES, requireUser, userTeams } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { badRequest, body, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const search = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  const rows = await q(
    `select p.id, p.name, p.description, p.team_id as "teamId", t.name as "teamName", p.owner_id = $1 as mine,
            p.updated_at as "updatedAt", (select count(*)::int from playlist_entries e where e.playlist_id = p.id) as entries
       from playlists p left join teams t on t.id = p.team_id
      where (p.owner_id = $1 or exists (select 1 from team_members m where m.team_id = p.team_id and m.user_id = $1))
        and ($2 = '' or p.name ilike '%' || $2 || '%')
      order by p.updated_at desc limit 200`,
    [user.id, search.replace(/[%_\\]/g, (m) => "\\" + m)],
  );
  return json({ playlists: rows });
});

const Create = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  teamId: z.string().nullable().optional(),
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const p = await body(req, Create);
  if (p.teamId) {
    const role = (await userTeams(user.id)).find((t) => t.team_id === p.teamId)?.role;
    if (!role || !REVIEW_ROLES.includes(role)) throw badRequest("You cannot create playlists for that team.", "FORBIDDEN_TEAM");
  }
  const row = await q1(
    "insert into playlists(id, name, description, owner_id, team_id) values ($1,$2,$3,$4,$5) returning id, version",
    ["pl_" + newId(), p.name, p.description ?? null, user.id, p.teamId ?? null],
  );
  return json(row, { status: 201 });
});

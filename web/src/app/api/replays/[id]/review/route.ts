import { z } from "zod";
import { replayAccess } from "@/lib/access";
import { anchorStatus, manifestFor, validateAnchor } from "@/lib/anchors";
import { q, q1 } from "@/lib/db";
import { body, forbidden, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { loadManifest } from "@/lib/manifest";
import { assertTeamScope } from "@/lib/review-scope";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Bookmarks and notes visible to the caller: their personal items plus items of their teams. */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (!a.user) return json({ bookmarks: [], notes: [] });
  const teamIds = a.teams.map((t) => t.team_id);
  const m = a.replay.published_prefix ? await loadManifest(a.replay.published_prefix) : null;
  const bookmarks = await q(
    `select b.*, b.owner_id as author_id, u.name as author_name from bookmarks b join "auth_user" u on u.id = b.owner_id
      where b.replay_id = $1 and ((b.team_id is null and b.owner_id = $2) or b.team_id = any($3::text[]))
      order by b.tick`,
    [id, a.user.id, teamIds],
  );
  const notes = await q(
    `select n.*, u.name as author_name from notes n join "auth_user" u on u.id = n.author_id
      where n.replay_id = $1 and ((n.team_id is null and n.author_id = $2) or n.team_id = any($3::text[]))
      order by n.tick, n.created_at`,
    [id, a.user.id, teamIds],
  );
  const shape = (r: Record<string, unknown>) => ({
    id: r.id,
    roundId: r.round_id,
    tick: r.tick,
    endTick: r.end_tick ?? null,
    revision: r.revision,
    teamId: r.team_id,
    authorId: r.author_id,
    authorName: r.author_name,
    mine: r.author_id === a.user!.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...anchorStatus(m, r.revision as number, r.round_id as string, r.tick as number),
  });
  return json({
    bookmarks: bookmarks.map((b) => ({ ...shape(b), title: b.title })),
    notes: notes.map((n) => ({ ...shape(n), body: n.body })),
  });
});

const Create = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bookmark"),
    roundId: z.string(),
    tick: z.number().int(),
    endTick: z.number().int().nullable().optional(),
    title: z.string().trim().min(1).max(200),
    teamId: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("note"),
    roundId: z.string(),
    tick: z.number().int(),
    body: z.string().trim().min(1).max(5000),
    teamId: z.string().nullable().optional(),
  }),
]);

export const POST = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (!a.canReview || !a.user) throw forbidden("You cannot add review items to this replay.");
  const p = await body(req, Create);
  const m = await manifestFor(a);
  const { revision } = validateAnchor(m, p);
  const teamId = await assertTeamScope(a, p.teamId);
  if (p.kind === "bookmark") {
    const row = await q1(
      `insert into bookmarks(id, replay_id, revision, round_id, tick, end_tick, title, owner_id, team_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      ["bm_" + newId(), id, revision, p.roundId, p.tick, p.endTick ?? null, p.title, a.user.id, teamId],
    );
    return json({ id: row!.id }, { status: 201 });
  }
  const row = await q1(
    `insert into notes(id, replay_id, revision, round_id, tick, body, author_id, team_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    ["nt_" + newId(), id, revision, p.roundId, p.tick, p.body, a.user.id, teamId],
  );
  return json({ id: row!.id }, { status: 201 });
});

import { z } from "zod";
import { replayAccess, VISIBLE_REPLAYS_SQL } from "@/lib/access";
import { q, tx } from "@/lib/db";
import { badRequest, body, forbidden, json, route } from "@/lib/http";
import { loadManifest } from "@/lib/manifest";
import { accessView, publicReplay } from "@/lib/replay-view";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  const r = a.replay;
  const manifest = r.status === "ready" && r.published_prefix ? await loadManifest(r.published_prefix) : null;
  let series: unknown[] = [];
  if (r.series_id && a.user) {
    series = await q(
      `select r.id, r.series_map_index as "mapIndex", r.map_id as "mapId", r.status, r.score_a as "scoreA", r.score_b as "scoreB"
         from replays r where r.series_id = $2 and ${VISIBLE_REPLAYS_SQL} order by r.series_map_index nulls last, r.created_at`,
      [a.user.id, r.series_id],
    );
  }
  return json({ replay: publicReplay(r), access: accessView(a), manifest, series });
});

const Patch = z.object({
  title: z.string().max(200).nullable().optional(),
  teamId: z.string().max(64).nullable().optional(),
  visibility: z.enum(["private", "team"]).optional(),
  seriesId: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
  seriesMapIndex: z.number().int().min(1).max(7).nullable().optional(),
});

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden("Only the owner can change this replay.");
  const p = await body(req, Patch);
  if (p.teamId) {
    const m = a.teams.find((t) => t.team_id === p.teamId);
    if (!m || m.role === "viewer") throw badRequest("You cannot assign replays to that team.");
  }
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (p.title !== undefined) add("title", p.title);
  if (p.teamId !== undefined) add("team_id", p.teamId);
  if (p.visibility !== undefined) add("visibility", p.visibility);
  if (p.seriesId !== undefined) add("series_id", p.seriesId);
  if (p.seriesMapIndex !== undefined) add("series_map_index", p.seriesMapIndex);
  if (sets.length) await q(`update replays set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
  return json({ ok: true });
});

/** Owner-only deletion: access ends immediately; objects are removed by a cleanup job. */
export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden("Only the owner can delete this replay.");
  await tx(async (c) => {
    await c.query("update replays set status = 'deleted', deleted_at = now(), updated_at = now() where id = $1", [id]);
    await c.query("update share_links set revoked_at = now() where replay_id = $1 and revoked_at is null", [id]);
    await c.query("update jobs set status = 'cancelled', finished_at = now() where replay_id = $1 and status = 'queued'", [id]);
    await c.query(
      "insert into jobs(replay_id, revision, kind) values ($1, $2, 'cleanup') on conflict (replay_id, revision, kind) do nothing",
      [id, a.replay.revision],
    );
  });
  return json({ ok: true });
});

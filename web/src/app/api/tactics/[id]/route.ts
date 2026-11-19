import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { body, conflict, forbidden, json, route } from "@/lib/http";
import { BoardData, boardFor } from "@/lib/tactics";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const b = await boardFor(user.id, id, false);
  return json({ id: b.id, name: b.name, mapId: b.map_id, teamId: b.team_id, data: b.data, version: b.version, mine: b.owner_id === user.id, updatedAt: b.updated_at });
});

const Save = z.object({ name: z.string().trim().min(1).max(120).optional(), data: BoardData.optional(), version: z.number().int() });

/** Save with optimistic concurrency: a stale version is refused so two editors do not overwrite each other. */
export const PUT = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  await boardFor(user.id, id, true);
  const p = await body(req, Save);
  const row = await q1<{ version: number }>(
    `update tactic_boards set name = coalesce($3, name), data = coalesce($4::jsonb, data), version = version + 1, updated_at = now()
      where id = $1 and version = $2 returning version`,
    [id, p.version, p.name ?? null, p.data ? JSON.stringify(p.data) : null]);
  if (!row) throw conflict("Someone else changed this board. Reload to see their version.", "STALE");
  return json({ version: row.version });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const b = await boardFor(user.id, id, true);
  if (b.owner_id !== user.id) throw forbidden("Only the person who made the board can delete it.");
  await q("delete from tactic_boards where id = $1", [id]);
  return json({ ok: true });
});

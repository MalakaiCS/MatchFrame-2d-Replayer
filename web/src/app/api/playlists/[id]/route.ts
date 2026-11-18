import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { body, forbidden, json, route } from "@/lib/http";
import { playlistAccess, playlistEntries, requireEdit } from "@/lib/playlists";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const a = await playlistAccess(user, id);
  const p = a.playlist;
  return json({
    playlist: { id: p.id, name: p.name, description: p.description, teamId: p.team_id, version: p.version, updatedAt: p.updated_at },
    canEdit: a.canEdit,
    canDelete: a.canDelete,
    entries: await playlistEntries(user, id),
  });
});

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const a = await playlistAccess(user, id);
  requireEdit(a);
  const p = await body(req, Patch);
  await q(
    `update playlists set name = coalesce($2, name), description = case when $4 then $3 else description end,
            version = version + 1, updated_at = now() where id = $1`,
    [id, p.name ?? null, p.description ?? null, p.description !== undefined],
  );
  return json({ ok: true });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const a = await playlistAccess(user, id);
  if (!a.canDelete) throw forbidden("Only the playlist owner or a team coach can delete it.");
  await q("delete from playlists where id = $1", [id]);
  return json({ ok: true });
});

import { z } from "zod";
import { requireUser } from "@/lib/access";
import { tx } from "@/lib/db";
import { body, json, notFound, route } from "@/lib/http";
import { assertVersion, playlistAccess, requireEdit } from "@/lib/playlists";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; entryId: string }> };

const Patch = z.object({ label: z.string().trim().max(200).nullable(), version: z.number().int().optional() });

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id, entryId } = await ctx.params;
  const p = await body(req, Patch);
  const out = await tx(async (c) => {
    const a = await playlistAccess(user, id, c, true);
    requireEdit(a);
    assertVersion(a.playlist, p.version);
    const r = await c.query("update playlist_entries set label = $3 where id = $2 and playlist_id = $1", [id, entryId, p.label]);
    if (!r.rowCount) throw notFound();
    return (await c.query("update playlists set version = version + 1, updated_at = now() where id = $1 returning version", [id])).rows[0];
  });
  return json(out);
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id, entryId } = await ctx.params;
  const versionParam = new URL(req.url).searchParams.get("version");
  const out = await tx(async (c) => {
    const a = await playlistAccess(user, id, c, true);
    requireEdit(a);
    assertVersion(a.playlist, versionParam === null ? undefined : Number(versionParam));
    const r = await c.query("delete from playlist_entries where id = $2 and playlist_id = $1 returning position", [id, entryId]);
    if (!r.rowCount) throw notFound();
    await c.query("set constraints all deferred");
    await c.query("update playlist_entries set position = position - 1 where playlist_id = $1 and position > $2", [id, r.rows[0].position]);
    return (await c.query("update playlists set version = version + 1, updated_at = now() where id = $1 returning version", [id])).rows[0];
  });
  return json(out);
});

import { z } from "zod";
import { replayAccess, requireUser } from "@/lib/access";
import { manifestFor, validateAnchor } from "@/lib/anchors";
import { tx } from "@/lib/db";
import { badRequest, body, conflict, forbidden, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { assertVersion, playlistAccess, requireEdit } from "@/lib/playlists";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Add = z.object({
  replayId: z.string().max(64),
  roundId: z.string().max(8),
  tick: z.number().int(),
  endTick: z.number().int().nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
  version: z.number().int().optional(),
});

/** Append an entry. The caller must be able to open the source replay (share links do not count). */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const p = await body(req, Add);
  const ra = await replayAccess(req, p.replayId, { user });
  if (ra.via === "share") throw forbidden("Open the replay with your account to add it to a playlist.");
  const m = await manifestFor(ra);
  const { revision } = validateAnchor(m, p);
  const out = await tx(async (c) => {
    const a = await playlistAccess(user, id, c, true);
    requireEdit(a);
    assertVersion(a.playlist, p.version);
    const n = (await c.query("select count(*)::int as n from playlist_entries where playlist_id = $1", [id])).rows[0].n;
    if (n >= 500) throw badRequest("A playlist can hold at most 500 entries.");
    const entryId = "pe_" + newId();
    await c.query(
      `insert into playlist_entries(id, playlist_id, position, replay_id, revision, round_id, tick, end_tick, label, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entryId, id, n, p.replayId, revision, p.roundId, p.tick, p.endTick ?? null, p.label ?? null, user.id],
    );
    const v = (await c.query("update playlists set version = version + 1, updated_at = now() where id = $1 returning version", [id])).rows[0].version;
    return { id: entryId, version: v };
  });
  return json(out, { status: 201 });
});

const Reorder = z.object({ version: z.number().int(), order: z.array(z.string()).max(500) });

/** Reorder atomically. Rejected with 409 if the playlist changed since the client loaded `version`. */
export const PUT = route(async (req: Request, ctx: Ctx) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const p = await body(req, Reorder);
  const out = await tx(async (c) => {
    const a = await playlistAccess(user, id, c, true);
    requireEdit(a);
    assertVersion(a.playlist, p.version);
    const ids = (await c.query("select id from playlist_entries where playlist_id = $1", [id])).rows.map((r) => r.id as string);
    const set = new Set(ids);
    if (ids.length !== p.order.length || new Set(p.order).size !== p.order.length || !p.order.every((x) => set.has(x))) {
      throw conflict("The entry list changed. Reload the playlist and try again.", "VERSION_CONFLICT");
    }
    // unique(playlist_id, position) is deferrable, so positions can be rewritten in one transaction.
    await c.query("set constraints all deferred");
    await c.query(
      `update playlist_entries e set position = o.pos - 1
         from unnest($2::text[]) with ordinality as o(id, pos) where e.id = o.id and e.playlist_id = $1`,
      [id, p.order],
    );
    const v = (await c.query("update playlists set version = version + 1, updated_at = now() where id = $1 returning version", [id])).rows[0].version;
    return { version: v };
  });
  return json(out);
});

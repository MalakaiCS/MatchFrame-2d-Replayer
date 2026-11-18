import { replayAccess } from "@/lib/access";
import { tx } from "@/lib/db";
import { conflict, forbidden, json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Re-run parsing as a new revision (e.g. after a parser upgrade). The current published revision stays playable. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden("Only the owner can reprocess this replay.");
  if (!a.replay.source_key) throw conflict("The source demo is no longer stored. Upload the demo again to reprocess it.", "SOURCE_MISSING");
  const rev = await tx(async (c) => {
    const busy = (await c.query("select 1 from jobs where replay_id = $1 and kind = 'parse' and status in ('queued','running')", [id])).rowCount;
    if (busy) throw conflict("This replay is already being processed.", "BUSY");
    const r = (await c.query(
      "update replays set revision = revision + 1, status = case when published_revision is null then 'queued' else status end, updated_at = now() where id = $1 returning revision",
      [id])).rows[0];
    await c.query("insert into jobs(replay_id, revision, kind) values ($1, $2, 'parse')", [id, r.revision]);
    return r.revision as number;
  });
  return json({ ok: true, revision: rev }, { status: 202 });
});

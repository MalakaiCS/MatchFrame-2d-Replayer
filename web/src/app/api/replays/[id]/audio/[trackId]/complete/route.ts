import { replayAccess } from "@/lib/access";
import { requireManage, trackFor } from "@/lib/audio";
import { q } from "@/lib/db";
import { badRequest, json, route } from "@/lib/http";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Verify the uploaded MP3 (size and MPEG/ID3 header), then mark the track ready. Idempotent. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string; trackId: string }> }) => {
  const { id, trackId } = await ctx.params;
  const a = await replayAccess(req, id);
  const t = await trackFor(a, trackId);
  requireManage(a, t);
  if (t.status === "ready") return json({ ok: true, duplicate: true });
  const storage = getStorage();
  const size = await storage.size(t.object_key);
  if (size === null) throw badRequest("No file was received for this recording.", "UPLOAD_MISSING");
  const head = await storage.readHead(t.object_key, 3);
  const isId3 = head.toString("latin1") === "ID3";
  const isFrame = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  if (size !== Number(t.size_bytes) || !(isId3 || isFrame)) {
    await storage.delete(t.object_key);
    await q("update audio_tracks set status = 'deleted' where id = $1", [trackId]);
    throw badRequest("The file is not a valid MP3 recording.", "UNSUPPORTED_AUDIO");
  }
  await q("update audio_tracks set status = 'ready', updated_at = now() where id = $1", [trackId]);
  return json({ ok: true });
});

import { replayAccess } from "@/lib/access";
import { notFound, PRIVATE_HEADERS, route } from "@/lib/http";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * One compressed round payload, authorised on every request and streamed (no storage URL is exposed).
 * Served as an explicit gzip binary (not Content-Encoding) so frameworks and proxies cannot strip the
 * encoding header or recompress it; the client decompresses with DecompressionStream.
 */
export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string; roundId: string }> }) => {
  const { id, roundId } = await ctx.params;
  if (!/^r\d{2,3}$/.test(roundId)) throw notFound();
  const a = await replayAccess(req, id);
  // A round link opens exactly one round.
  if (a.shareRoundId && a.shareRoundId !== roundId) throw notFound();
  if (a.replay.status !== "ready" || !a.replay.published_prefix) throw notFound();
  const obj = await getStorage().stream(`${a.replay.published_prefix}/rounds/${roundId}.json.gz`);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/octet-stream",
      "X-Content-Format": "application/json+gzip",
      "Content-Length": String(obj.total),
      "X-Replay-Revision": String(a.replay.published_revision),
    },
  });
});

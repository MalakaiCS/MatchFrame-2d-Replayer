import { type AudioRow, canListen, verifyStream } from "@/lib/audio";
import type { Access, ReplayRow } from "@/lib/access";
import { userTeams, VISIBLE_REPLAYS_SQL } from "@/lib/access";
import { q1 } from "@/lib/db";
import { HttpError, notFound, PRIVATE_HEADERS, route } from "@/lib/http";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Range-capable audio stream. The URL is short-lived and bound to one viewer; on
 * every request the grant is re-checked, so revoking a link or a team membership
 * stops playback at the next range request.
 */
export const GET = route(async (req: Request, ctx: { params: Promise<{ trackId: string }> }) => {
  const { trackId } = await ctx.params;
  const u = new URL(req.url);
  const principal = u.searchParams.get("p") ?? "";
  const exp = Number(u.searchParams.get("exp"));
  if (!verifyStream(trackId, principal, exp, u.searchParams.get("sig") ?? "")) {
    throw new HttpError(403, "STREAM_EXPIRED", "The audio link has expired. Reload the replay.");
  }
  const t = await q1<AudioRow>("select * from audio_tracks where id = $1", [trackId]);
  if (!t) throw notFound();
  const replay = await q1<ReplayRow>("select * from replays where id = $1 and deleted_at is null", [t.replay_id]);
  if (!replay) throw notFound();
  let access: Access;
  if (principal.startsWith("link:")) {
    const link = await q1("select 1 from share_links where id = $1 and replay_id = $2 and revoked_at is null", [principal.slice(5), replay.id]);
    if (!link) throw notFound();
    access = { replay, user: null, via: "share", canManage: false, canReview: false, shareLinkId: principal.slice(5), teams: [] };
  } else if (principal.startsWith("user:")) {
    const userId = principal.slice(5);
    const visible = await q1(`select 1 from replays r where r.id = $2 and ${VISIBLE_REPLAYS_SQL}`, [userId, replay.id]);
    if (!visible) throw notFound();
    access = { replay, user: { id: userId, email: "", name: "" }, via: "grant", canManage: false, canReview: false, shareLinkId: null, teams: await userTeams(userId) };
  } else throw notFound();
  if (!canListen(access, t)) throw notFound();

  const range = req.headers.get("range");
  let r: { start: number; end?: number } | undefined;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      const total = Number(t.size_bytes);
      r = m[1] ? { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined } : { start: Math.max(0, total - Number(m[2])) };
    }
  }
  const obj = await getStorage().stream(t.object_key, r);
  if (!obj) throw notFound();
  const headers: Record<string, string> = {
    ...PRIVATE_HEADERS,
    "Content-Type": t.mime_type,
    "Accept-Ranges": "bytes",
    "Content-Length": String(obj.size),
  };
  if (r) headers["Content-Range"] = `bytes ${obj.start}-${obj.end}/${obj.total}`;
  return new Response(obj.body, { status: r ? 206 : 200, headers });
});

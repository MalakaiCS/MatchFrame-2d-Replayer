import { z } from "zod";
import { replayAccess } from "@/lib/access";
import { trackView, visibleTracks } from "@/lib/audio";
import { q, q1 } from "@/lib/db";
import { env } from "@/lib/env";
import { badRequest, body, forbidden, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { assertTeamScope } from "@/lib/review-scope";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  const tracks = await visibleTracks(a);
  return json({ tracks: tracks.map((t) => trackView(a, t)), canUpload: a.canReview && !!a.user, acceptedTypes: ["audio/mpeg"] });
});

const Create = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
  label: z.string().trim().min(1).max(120),
  teamId: z.string().nullable().optional(),
  offsetMs: z.number().int().min(-86_400_000).max(86_400_000).default(0),
});

/** Create an upload slot for an MP3 recording. */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (!a.user || !a.canReview) throw forbidden("You cannot add recordings to this replay.");
  const p = await body(req, Create);
  if (!p.filename.toLowerCase().endsWith(".mp3")) throw badRequest("Only MP3 recordings are accepted.", "UNSUPPORTED_AUDIO");
  if (p.size > env.maxAudioBytes) throw badRequest(`Recordings are limited to ${(env.maxAudioBytes / 2 ** 20).toFixed(0)} MiB.`, "TOO_LARGE");
  const teamId = await assertTeamScope(a, p.teamId);
  const n = await q1<{ n: number }>("select count(*)::int as n from audio_tracks where replay_id = $1 and status <> 'deleted'", [id]);
  if ((n?.n ?? 0) >= 20) throw badRequest("A replay can have at most 20 recordings.");
  const trackId = "au_" + newId();
  const key = `audio/${id}/${trackId}.mp3`;
  const upload = await getStorage().createUploadTarget(key, p.size, env.maxAudioBytes, "audio/mpeg");
  await q(
    `insert into audio_tracks(id, replay_id, object_key, label, mime_type, size_bytes, offset_ms, team_id, uploaded_by)
     values ($1,$2,$3,$4,'audio/mpeg',$5,$6,$7,$8)`,
    [trackId, id, key, p.label, p.size, p.offsetMs, teamId, a.user.id],
  );
  return json({ trackId, upload }, { status: 201 });
});

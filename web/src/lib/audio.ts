/**
 * Voice-comms authorisation. Audio has its own grant, independent of replay link access:
 * - the uploader, and members of the track's team (when that team can open the replay), may listen;
 * - a share-link viewer may listen only to tracks explicitly marked share_with_link.
 */
import type { Access } from "./access";
import { MANAGE_ROLES } from "./access";
import { q, q1 } from "./db";
import { env } from "./env";
import { forbidden, notFound } from "./http";
import { hmac, safeEqual } from "./ids";

export interface AudioRow {
  id: string;
  replay_id: string;
  object_key: string;
  label: string;
  mime_type: string;
  size_bytes: string;
  duration_ms: number | null;
  offset_ms: number;
  team_id: string | null;
  uploaded_by: string;
  share_with_link: boolean;
  status: string;
  created_at: string;
}

export function canListen(a: Access, t: AudioRow): boolean {
  if (t.status !== "ready") return false;
  if (a.via === "share") return t.share_with_link;
  if (!a.user) return false;
  if (t.uploaded_by === a.user.id) return true;
  // Team tracks: the team was checked to have replay access when the track was scoped to it,
  // and callers verify the viewer's own replay access separately.
  return !!t.team_id && a.teams.some((m) => m.team_id === t.team_id);
}

export function canManageTrack(a: Access, t: AudioRow): boolean {
  if (!a.user) return false;
  if (t.uploaded_by === a.user.id) return true;
  const role = t.team_id ? a.teams.find((m) => m.team_id === t.team_id)?.role : undefined;
  return !!role && MANAGE_ROLES.includes(role);
}

export async function visibleTracks(a: Access): Promise<AudioRow[]> {
  const rows = await q<AudioRow>("select * from audio_tracks where replay_id = $1 and status = 'ready' order by created_at", [a.replay.id]);
  return rows.filter((t) => canListen(a, t));
}

export async function trackFor(a: Access, trackId: string): Promise<AudioRow> {
  const t = await q1<AudioRow>("select * from audio_tracks where id = $1 and replay_id = $2 and status <> 'deleted'", [trackId, a.replay.id]);
  if (!t) throw notFound();
  if (!canManageTrack(a, t) && !canListen(a, t)) throw notFound();
  return t;
}

export function requireManage(a: Access, t: AudioRow) {
  if (!canManageTrack(a, t)) throw forbidden("Only the uploader or a team coach can change this recording.");
}

/** Short-lived stream URL bound to the track and to the viewer principal (user id or share link id). */
export function streamUrl(trackId: string, principal: string) {
  const exp = Math.floor(Date.now() / 1000) + env.streamUrlSeconds;
  const sig = hmac(env.signingSecret(), `audio|${trackId}|${principal}|${exp}`);
  return `/api/audio/${trackId}/stream?${new URLSearchParams({ p: principal, exp: String(exp), sig })}`;
}

export function verifyStream(trackId: string, principal: string, exp: number, sig: string) {
  return exp * 1000 > Date.now() && safeEqual(sig, hmac(env.signingSecret(), `audio|${trackId}|${principal}|${exp}`));
}

export function principalOf(a: Access): string {
  return a.via === "share" ? `link:${a.shareLinkId}` : `user:${a.user!.id}`;
}

export function trackView(a: Access, t: AudioRow) {
  return {
    id: t.id,
    label: t.label,
    mimeType: t.mime_type,
    sizeBytes: Number(t.size_bytes),
    durationMs: t.duration_ms,
    offsetMs: t.offset_ms,
    teamId: t.team_id,
    shareWithLink: t.share_with_link,
    canManage: canManageTrack(a, t),
    streamUrl: streamUrl(t.id, principalOf(a)),
  };
}

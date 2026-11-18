import type { PoolClient } from "pg";
import { REVIEW_ROLES, userTeams, VISIBLE_REPLAYS_SQL, type TeamRole } from "./access";
import type { SessionUser } from "./auth";
import { anchorStatus } from "./anchors";
import { q, q1 } from "./db";
import { conflict, forbidden, notFound } from "./http";
import { loadManifest } from "./manifest";

export interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  team_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlaylistAccess {
  playlist: PlaylistRow;
  canEdit: boolean;
  canDelete: boolean;
  role: TeamRole | "owner-user" | null;
}

/** Owner, or any member of the playlist's team. Others get 404 (existence is not revealed). */
export async function playlistAccess(user: SessionUser, id: string, c?: PoolClient, lock = false): Promise<PlaylistAccess> {
  const sql = `select * from playlists where id = $1${lock ? " for update" : ""}`;
  const p = c ? ((await c.query(sql, [id])).rows[0] as PlaylistRow | undefined) : await q1<PlaylistRow>(sql, [id]);
  if (!p) throw notFound();
  if (p.owner_id === user.id) return { playlist: p, canEdit: true, canDelete: true, role: "owner-user" };
  if (p.team_id) {
    const role = (await userTeams(user.id)).find((t) => t.team_id === p.team_id)?.role;
    if (role) {
      return { playlist: p, canEdit: REVIEW_ROLES.includes(role), canDelete: role === "owner" || role === "coach", role };
    }
  }
  throw notFound();
}

export function assertVersion(p: PlaylistRow, version: number | undefined) {
  if (version !== undefined && version !== p.version) {
    throw conflict("This playlist was changed by someone else. Reload it and try again.", "VERSION_CONFLICT");
  }
}

/**
 * Entries with availability resolved for THIS viewer. A playlist never exposes
 * a replay the viewer cannot open: such entries are returned as unavailable
 * with no replay metadata.
 */
export async function playlistEntries(user: SessionUser, playlistId: string) {
  const entries = await q<{
    id: string; position: number; replay_id: string | null; revision: number; round_id: string; tick: number;
    end_tick: number | null; label: string | null; created_by: string;
  }>("select * from playlist_entries where playlist_id = $1 order by position", [playlistId]);
  const ids = [...new Set(entries.map((e) => e.replay_id).filter(Boolean))] as string[];
  const visible = ids.length
    ? await q<{ id: string; map_id: string; team_a_name: string; team_b_name: string; title: string | null; published_prefix: string | null; status: string }>(
        `select r.id, r.map_id, r.team_a_name, r.team_b_name, r.title, r.published_prefix, r.status
           from replays r where r.id = any($2::text[]) and ${VISIBLE_REPLAYS_SQL}`,
        [user.id, ids],
      )
    : [];
  const byId = new Map(visible.map((v) => [v.id, v]));
  const out = [];
  for (const e of entries) {
    const r = e.replay_id ? byId.get(e.replay_id) : undefined;
    if (!r || r.status !== "ready" || !r.published_prefix) {
      out.push({ id: e.id, position: e.position, label: e.label, available: false as const,
        reason: !e.replay_id ? "removed" : !r ? "no-access" : "not-ready" });
      continue;
    }
    const m = await loadManifest(r.published_prefix);
    const st = anchorStatus(m, e.revision, e.round_id, e.tick);
    out.push({
      id: e.id, position: e.position, label: e.label, available: st.status !== "unavailable",
      reason: st.status === "unavailable" ? "anchor-missing" : null,
      replayId: r.id, roundId: e.round_id, tick: e.tick, endTick: e.end_tick, anchorStatus: st.status,
      displayNumber: st.displayNumber, mapId: r.map_id, teamA: r.team_a_name, teamB: r.team_b_name, title: r.title,
      tickIntervalMs: m.tickIntervalMs,
      roundStartTick: m.rounds.find((x) => x.id === e.round_id)?.startTick ?? null,
    });
  }
  return out;
}

export function requireEdit(a: PlaylistAccess) {
  if (!a.canEdit) throw forbidden("You can view this playlist but not change it.");
}

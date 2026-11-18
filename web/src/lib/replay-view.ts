import type { Access, ReplayRow } from "./access";

/** The replay fields a client may see. Never includes storage keys. */
export function publicReplay(r: ReplayRow) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    failureCode: r.failure_code,
    failureDetail: r.failure_detail,
    visibility: r.visibility,
    sourceType: r.source_type,
    sourceFilename: r.source_filename,
    sourceAvailable: r.source_key !== null,
    revision: r.revision,
    publishedRevision: r.published_revision,
    mapId: r.map_id,
    teamA: r.team_a_name,
    teamB: r.team_b_name,
    scoreA: r.score_a,
    scoreB: r.score_b,
    roundCount: r.round_count,
    teamId: r.team_id,
    seriesId: r.series_id,
    seriesMapIndex: r.series_map_index,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function accessView(a: Access) {
  return { via: a.via, canManage: a.canManage, canReview: a.canReview, signedIn: !!a.user };
}

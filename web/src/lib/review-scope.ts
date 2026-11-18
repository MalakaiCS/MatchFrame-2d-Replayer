import { REVIEW_ROLES, type Access } from "./access";
import { q1 } from "./db";
import { badRequest } from "./http";

/** A team may hold review items on a replay only if that team itself can open the replay. */
export async function assertTeamScope(a: Access, teamId: string | null | undefined): Promise<string | null> {
  if (!teamId) return null;
  const m = a.teams.find((t) => t.team_id === teamId);
  if (!m || !REVIEW_ROLES.includes(m.role)) throw badRequest("You cannot post to that team.", "FORBIDDEN_TEAM");
  const ok =
    a.replay.team_id === teamId ||
    (await q1("select 1 from replay_grants where replay_id = $1 and team_id = $2", [a.replay.id, teamId]));
  if (!ok) throw badRequest("That team does not have access to this replay. Share the replay with the team first.", "TEAM_NO_ACCESS");
  return teamId;
}

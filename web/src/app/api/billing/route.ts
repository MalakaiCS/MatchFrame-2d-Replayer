import { requireUser, userTeams } from "@/lib/access";
import { billing, coverage, planFor, priceFor } from "@/lib/billing";
import { q } from "@/lib/db";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The signed-in user's plans: their personal plan, and the plan of every team they belong to. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const memberships = await userTeams(user.id);
  const names = memberships.length
    ? new Map((await q<{ id: string; name: string }>("select id, name from teams where id = any($1::text[])", [memberships.map((m) => m.team_id)])).map((t) => [t.id, t.name]))
    : new Map<string, string>();
  const cov = await coverage(user.id);
  const [pm, py, tm, ty] = await Promise.all([priceFor("personal"), priceFor("personal", "year"), priceFor("team"), priceFor("team", "year")]);
  const members = memberships.length
    ? new Map((await q<{ team_id: string; n: number }>("select team_id, count(*)::int as n from team_members where team_id = any($1::text[]) group by team_id",
      [memberships.map((m) => m.team_id)])).map((r) => [r.team_id, r.n]))
    : new Map<string, number>();
  const teams = await Promise.all(memberships.map(async (m) => ({
    id: m.team_id,
    name: names.get(m.team_id) ?? "Team",
    role: m.role,
    canManageBilling: m.role === "owner",
    members: members.get(m.team_id) ?? 1,
    plan: await planFor({ teamId: m.team_id }),
  })));
  return json({
    enabled: billing.enabled(),
    configured: billing.configured(),
    teamMemberLimit: billing.teamMemberLimit() || null,
    prices: { personal: pm, team: tm },
    yearly: { personal: py, team: ty },
    perSeat: billing.perSeat(),
    minSeats: billing.minSeats(),
    personal: await planFor({ userId: user.id }),
    teams: teams.sort((a, b) => a.name.localeCompare(b.name)),
    // What the user can do right now (always everything when billing is off).
    access: billing.enabled()
      ? { personal: cov.personal, coveredTeams: [...cov.teams], canUse: cov.personal || cov.teams.size > 0 }
      : { personal: true, coveredTeams: memberships.map((m) => m.team_id), canUse: true },
  });
});

import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { json, route } from "@/lib/http";
import { indexedReplays, type PlayerSummary } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";
import { derive, rating10 } from "@/viewer/stats";

export const dynamic = "force-dynamic";

const ZERO = (): PlayerSummary => ({
  id: "me", name: "", team: "A", steamId: null, isBot: false, rounds: 0, k: 0, d: 0, a: 0, fa: 0, hs: 0, tk: 0, dmg: 0, ud: 0, ef: 0, fd: 0,
  ok: 0, od: 0, trk: 0, trd: 0, kast: 0, surv: 0, clutches: 0, clutchesWon: 0, clutchByVs: {}, multi: { 2: 0, 3: 0, 4: 0, 5: 0 }, oneK: 0,
});
const SUM = ["rounds", "k", "d", "a", "fa", "hs", "tk", "dmg", "ud", "ef", "fd", "ok", "od", "trk", "trd", "kast", "surv", "clutches", "clutchesWon", "oneK"] as const;
function add(t: PlayerSummary, p: PlayerSummary) {
  for (const f of SUM) t[f] += p[f];
  for (const m of [2, 3, 4, 5] as const) t.multi[m] += p.multi[m];
}

/** Your own stats across every demo you can open, found by your linked Steam accounts. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const ids = (await q<{ steam_id: string }>("select steam_id from user_steam_ids where user_id = $1", [user.id])).map((r) => r.steam_id);
  if (!ids.length) return json({ linked: [], maps: 0, pending: 0 });
  const { replays, pending } = await indexedReplays(await statReplays(user, new URL(req.url)));
  const total = ZERO();
  const byMap = new Map<string, PlayerSummary & { maps: number; wins: number }>();
  const matches: { replayId: string; mapId: string | null; when: string; team: string; opponent: string; score: number; oppScore: number; k: number; d: number; adr: number | null; rating: number }[] = [];
  let hasDamage = false;
  for (const r of replays) {
    const me = r.summary.players.find((p) => p.steamId && ids.includes(p.steamId));
    if (!me || !r.summary.hasPlayers || me.rounds === 0) continue;
    hasDamage ||= r.summary.players.some((p) => p.dmg > 0);
    add(total, me);
    const mine = r.summary.teams[me.team];
    const opp = r.summary.teams[me.team === "A" ? "B" : "A"];
    const key = r.mapId ?? "unknown";
    const mm = byMap.get(key) ?? { ...ZERO(), maps: 0, wins: 0 };
    add(mm, me);
    mm.maps += 1;
    if (mine.score > mine.oppScore) mm.wins += 1;
    byMap.set(key, mm);
    matches.push({
      replayId: r.id, mapId: r.mapId, when: r.playedAt ?? r.createdAt, team: mine.name, opponent: opp.name, score: mine.score, oppScore: mine.oppScore,
      k: me.k, d: me.d, adr: me.dmg > 0 ? me.dmg / me.rounds : null, rating: rating10(me),
    });
  }
  matches.sort((a, b) => b.when.localeCompare(a.when));
  const best = (f: (m: (typeof matches)[number]) => number) => (matches.length ? matches.reduce((a, b) => (f(b) > f(a) ? b : a)) : null);
  return json({
    linked: ids, maps: matches.length, pending,
    overall: total.rounds ? { ...derive(total, hasDamage), rounds: total.rounds, k: total.k, d: total.d, a: total.a, clutches: `${total.clutchesWon}/${total.clutches}`, multi3: total.multi[3] + total.multi[4] + total.multi[5], ud: total.ud, ef: total.ef } : null,
    byMap: [...byMap.entries()].map(([mapId, m]) => ({ mapId, maps: m.maps, wins: m.wins, ...derive(m, hasDamage), k: m.k, d: m.d })).sort((a, b) => b.maps - a.maps),
    matches: matches.slice(0, 50),
    bests: {
      kills: best((m) => m.k),
      rating: best((m) => m.rating),
      adr: hasDamage ? best((m) => m.adr ?? 0) : null,
    },
  });
});

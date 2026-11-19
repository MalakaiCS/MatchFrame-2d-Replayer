"use client";
/**
 * Stats across demos. Hub: every in-game team found in the demos you can open (your own team and
 * the teams you play or scout). Team page: record per map, side and pistol win rates, opening
 * duels, clutches, the roster's stats over all demos, recent matches and opponents.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { mapName } from "@/viewer/maps";
import { api, ApiError } from "./api";
import { InsightsPanel } from "./Insights";

interface WL { w: number; p: number }
interface TeamItem { key: string; name: string; demos: number; wins: number; losses: number; draws: number; maps: string[]; lastPlayed: string }
interface MapRecord { mapId: string; played: number; wins: number; losses: number; rounds: WL; ct: WL; t: WL; pistol: WL; opening: WL; clutch: WL }
interface TeamDetail {
  pending: number; name: string; demos: number; wins: number; losses: number; draws: number; overall: MapRecord; maps: MapRecord[];
  matches: { replayId: string; mapId: string | null; title: string | null; when: string; opponent: string; score: number; oppScore: number; result: "W" | "L" | "D"; rating: number | null }[];
  players: { key: string; name: string; maps: number; rounds: number; k: number; d: number; a: number; adr: number | null; kast: number; hs: number; rating: number; openingPct: number | null; clutches: string; multi: number }[];
  opponents: { name: string; wins: number; losses: number; demos: number }[];
}
interface TeamOption { id: string; name: string }

const rate = (x: WL) => (x.p ? `${Math.round((100 * x.w) / x.p)}%` : "—");
const frac = (x: WL) => `${x.w}/${x.p}`;

/** Space picker shared by both pages: all demos, personal, or one team library. */
function useSpace() {
  const params = useSearchParams();
  const [teams, setTeams] = useState<TeamOption[]>([]);
  useEffect(() => { api<{ teams: TeamOption[] }>("/api/teams").then((r) => setTeams(r.teams)).catch(() => {}); }, []);
  const space = params.get("space") ?? "all";
  const teamId = params.get("teamId") ?? "";
  const qs = new URLSearchParams({ space, ...(space === "team" && teamId ? { teamId } : {}) });
  return { teams, space, teamId, qs };
}

function SpacePicker({ teams, space, teamId, onChange }: { teams: TeamOption[]; space: string; teamId: string; onChange: (space: string, teamId: string) => void }) {
  const value = space === "team" ? `team:${teamId}` : space;
  return (
    <label className="row" style={{ fontSize: 13 }}>
      <span className="faint">Demos from</span>
      <select className="select" value={value} onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith("team:")) onChange("team", v.slice(5));
        else onChange(v, "");
      }}>
        <option value="all">All demos I can open</option>
        <option value="personal">My personal demos</option>
        {teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name} team demos</option>)}
      </select>
    </label>
  );
}

export function StatsHub() {
  const router = useRouter();
  const { teams, space, teamId, qs } = useSpace();
  const [data, setData] = useState<{ demos: number; withPlayerStats: number; unnamed: number; pending: number; teams: TeamItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const qsKey = qs.toString();

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/stats?${qsKey}`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/stats");
      else setError(e instanceof Error ? e.message : "Could not load stats.");
    }
  }, [qsKey, router]);
  useEffect(() => void load(), [load]);
  // Large libraries are summarised in batches; keep going until everything is in.
  useEffect(() => {
    if (!data?.pending) return;
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [data, load]);

  const shown = useMemo(() => (data?.teams ?? []).filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase())), [data, search]);
  const go = (s: string, id: string) => router.replace(`/stats?${new URLSearchParams({ space: s, ...(id ? { teamId: id } : {}) })}`);

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <h1>Stats</h1>
      <p className="page-sub">Every team in your demos, your own and the ones you play or scout. Open a team for its record per map, players and matches.</p>
      <div className="lib-toolbar">
        <label className="sr-only" htmlFor="team-search">Search teams</label>
        <input id="team-search" className="input" placeholder="Search teams" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
        <SpacePicker teams={teams} space={space} teamId={teamId} onChange={go} />
      </div>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {data ? (
        <p className="faint" style={{ fontSize: 13 }}>
          {data.demos} demos{data.pending ? `, summarising ${data.pending} more…` : ""}
          {data.withPlayerStats < data.demos ? ` · ${data.demos - data.withPlayerStats} without player stats (processed before stats were added)` : ""}
          {data.unnamed ? ` · ${data.unnamed} with no team names (rename the teams in the replay to include them)` : ""}
        </p>
      ) : <p className="muted">Loading…</p>}
      {data && shown.length === 0 && !data.pending ? <div className="empty">No named teams in these demos yet.</div> : null}
      <div className="st-grid">
        {shown.map((t) => (
          <Link key={t.key} className="card st-team" href={`/stats/team?${new URLSearchParams({ name: t.name, space, ...(space === "team" && teamId ? { teamId } : {}) })}`}>
            <strong>{t.name}</strong>
            <span className="st-record mono"><span className="ms-pos">{t.wins}W</span> <span className="ms-neg">{t.losses}L</span>{t.draws ? ` ${t.draws}D` : ""}</span>
            <span className="faint" style={{ fontSize: 12 }}>{t.demos} demo{t.demos === 1 ? "" : "s"} · {t.maps.map((m) => mapName(m)).join(", ")}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function TeamOverview() {
  const router = useRouter();
  const params = useSearchParams();
  const { teams, space, teamId, qs } = useSpace();
  const name = params.get("name") ?? "";
  const map = params.get("map") ?? "";
  const [d, setD] = useState<TeamDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qsKey = qs.toString();

  const load = useCallback(async () => {
    try {
      setD(await api(`/api/stats/team?${new URLSearchParams({ name, ...(map ? { map } : {}) })}&${qsKey}`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push(`/login?next=${encodeURIComponent(`/stats/team?name=${name}`)}`);
      else setError(e instanceof ApiError && e.status === 404 ? `No demos with ${name} in this selection.` : e instanceof Error ? e.message : "Could not load the team.");
    }
  }, [name, map, qsKey, router]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!d?.pending) return;
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [d, load]);

  const link = (over: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(over)) { if (v) p.set(k, v); else p.delete(k); }
    return `/stats/team?${p}`;
  };
  const allMaps = d ? [...new Set(d.matches.map((m) => m.mapId).filter(Boolean) as string[])] : [];

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <p className="ms-eyebrow"><Link href={`/stats?${qsKey}`}>Stats</Link> · Team overview</p>
      <div className="ms-head">
        <h1 style={{ margin: 0 }}>{d?.name ?? name}</h1>
        <SpacePicker teams={teams} space={space} teamId={teamId} onChange={(s, id) => router.replace(link({ space: s, teamId: id }))} />
      </div>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {!d && !error ? <p className="muted">Loading…</p> : null}
      {d ? (
        <>
          <div className="ms-filters" role="group" aria-label="Map filter">
            <span className="faint">Map</span>
            <Link className="chip" aria-pressed={!map} href={link({ map: "" })}>All maps</Link>
            {(map && !allMaps.includes(map) ? [...allMaps, map] : allMaps).map((m) => (
              <Link key={m} className="chip" aria-pressed={map === m} href={link({ map: m })}>{mapName(m)}</Link>
            ))}
          </div>

          <div className="st-kpis">
            <Kpi label="Record" value={`${d.wins}–${d.losses}${d.draws ? `–${d.draws}` : ""}`} sub={`${d.demos} maps`} />
            <Kpi label="Round win rate" value={rate(d.overall.rounds)} sub={frac(d.overall.rounds)} />
            <Kpi label="CT rounds" value={rate(d.overall.ct)} sub={frac(d.overall.ct)} />
            <Kpi label="T rounds" value={rate(d.overall.t)} sub={frac(d.overall.t)} />
            <Kpi label="Pistols" value={rate(d.overall.pistol)} sub={frac(d.overall.pistol)} />
            <Kpi label="Opening duels" value={rate(d.overall.opening)} sub={frac(d.overall.opening)} />
            <Kpi label="Clutches" value={rate(d.overall.clutch)} sub={frac(d.overall.clutch)} />
          </div>

          <section className="ms-table-wrap" aria-label="Record by map">
            <h2 className="ms-table-title">By map</h2>
            <div className="ms-scroll">
              <table className="ms-table">
                <thead><tr><th className="ms-name">Map</th><th>Played</th><th>W–L</th><th>Rounds</th><th>CT</th><th>T</th><th>Pistols</th><th>Opening duels</th><th>Clutches</th></tr></thead>
                <tbody>
                  {d.maps.map((m) => (
                    <tr key={m.mapId}>
                      <th scope="row" className="ms-name"><Link href={link({ map: m.mapId })}>{mapName(m.mapId)}</Link></th>
                      <td>{m.played}</td><td>{m.wins}–{m.losses}</td><td>{rate(m.rounds)}</td><td>{rate(m.ct)}</td><td>{rate(m.t)}</td>
                      <td>{rate(m.pistol)}</td><td>{rate(m.opening)}</td><td>{rate(m.clutch)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ms-table-wrap" aria-label="Players">
            <h2 className="ms-table-title">Players</h2>
            <div className="ms-scroll">
              <table className="ms-table">
                <thead><tr><th className="ms-name">Player</th><th>Maps</th><th>Rounds</th><th>K</th><th>D</th><th>A</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Opening</th><th>Clutches</th><th>3K+</th><th>Rating 1.0</th></tr></thead>
                <tbody>
                  {d.players.map((p) => (
                    <tr key={p.key}>
                      <th scope="row" className="ms-name">{p.name}</th>
                      <td>{p.maps}</td><td>{p.rounds}</td><td>{p.k}</td><td>{p.d}</td><td>{p.a}</td>
                      <td>{p.adr === null ? "—" : p.adr.toFixed(1)}</td><td>{p.kast.toFixed(0)}%</td><td>{p.hs.toFixed(0)}%</td>
                      <td>{p.openingPct === null ? "—" : `${p.openingPct.toFixed(0)}%`}</td><td>{p.clutches}</td><td>{p.multi}</td>
                      <td className="ms-rating" data-good={p.rating >= 1.1} data-bad={p.rating < 0.9}>{p.rating.toFixed(2)}</td>
                    </tr>
                  ))}
                  {d.players.length === 0 ? <tr><td colSpan={13} className="faint">No player stats in these demos yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          {map ? (
            <InsightsPanel source={{ kind: "team", name: d.name, map, spaceQs: qsKey }} />
          ) : (
            <p className="alert" role="status" style={{ marginBottom: 18 }}>Pick a map above to see {d.name}&apos;s heatmaps and grenade lineups on it.</p>
          )}

          <div className="st-two">
            <section className="card" aria-label="Matches">
              <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>Matches</h2>
              <ol className="st-list">
                {d.matches.map((m) => (
                  <li key={m.replayId}>
                    <Link href={`/replays/${m.replayId}/stats`} className="st-match">
                      <span className={`st-result st-${m.result}`}>{m.result}</span>
                      <span className="grow">vs <strong>{m.opponent}</strong> <span className="faint">· {mapName(m.mapId)}</span></span>
                      <span className="mono">{m.score}–{m.oppScore}</span>
                      <span className="faint" style={{ fontSize: 12 }}>{new Date(m.when).toLocaleDateString()}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
            <section className="card" aria-label="Opponents">
              <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>Opponents</h2>
              <ol className="st-list">
                {d.opponents.map((o) => (
                  <li key={o.name}>
                    <Link href={link({ name: o.name, map: "" })} className="st-match">
                      <span className="grow"><strong>{o.name}</strong></span>
                      <span className="mono"><span className="ms-pos">{o.wins}W</span> <span className="ms-neg">{o.losses}L</span></span>
                      <span className="faint" style={{ fontSize: 12 }}>{o.demos} map{o.demos === 1 ? "" : "s"}</span>
                    </Link>
                  </li>
                ))}
              </ol>
              <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>Open an opponent to scout them across every demo you have of them.</p>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card st-kpi">
      <span className="faint">{label}</span>
      <strong className="mono">{value}</strong>
      <span className="faint mono" style={{ fontSize: 12 }}>{sub}</span>
    </div>
  );
}

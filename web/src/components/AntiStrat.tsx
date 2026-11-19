"use client";
/**
 * Pattern finder and anti-strat. Pick a team and a map, then:
 * - Automatic: every demo of that team on the map is scanned for repeatable habits (per player and
 *   per team), each with how often it happened, a confidence level, a counter and example rounds.
 * - Manual: all the team's demos in one list; pick the ones to study, and see the patterns, the
 *   heatmaps and the round list for just those.
 * An optional AI brief turns the patterns into a game plan.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getMapDef, type MapDef, mapName, worldToImage } from "@/viewer/maps";
import { api, ApiError } from "./api";
import { InsightsPanel } from "./Insights";
import { SpacePicker, useSpace } from "./StatsHub";

interface TeamItem { key: string; name: string; demos: number; maps: string[] }
interface Example { replayId: string; roundId: string; roundNumber: number; ms: number }
interface Pattern {
  id: string; category: string; side: "CT" | "T" | "both"; player?: string; title: string; detail: string;
  share: number; n: number; of: number; confidence: "strong" | "moderate" | "weak"; counter: string;
  spot?: { x: number; y: number; z: number; label: string }; examples: Example[];
}
interface Demo { id: string; title: string | null; when: string; opponent: string; side: "A" | "B"; score: string; won: boolean | null; ready: boolean }
interface Resp {
  team: string; map: string; list: Demo[]; pending: number; ai: boolean;
  report: { demos: number; rounds: { T: number; CT: number }; sites: string[]; players: { key: string; name: string }[]; patterns: Pattern[] };
}
interface Brief { summary: string; tSide: string[]; ctSide: string[]; players: { name: string; notes: string }[]; gamePlan: string[]; caveats: string[] }

const CATEGORIES: { id: string; label: string }[] = [
  { id: "site", label: "Site choice" }, { id: "pace", label: "Pace" }, { id: "setups", label: "CT setups" },
  { id: "positions", label: "Positions" }, { id: "openings", label: "Opening duels" }, { id: "utility", label: "Utility" },
  { id: "awp", label: "AWP" }, { id: "aggression", label: "Aggression" }, { id: "economy", label: "Economy" },
];
const catLabel = (c: string) => CATEGORIES.find((x) => x.id === c)?.label ?? c;
const CONF = { strong: "badge-ok", moderate: "badge-warn", weak: "" } as const;

export function AntiStrat() {
  const router = useRouter();
  const params = useSearchParams();
  const { teams: spaces, space, teamId, qs } = useSpace();
  const qsKey = qs.toString();
  const name = params.get("name") ?? "";
  const map = params.get("map") ?? "";
  const mode = params.get("mode") === "manual" ? "manual" : "auto";
  const [teams, setTeams] = useState<TeamItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((patch: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/antistrat?${p}`);
  }, [params, router]);

  useEffect(() => {
    let stop = false;
    const load = () => api<{ teams: TeamItem[]; pending: number }>(`/api/stats?${qsKey}`).then((r) => {
      if (stop) return;
      setTeams(r.teams);
      if (r.pending) setTimeout(load, 600);
    }).catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/antistrat");
      else if (!stop) setError(e instanceof Error ? e.message : "Could not load teams.");
    });
    load();
    return () => { stop = true; };
  }, [qsKey, router]);

  const team = teams?.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
  // Default to the team's first map.
  useEffect(() => { if (team && !map && team.maps[0]) set({ map: team.maps[0] }); }, [team, map, set]);

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <p className="ms-eyebrow"><Link href={`/stats?${qsKey}`}>Stats</Link> · Anti-strat</p>
      <h1>Pattern finder &amp; anti-strat</h1>
      <p className="page-sub">Scan every demo of a team on a map for the habits they repeat: where each player stands, which site they hit, how fast, who takes the first fight, the utility they always throw, how they buy. Every pattern shows how often it happened and links to the rounds.</p>
      <div className="lib-toolbar">
        <SpacePicker teams={spaces} space={space} teamId={teamId} onChange={(s, id) => set({ space: s, teamId: id })} />
        <label className="row" style={{ fontSize: 13 }}>
          <span className="faint">Team</span>
          <select className="select" aria-label="Team" value={team?.name ?? ""} onChange={(e) => set({ name: e.target.value, map: "" })}>
            <option value="">Pick a team…</option>
            {(teams ?? []).map((t) => <option key={t.key} value={t.name}>{t.name} ({t.demos})</option>)}
          </select>
        </label>
        {team ? (
          <label className="row" style={{ fontSize: 13 }}>
            <span className="faint">Map</span>
            <select className="select" aria-label="Map" value={map} onChange={(e) => set({ map: e.target.value })}>
              {team.maps.map((m) => <option key={m} value={m}>{mapName(m)}</option>)}
            </select>
          </label>
        ) : null}
        <div className="ins-group" role="tablist" aria-label="Mode">
          <button type="button" role="tab" className="chip" aria-selected={mode === "auto"} aria-pressed={mode === "auto"} onClick={() => set({ mode: "" })}>Automatic</button>
          <button type="button" role="tab" className="chip" aria-selected={mode === "manual"} aria-pressed={mode === "manual"} onClick={() => set({ mode: "manual" })}>Manual</button>
        </div>
      </div>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {!teams ? <p className="muted">Loading teams…</p> : !teams.length ? <div className="empty">No named teams in these demos yet. Upload demos (or rename the teams in a replay) to scan them.</div> : null}
      {teams?.length && !team ? (
        <div className="st-grid">
          {teams.map((t) => (
            <button key={t.key} type="button" className="card st-team" style={{ textAlign: "left" }} onClick={() => set({ name: t.name, map: "" })}>
              <strong>{t.name}</strong>
              <span className="faint" style={{ fontSize: 12 }}>{t.demos} demo{t.demos === 1 ? "" : "s"} · {t.maps.map((m) => mapName(m)).join(", ")}</span>
            </button>
          ))}
        </div>
      ) : null}
      {team && map ? (
        mode === "auto"
          ? <AutoMode key={`${team.name}|${map}|${qsKey}`} name={team.name} map={map} qsKey={qsKey} space={space} teamId={teamId} />
          : <ManualMode key={`${team.name}|${map}|${qsKey}`} name={team.name} map={map} qsKey={qsKey} space={space} teamId={teamId} />
      ) : null}
    </div>
  );
}

/** Loads patterns, asking again while demos are still being prepared. */
function usePatterns(name: string, map: string, qsKey: string, ids: string[] | null) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const idsKey = ids ? ids.join(",") : "";
  const skip = ids !== null && ids.length === 0;
  useEffect(() => {
    if (skip) return;
    let stop = false;
    const p = new URLSearchParams({ name, map, ...(idsKey ? { ids: idsKey } : {}) });
    api<Resp>(`/api/antistrat?${p}&${qsKey}`).then((r) => { if (!stop) { setData(r); setError(null); } })
      .catch((e) => { if (!stop) setError(e instanceof Error ? e.message : "Could not find patterns."); });
    return () => { stop = true; };
  }, [name, map, qsKey, idsKey, skip, tick]);
  useEffect(() => {
    if (!data?.pending) return;
    const h = setTimeout(() => setTick((n) => n + 1), 500);
    return () => clearTimeout(h);
  }, [data]);
  return { data, error };
}

function AutoMode({ name, map, qsKey, space, teamId }: { name: string; map: string; qsKey: string; space: string; teamId: string }) {
  const { data, error } = usePatterns(name, map, qsKey, null);
  if (error) return <p className="alert alert-err" role="alert">{error}</p>;
  if (!data) return <p className="muted">Scanning demos…</p>;
  return <Report data={data} name={name} map={map} ids={null} space={space} teamId={teamId} />;
}

function ManualMode({ name, map, qsKey, space, teamId }: { name: string; map: string; qsKey: string; space: string; teamId: string }) {
  // The full list comes from an automatic scan; the picked demos are then scanned on their own.
  const all = usePatterns(name, map, qsKey, null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);
  const list = all.data?.list ?? [];
  const sel = picked ?? new Set(list.map((d) => d.id));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  const res = usePatterns(name, map, qsKey, applied);
  const dirty = applied === null || applied.length !== sel.size || applied.some((id) => !sel.has(id));

  if (all.error) return <p className="alert alert-err" role="alert">{all.error}</p>;
  if (!all.data) return <p className="muted">Loading demos…</p>;
  return (
    <>
      <section className="card" aria-label="Demos" style={{ marginBottom: 16 }}>
        <div className="ins-head">
          <h2>{name} on {mapName(map)}: {list.length} demo{list.length === 1 ? "" : "s"}</h2>
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set(list.map((d) => d.id)))}>All</button>
            <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set())}>None</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!sel.size || !dirty} onClick={() => setApplied([...sel])}>
              Find patterns in {sel.size} selected
            </button>
          </span>
        </div>
        <div className="ms-table-wrap">
          <table className="ms-table">
            <thead><tr><th scope="col"><span className="sr-only">Pick</span></th><th scope="col">Date</th><th scope="col">Opponent</th><th scope="col">Score</th><th scope="col">Demo</th><th scope="col" /></tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id}>
                  <td><input type="checkbox" aria-label={`Use the demo against ${d.opponent}`} checked={sel.has(d.id)} onChange={() => toggle(d.id)} /></td>
                  <td className="mono">{d.when.slice(0, 10)}</td>
                  <td>vs {d.opponent}</td>
                  <td className={`mono ${d.won ? "ms-pos" : d.won === false ? "ms-neg" : ""}`}>{d.score}</td>
                  <td className="faint">{d.title ?? ""}</td>
                  <td><Link className="btn btn-sm" href={`/replays/${d.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {applied === null ? <p className="muted">Pick the demos to study and press “Find patterns”.</p>
        : res.error ? <p className="alert alert-err" role="alert">{res.error}</p>
          : !res.data ? <p className="muted">Scanning the selected demos…</p>
            : (
              <>
                <Report data={res.data} name={name} map={map} ids={applied} space={space} teamId={teamId} />
                <div style={{ marginTop: 16 }}>
                  <InsightsPanel source={{ kind: "team", name, map, spaceQs: `${qsKey}&ids=${applied.join(",")}` }} />
                </div>
                <p style={{ marginTop: 12 }}>
                  <Link className="btn" href={`/stats/rounds?${new URLSearchParams({ team: name, map })}&${qsKey}`}>Browse every round of {name} on {mapName(map)}</Link>
                </p>
              </>
            )}
    </>
  );
}

function Report({ data, name, map, ids, space, teamId }: { data: Resp; name: string; map: string; ids: string[] | null; space: string; teamId: string }) {
  const [side, setSide] = useState<"all" | "T" | "CT">("all");
  const [cat, setCat] = useState("");
  const [player, setPlayer] = useState("");
  const [minConf, setMinConf] = useState<"weak" | "moderate" | "strong">("weak");
  const mapDef = getMapDef(map) ?? null;
  const R = data.report;
  const rank = { weak: 0, moderate: 1, strong: 2 };
  const shown = useMemo(() => R.patterns.filter((p) =>
    (side === "all" || p.side === side || p.side === "both") && (!cat || p.category === cat) && (!player || p.player === player)
    && rank[p.confidence] >= rank[minConf]), [R, side, cat, player, minConf]); // eslint-disable-line react-hooks/exhaustive-deps
  const cats = CATEGORIES.filter((c) => R.patterns.some((p) => p.category === c.id));
  const players = [...new Set(R.patterns.map((p) => p.player).filter((x): x is string => !!x))].sort();

  return (
    <>
      <div className="as-kpis">
        <div className="card as-kpi"><strong>{R.demos}</strong><span className="faint">demos scanned{data.pending ? ` (+${data.pending} loading…)` : ""}</span></div>
        <div className="card as-kpi"><strong>{R.rounds.T}</strong><span className="faint">T rounds</span></div>
        <div className="card as-kpi"><strong>{R.rounds.CT}</strong><span className="faint">CT rounds</span></div>
        <div className="card as-kpi"><strong>{R.patterns.length}</strong><span className="faint">patterns · {R.patterns.filter((p) => p.confidence === "strong").length} strong</span></div>
      </div>
      {data.ai ? <AiBrief name={name} map={map} ids={ids} space={space} teamId={teamId} disabled={!!data.pending || !R.patterns.length} /> : null}
      <div className="ins-controls" style={{ margin: "12px 0" }}>
        <div className="ins-group" role="group" aria-label="Side">
          {(["all", "T", "CT"] as const).map((s) => <button key={s} type="button" className="chip" aria-pressed={side === s} onClick={() => setSide(s)}>{s === "all" ? "Both sides" : s}</button>)}
        </div>
        <select className="select" aria-label="Pattern type" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All pattern types</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select className="select" aria-label="Player" value={player} onChange={(e) => setPlayer(e.target.value)}>
          <option value="">All players</option>
          {players.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="select" aria-label="Confidence" value={minConf} onChange={(e) => setMinConf(e.target.value as typeof minConf)}>
          <option value="weak">Any confidence</option>
          <option value="moderate">Moderate or strong</option>
          <option value="strong">Strong only</option>
        </select>
      </div>
      {!R.patterns.length && !data.pending ? <div className="empty">No repeatable patterns yet. Patterns need at least 3 rounds of the same habit; add more demos of {name} on {mapName(map)}.</div> : null}
      <div className="as-list">
        {shown.map((p) => (
          <article key={p.id} className="card as-card">
            {mapDef && p.spot ? <MiniRadar map={mapDef} x={p.spot.x} y={p.spot.y} z={p.spot.z} side={p.side} /> : <div className="as-noradar" aria-hidden="true">{catLabel(p.category).slice(0, 1)}</div>}
            <div className="as-body">
              <div className="as-meta">
                <span className="badge">{catLabel(p.category)}</span>
                {p.side !== "both" ? <span className={`badge ${p.side === "CT" ? "as-ct" : "as-t"}`}>{p.side}</span> : null}
                <span className={`badge ${CONF[p.confidence]}`}>{p.confidence}</span>
              </div>
              <h3 className="as-title">{p.title}</h3>
              <div className="as-bar" role="img" aria-label={`${Math.round(p.share * 100)} percent`}><span style={{ width: `${Math.round(p.share * 100)}%` }} /></div>
              <p className="faint as-detail">{p.detail}</p>
              <p className="as-counter"><strong>Counter:</strong> {p.counter}</p>
              {p.examples.length ? (
                <p className="as-ex">
                  <span className="faint">Rounds:</span>{" "}
                  {p.examples.map((e) => (
                    <Link key={`${e.replayId}:${e.roundId}`} className="chip" href={`/replays/${e.replayId}?r=${e.roundId}&t=${e.ms}`} title="Watch this round">
                      R{e.roundNumber}{data.list.length > 1 ? ` · ${data.list.find((d) => d.id === e.replayId)?.opponent ?? ""}` : ""}
                    </Link>
                  ))}
                </p>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function MiniRadar({ map, x, y, z, side }: { map: MapDef; x: number; y: number; z: number; side: string }) {
  let floor = 0;
  map.floors.forEach((f, i) => { if (i > 0 && f.zMax !== undefined && z < f.zMax) floor = i; });
  const [px, py] = worldToImage(map, x, y);
  return (
    <div className="as-radar" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/radars/${map.id}${map.floors[floor]?.imageSuffix ?? ""}.png`} alt="" />
      <span className={`as-dot ${side === "CT" ? "as-ct" : side === "T" ? "as-t" : ""}`} style={{ left: `${(100 * px) / map.imageSize}%`, top: `${(100 * py) / map.imageSize}%` }} />
    </div>
  );
}

function AiBrief({ name, map, ids, space, teamId, disabled }: { name: string; map: string; ids: string[] | null; space: string; teamId: string; disabled: boolean }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ brief: Brief }>("/api/antistrat/ai", { method: "POST", json: { name, map, ids, space, ...(teamId ? { teamId } : {}) } });
      setBrief(r.brief);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The AI brief failed.");
    } finally { setBusy(false); }
  };
  const List = ({ title, items }: { title: string; items: string[] }) => items.length ? (
    <><h3 className="st-h2">{title}</h3><ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul></>
  ) : null;
  return (
    <section className="card as-ai" aria-label="AI anti-strat brief">
      <div className="ins-head">
        <h2>AI anti-strat brief</h2>
        <span className="row" style={{ gap: 6 }}>
          {brief ? <button type="button" className="btn btn-sm" onClick={() => window.print()}>Print</button> : null}
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || disabled} onClick={run}>
            {busy ? "Writing the brief…" : brief ? "Write again" : "Write a game plan with AI"}
          </button>
        </span>
      </div>
      {!brief && !busy ? <p className="faint" style={{ fontSize: 12, margin: 0 }}>Sends the pattern numbers above (not your demo files) to Claude, which writes a game plan against {name}. Takes up to a minute.</p> : null}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {brief ? (
        <div className="as-brief">
          <p>{brief.summary}</p>
          <List title="Their T side" items={brief.tSide} />
          <List title="Their CT side" items={brief.ctSide} />
          {brief.players.length ? (<><h3 className="st-h2">Players</h3><ul>{brief.players.map((p) => <li key={p.name}><strong>{p.name}:</strong> {p.notes}</li>)}</ul></>) : null}
          <List title="Game plan" items={brief.gamePlan} />
          <List title="Caveats" items={brief.caveats} />
          <p className="faint" style={{ fontSize: 11 }}>Written by AI from the patterns on this page. Check it against the example rounds.</p>
        </div>
      ) : null}
    </section>
  );
}

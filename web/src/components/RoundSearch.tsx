"use client";
/** Round search across your demos, with automatic round tags. */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { listMaps, mapName } from "@/viewer/maps";
import { api, ApiError } from "./api";
import { SpacePicker, useSpace } from "./StatsHub";

const TAG_LABELS: Record<string, string> = {
  pistol: "Pistol", eco: "Eco", half_buy: "Half buy", full_buy: "Full buy", anti_eco: "Anti-eco",
  fast_plant: "Fast plant", execute: "Execute", late_plant: "Late plant", no_plant: "No plant",
  retake_won: "Retake won", post_plant_won: "Post-plant won", save: "Save", opening_kill: "Opening kill", opening_death: "Opening death",
};
const TAG_GROUPS: [string, string[]][] = [
  ["Economy", ["pistol", "eco", "half_buy", "full_buy", "anti_eco"]],
  ["T-side pace", ["fast_plant", "execute", "late_plant", "no_plant"]],
  ["What happened", ["opening_kill", "opening_death", "retake_won", "post_plant_won", "save"]],
];

interface Result {
  replayId: string; title: string | null; mapId: string | null; when: string; team: string; opponent: string;
  id: string; number: number; side: "CT" | "T"; won: boolean; tags: string[]; plantSite: string | null; plantS: number | null; ms: number;
}

export function RoundSearch() {
  const router = useRouter();
  const params = useSearchParams();
  const { teams, space, teamId, qs } = useSpace();
  const get = (k: string) => params.get(k) ?? "";
  const tags = get("tags").split(",").filter(Boolean);
  const [teamNames, setTeamNames] = useState<string[]>([]);
  const [data, setData] = useState<{ searched: number; pending: number; truncated: boolean; results: Result[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamText, setTeamText] = useState(get("team"));
  const searchKey = `${params.toString()}`;

  const set = (over: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(over)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/stats/rounds?${p}`);
  };
  const toggleTag = (t: string) => set({ tags: (tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]).join(",") });

  useEffect(() => {
    api<{ teams: { name: string }[] }>(`/api/stats?${qs}`).then((r) => setTeamNames(r.teams.map((t) => t.name))).catch(() => {});
  }, [qs]);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/rounds/search?${searchKey}`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/stats/rounds");
      else setError(e instanceof Error ? e.message : "Search failed.");
    }
  }, [searchKey, router]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!data?.pending) return;
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [data, load]);

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <p className="ms-eyebrow"><Link href={`/stats?${qs}`}>Stats</Link> · Round search</p>
      <div className="ms-head">
        <h1 style={{ margin: 0 }}>Find rounds</h1>
        <SpacePicker teams={teams} space={space} teamId={teamId} onChange={(s, id) => set({ space: s, teamId: id })} />
      </div>
      <p className="page-sub">Every round in your demos is tagged automatically. Combine filters, then open any round straight in the replay.</p>

      <div className="rs-filters">
        <label className="field">
          <span>Map</span>
          <select className="select" value={get("map")} onChange={(e) => set({ map: e.target.value })}>
            <option value="">Any map</option>
            {listMaps().map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </label>
        <form className="field" onSubmit={(e) => { e.preventDefault(); set({ team: teamText.trim() }); }}>
          <label htmlFor="rs-team">Team (in-game name)</label>
          <div className="row">
            <input id="rs-team" className="input" list="rs-team-names" value={teamText} placeholder="Any team" onChange={(e) => setTeamText(e.target.value)} onBlur={() => set({ team: teamText.trim() })} />
            <datalist id="rs-team-names">{teamNames.map((n) => <option key={n} value={n} />)}</datalist>
          </div>
        </form>
        <label className="field">
          <span>Side</span>
          <select className="select" value={get("side")} onChange={(e) => set({ side: e.target.value })}>
            <option value="">Either</option><option value="CT">CT</option><option value="T">T</option>
          </select>
        </label>
        <label className="field">
          <span>Result</span>
          <select className="select" value={get("result")} onChange={(e) => set({ result: e.target.value })}>
            <option value="">Won or lost</option><option value="won">Won</option><option value="lost">Lost</option>
          </select>
        </label>
        <label className="field">
          <span>Bomb site</span>
          <select className="select" value={get("site")} onChange={(e) => set({ site: e.target.value })}>
            <option value="">Any</option><option value="A">A</option><option value="B">B</option>
          </select>
        </label>
      </div>
      <div className="rs-tags">
        {TAG_GROUPS.map(([label, list]) => (
          <div key={label} className="ins-group" role="group" aria-label={label}>
            <span className="faint" style={{ fontSize: 12, marginRight: 4 }}>{label}</span>
            {list.map((t) => <button key={t} type="button" className="chip" aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>{TAG_LABELS[t]}</button>)}
          </div>
        ))}
      </div>

      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {data ? (
        <p className="faint" style={{ fontSize: 13 }}>
          {data.results.length}{data.truncated ? "+" : ""} rounds in {data.searched} demos{data.pending ? `, searching ${data.pending} more…` : ""}
        </p>
      ) : <p className="muted">Searching…</p>}

      {data && data.results.length ? (
        <div className="ms-table-wrap">
          <div className="ms-scroll">
            <table className="ms-table rs-table">
              <thead><tr><th className="ms-name">Match</th><th>Map</th><th>Round</th><th>Side</th><th>Result</th><th className="ms-name">Tags</th><th /></tr></thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={`${r.replayId}-${r.id}-${r.team}`}>
                    <th scope="row" className="ms-name">
                      <strong>{r.team}</strong> <span className="faint">vs {r.opponent}</span>
                      <div className="faint" style={{ fontSize: 11, fontWeight: 400 }}>{new Date(r.when).toLocaleDateString()}{r.title ? ` · ${r.title}` : ""}</div>
                    </th>
                    <td>{mapName(r.mapId)}</td>
                    <td className="mono">{r.number}</td>
                    <td><span className={`side side-${r.side}`}>{r.side}</span></td>
                    <td className={r.won ? "ms-pos" : "ms-neg"}>{r.won ? "Won" : "Lost"}</td>
                    <td className="ms-name rs-tagcell">
                      {r.tags.map((t) => <span key={t} className="badge">{TAG_LABELS[t] ?? t}</span>)}
                      {r.plantSite ? <span className="badge">{r.plantSite} plant{r.plantS !== null ? ` ${Math.floor(r.plantS / 60)}:${String(r.plantS % 60).padStart(2, "0")}` : ""}</span> : null}
                    </td>
                    <td><Link className="btn btn-sm" href={`/replays/${r.replayId}?r=${r.id}&t=${r.ms}`}>Watch</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : data && !data.pending ? <div className="empty">No rounds match these filters.</div> : null}
    </div>
  );
}

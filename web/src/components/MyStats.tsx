"use client";
/** Your own stats across all demos you can open, matched by your linked Steam accounts. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { mapName } from "@/viewer/maps";
import { api, ApiError } from "./api";

interface Derived { kd: number; diff: number; adr: number | null; kastPct: number; hsPct: number; kpr: number; dpr: number; openingPct: number | null; rating: number }
interface Match { replayId: string; mapId: string | null; when: string; team: string; opponent: string; score: number; oppScore: number; k: number; d: number; adr: number | null; rating: number }
interface Resp {
  linked: string[]; maps: number; pending: number;
  overall?: (Derived & { rounds: number; k: number; d: number; a: number; clutches: string; multi3: number; ud: number; ef: number }) | null;
  byMap?: (Derived & { mapId: string; maps: number; wins: number; k: number; d: number })[];
  matches?: Match[];
  bests?: { kills: Match | null; rating: Match | null; adr: Match | null };
}

export function MyStats() {
  const router = useRouter();
  const [d, setD] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const load = useCallback(async () => {
    try {
      setD(await api<Resp>("/api/stats/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/stats/me");
      else setError(e instanceof Error ? e.message : "Could not load your stats.");
    }
  }, [router]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!d?.pending) return;
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [d, load]);

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/me/steam", { method: "POST", json: { steam: input } });
      setInput("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link the account.");
    }
  }
  async function unlink(id: string) {
    await api(`/api/me/steam?steamId=${id}`, { method: "DELETE" });
    load();
  }

  const o = d?.overall;
  const best = (label: string, m: Match | null | undefined, v: (m: Match) => string) => (
    <div className="card st-kpi">
      <span className="faint">{label}</span>
      {m ? (
        <>
          <strong className="mono">{v(m)}</strong>
          <Link className="faint" style={{ fontSize: 12 }} href={`/replays/${m.replayId}/stats`}>vs {m.opponent} · {mapName(m.mapId)}</Link>
        </>
      ) : <strong className="mono">—</strong>}
    </div>
  );
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <p className="ms-eyebrow"><Link href="/stats">Stats</Link> · My stats</p>
      <h1>My stats</h1>
      <p className="page-sub">Your numbers across every demo you can open, whichever team you played for. Link the Steam account(s) you play on.</p>

      <section className="card stack" aria-label="Linked Steam accounts" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 14 }}>Steam accounts</strong>
        <div className="row wrap">
          {d?.linked.map((id) => (
            <span key={id} className="badge" style={{ gap: 6 }}>
              <span className="mono">{id}</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ height: 18, padding: "0 4px" }} aria-label={`Unlink ${id}`} onClick={() => unlink(id)}>×</button>
            </span>
          ))}
          {d && !d.linked.length ? <span className="faint" style={{ fontSize: 13 }}>None linked yet.</span> : null}
        </div>
        <form className="row wrap" onSubmit={link}>
          <label className="sr-only" htmlFor="steam-input">SteamID64 or profile link</label>
          <input id="steam-input" className="input grow" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="7656119… or https://steamcommunity.com/profiles/7656119…" style={{ maxWidth: 460 }} />
          <button className="btn" disabled={!input.trim()}>Link account</button>
        </form>
        <span className="faint" style={{ fontSize: 12 }}>Your SteamID64 is on your Steam profile page (or in a /profiles/ link). This is not verified; it only decides which player is you.</span>
      </section>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}

      {d && d.linked.length && !o ? (
        <div className="empty">{d.pending ? "Looking through your demos…" : "None of your demos with player stats include these Steam accounts yet."}</div>
      ) : null}
      {o ? (
        <>
          <div className="st-kpis">
            <div className="card st-kpi"><span className="faint">Rating 1.0</span><strong className="mono">{o.rating.toFixed(2)}</strong><span className="faint mono" style={{ fontSize: 12 }}>{d!.maps} maps · {o.rounds} rounds</span></div>
            <div className="card st-kpi"><span className="faint">K / D</span><strong className="mono">{o.kd.toFixed(2)}</strong><span className="faint mono" style={{ fontSize: 12 }}>{o.k}–{o.d}</span></div>
            <div className="card st-kpi"><span className="faint">ADR</span><strong className="mono">{o.adr === null ? "—" : o.adr.toFixed(1)}</strong><span className="faint mono" style={{ fontSize: 12 }}>KAST {o.kastPct.toFixed(0)}%</span></div>
            <div className="card st-kpi"><span className="faint">Headshots</span><strong className="mono">{o.hsPct.toFixed(0)}%</strong><span className="faint mono" style={{ fontSize: 12 }}>{o.kpr.toFixed(2)} kills/round</span></div>
            <div className="card st-kpi"><span className="faint">Opening duels</span><strong className="mono">{o.openingPct === null ? "—" : `${o.openingPct.toFixed(0)}%`}</strong><span className="faint mono" style={{ fontSize: 12 }}>clutches {o.clutches}</span></div>
            <div className="card st-kpi"><span className="faint">3K+ rounds</span><strong className="mono">{o.multi3}</strong><span className="faint mono" style={{ fontSize: 12 }}>UD {o.ud} · flashed {o.ef}</span></div>
          </div>

          <h2 className="st-h2">Personal bests</h2>
          <div className="st-kpis">
            {best("Most kills in a map", d!.bests?.kills, (m) => `${m.k} kills`)}
            {best("Best rating", d!.bests?.rating, (m) => m.rating.toFixed(2))}
            {best("Best ADR", d!.bests?.adr, (m) => (m.adr ?? 0).toFixed(1))}
          </div>

          <section className="ms-table-wrap" aria-label="By map">
            <h2 className="ms-table-title">By map</h2>
            <div className="ms-scroll">
              <table className="ms-table">
                <thead><tr><th className="ms-name">Map</th><th>Maps</th><th>Won</th><th>K–D</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Rating 1.0</th></tr></thead>
                <tbody>
                  {d!.byMap!.map((m) => (
                    <tr key={m.mapId}>
                      <th scope="row" className="ms-name">{mapName(m.mapId)}</th><td>{m.maps}</td><td>{m.wins}</td><td>{m.k}–{m.d}</td>
                      <td>{m.adr === null ? "—" : m.adr.toFixed(1)}</td><td>{m.kastPct.toFixed(0)}%</td><td>{m.hsPct.toFixed(0)}%</td>
                      <td className="ms-rating" data-good={m.rating >= 1.1} data-bad={m.rating < 0.9}>{m.rating.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-label="Recent maps">
            <h2 className="st-h2">Recent maps</h2>
            <ol className="st-list">
              {d!.matches!.map((m) => (
                <li key={m.replayId}>
                  <Link href={`/replays/${m.replayId}/stats`} className="st-match">
                    <span className={`st-result st-${m.score > m.oppScore ? "W" : m.score < m.oppScore ? "L" : "D"}`}>{m.score > m.oppScore ? "W" : m.score < m.oppScore ? "L" : "D"}</span>
                    <span className="grow">{m.team} vs <strong>{m.opponent}</strong> <span className="faint">· {mapName(m.mapId)}</span></span>
                    <span className="mono">{m.k}–{m.d}</span>
                    <span className="mono ms-rating" data-good={m.rating >= 1.1} data-bad={m.rating < 0.9}>{m.rating.toFixed(2)}</span>
                    <span className="faint" style={{ fontSize: 12 }}>{new Date(m.when).toLocaleDateString()}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </div>
  );
}

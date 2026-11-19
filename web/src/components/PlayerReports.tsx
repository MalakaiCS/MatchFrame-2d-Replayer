"use client";
/**
 * Per-player anti-strat reports. Your team's players and the area each plays are worked out from your
 * own demos (CT at 0:15, T at 0:20) and can be edited; then each player gets a report on what the
 * opponent does in that area: how often they come, through where, who, with what utility, how the
 * fights go, how they hold it on CT. Printable one per page, with an optional AI sheet per player.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getMapDef, type MapDef, mapName, worldToImage } from "@/viewer/maps";
import { api } from "./api";

interface TeamItem { key: string; name: string; demos: number; maps: string[] }
interface Line { text: string; share?: number; n?: number; of?: number }
interface Mark { x: number; y: number; z: number; kind: string }
interface Example { replayId: string; roundId: string; roundNumber: number; ms: number }
export interface AreaReport { side: "CT" | "T"; area: string[]; rounds: number; headline: string; sections: { title: string; lines: Line[] }[]; tips: string[]; marks: Mark[]; examples: Example[] }
interface Row { name: string; role: { CT?: string; T?: string }; CT: string[]; T: string[] }
interface Report { name: string; role: { CT?: string; T?: string }; CT: AreaReport | null; T: AreaReport | null }
interface PlayerBrief { summary: string; ctSide: string[]; tSide: string[]; watchFor: string[]; caveats: string[] }

const SPECIAL: Record<string, string> = {
  CTSpawn: "CT spawn", TSpawn: "T spawn", TopofMid: "Top of mid", BombsiteA: "A site", BombsiteB: "B site", BombsiteC: "C site", SnipersNest: "Sniper's nest",
};
export function prettyPlace(p: string) {
  if (SPECIAL[p]) return SPECIAL[p];
  if (p.includes(" ")) return p;
  const s = p.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z])of([A-Z ])/g, "$1 of$2");
  return s.charAt(0) + s.slice(1).toLowerCase();
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function PlayerReports({ opponent, map, teams, qsKey, space, teamId, ai }: {
  opponent: string; map: string; teams: TeamItem[]; qsKey: string; space: string; teamId: string; ai: boolean;
}) {
  const mine = teams.filter((t) => t.name.toLowerCase() !== opponent.toLowerCase());
  const [yourTeam, setYourTeam] = useState<string>(() => store.get("mf-antistrat-yourteam") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [callouts, setCallouts] = useState<string[]>([]);
  const [rosterNote, setRosterNote] = useState("");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const editKey = `mf-antistrat-roster:${yourTeam}|${map}`;

  // Default "your team": the remembered one, else the team with the most demos that isn't the opponent.
  useEffect(() => {
    if (yourTeam && (yourTeam === "__manual" || mine.some((t) => t.name === yourTeam))) return;
    const best = [...mine].sort((a, b) => b.demos - a.demos)[0];
    setYourTeam(best ? best.name : "__manual");
  }, [mine, yourTeam]);

  // Callouts of the opponent's demos on this map (for the area pickers).
  useEffect(() => {
    api<{ callouts: string[] }>(`/api/antistrat?${new URLSearchParams({ name: opponent, map })}&${qsKey}`)
      .then((r) => setCallouts((c) => [...new Set([...c, ...r.callouts])])).catch(() => {});
  }, [opponent, map, qsKey]);

  // Roster: saved edits, else worked out from your demos.
  useEffect(() => {
    if (!yourTeam) return;
    setReports(null);
    const saved = store.get(editKey);
    if (saved) { try { setRows(JSON.parse(saved)); setRosterNote("Your saved roster."); return; } catch { /* ignore */ } }
    if (yourTeam === "__manual") { setRows([0, 1, 2, 3, 4].map((i) => ({ name: `Player ${i + 1}`, role: {}, CT: [], T: [] }))); setRosterNote("Type your players and pick the callouts each one plays."); return; }
    setRows(null);
    let stop = false;
    const load = () => api<{ demos: number; pending: number; players: { name: string; CT: { area: string[]; role: string }; T: { area: string[]; role: string } }[]; callouts: string[] }>(
      `/api/antistrat/roster?${new URLSearchParams({ name: yourTeam, map })}&${qsKey}`,
    ).then((r) => {
      if (stop) return;
      if (r.pending) { setTimeout(load, 600); return; }
      setCallouts((c) => [...new Set([...r.callouts, ...c])]);
      if (!r.players.length) {
        setRows([0, 1, 2, 3, 4].map((i) => ({ name: `Player ${i + 1}`, role: {}, CT: [], T: [] })));
        setRosterNote(`No demos of ${yourTeam} on ${mapName(map)} yet: type your players and pick their callouts.`);
        return;
      }
      setRows(r.players.slice(0, 7).map((p) => ({ name: p.name, role: { CT: p.CT.role, T: p.T.role }, CT: p.CT.area, T: p.T.area })));
      setRosterNote(`Worked out from ${r.demos} demo${r.demos === 1 ? "" : "s"} of ${yourTeam} on ${mapName(map)}. Edit anything; changes are remembered in this browser.`);
    }).catch((e) => { if (!stop) setError(e instanceof Error ? e.message : "Could not load your roster."); });
    load();
    return () => { stop = true; };
  }, [yourTeam, map, qsKey, editKey, reload]);

  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => {
      const next = rs!.map((r, j) => (j === i ? { ...r, ...patch } : r));
      store.set(editKey, JSON.stringify(next));
      return next;
    });
  };

  const generate = async () => {
    if (!rows) return;
    setBusy(true); setError(null);
    try {
      const players = rows.filter((r) => r.name.trim() && (r.CT.length || r.T.length));
      if (!players.length) throw new Error("Give at least one player an area.");
      for (let attempt = 0; ; attempt++) {
        const r = await api<{ pending: number; reports: Report[] }>("/api/antistrat/reports", {
          method: "POST", json: { opponent, map, space, ...(teamId ? { teamId } : {}), players },
        });
        if (!r.pending || attempt > 20) { setReports(r.reports); break; }
        await new Promise((res) => setTimeout(res, 600));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the reports.");
    } finally { setBusy(false); }
  };

  const mapDef = getMapDef(map) ?? null;
  return (
    <>
      <section className="card no-print" aria-label="Your players" style={{ marginBottom: 16 }}>
        <div className="ins-head">
          <h2>Your players and their areas</h2>
          <label className="row" style={{ fontSize: 13 }}>
            <span className="faint">Your team</span>
            <select className="select" aria-label="Your team" value={yourTeam} onChange={(e) => { setYourTeam(e.target.value); store.set("mf-antistrat-yourteam", e.target.value); }}>
              {mine.map((t) => <option key={t.key} value={t.name}>{t.name}</option>)}
              <option value="__manual">Enter players by hand</option>
            </select>
          </label>
        </div>
        {rosterNote ? <p className="faint" style={{ fontSize: 12, marginTop: 0 }}>{rosterNote}</p> : null}
        {!rows ? <p className="muted">Working out where your players play…</p> : (
          <div className="ms-table-wrap">
            <table className="ms-table pr-roster as-table">
              <thead><tr><th scope="col">Player</th><th scope="col">CT role and area</th><th scope="col">T role and fight area</th><th scope="col" /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><input className="input" aria-label={`Player ${i + 1} name`} value={r.name} onChange={(e) => update(i, { name: e.target.value.slice(0, 40) })} style={{ maxWidth: 150 }} /></td>
                    {(["CT", "T"] as const).map((side) => (
                      <td key={side}>
                        <input className="input pr-role" aria-label={`${r.name} ${side} role`} placeholder={side === "CT" ? "e.g. B anchor" : "e.g. B entry"} value={r.role[side] ?? ""}
                          onChange={(e) => update(i, { role: { ...r.role, [side]: e.target.value.slice(0, 60) } })} />
                        <AreaPicker value={r[side]} options={callouts} label={`${r.name} ${side} area`} onChange={(v) => update(i, { [side]: v } as Partial<Row>)} />
                      </td>
                    ))}
                    <td><button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${r.name}`} onClick={() => setRows((rs) => { const n = rs!.filter((_, j) => j !== i); store.set(editKey, JSON.stringify(n)); return n; })}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm" disabled={!rows || rows.length >= 10} onClick={() => setRows((rs) => [...(rs ?? []), { name: `Player ${(rs?.length ?? 0) + 1}`, role: {}, CT: [], T: [] }])}>+ Player</button>
          {store.get(editKey) ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => { try { localStorage.removeItem(editKey); } catch { /* ignore */ } setReload((n) => n + 1); }}>Reset to detected</button> : null}
          <button type="button" className="btn btn-primary" disabled={!rows || busy} onClick={generate}>{busy ? "Building reports…" : `Generate reports vs ${opponent}`}</button>
          {reports ? <button type="button" className="btn" onClick={() => window.print()}>Print all</button> : null}
        </div>
        {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      </section>
      {reports?.map((r) => (
        <PlayerCard key={r.name} report={r} map={mapDef} opponent={opponent} mapId={map} ai={ai} space={space} teamId={teamId} row={rows?.find((x) => x.name === r.name) ?? null} />
      ))}
    </>
  );
}

function AreaPicker({ value, options, label, onChange }: { value: string[]; options: string[]; label: string; onChange: (v: string[]) => void }) {
  const rest = options.filter((o) => !value.includes(o));
  return (
    <div className="pr-area" role="group" aria-label={label}>
      {value.map((c) => (
        <button key={c} type="button" className="chip" aria-pressed="true" title="Remove" onClick={() => onChange(value.filter((x) => x !== c))}>{prettyPlace(c)} ✕</button>
      ))}
      {value.length < 8 && rest.length ? (
        <select className="select pr-add" aria-label={`Add a callout to ${label}`} value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}>
          <option value="">+ callout</option>
          {rest.map((c) => <option key={c} value={c}>{prettyPlace(c)}</option>)}
        </select>
      ) : null}
    </div>
  );
}

function PlayerCard({ report, map, opponent, mapId, ai, space, teamId, row }: {
  report: Report; map: MapDef | null; opponent: string; mapId: string; ai: boolean; space: string; teamId: string; row: Row | null;
}) {
  const [brief, setBrief] = useState<PlayerBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const printOne = () => {
    ref.current?.classList.add("print-target");
    document.body.classList.add("print-one");
    const done = () => { document.body.classList.remove("print-one"); ref.current?.classList.remove("print-target"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  };
  const runAi = async () => {
    if (!row) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ brief: PlayerBrief }>("/api/antistrat/ai/player", { method: "POST", json: { opponent, map: mapId, space, ...(teamId ? { teamId } : {}), players: [row] } });
      setBrief(r.brief);
    } catch (e) { setError(e instanceof Error ? e.message : "The AI sheet failed."); } finally { setBusy(false); }
  };
  const roles = [report.role.CT ? `CT: ${report.role.CT}` : null, report.role.T ? `T: ${report.role.T}` : null].filter(Boolean).join(" · ");
  return (
    <article ref={ref} className="card pr-card" aria-label={`Report for ${report.name}`}>
      <div className="ins-head">
        <div>
          <p className="ms-eyebrow" style={{ margin: 0 }}>Anti-strat vs {opponent} · {mapName(mapId)}</p>
          <h2 style={{ margin: "2px 0 0" }}>{report.name}{roles ? <span className="faint" style={{ fontWeight: 400, fontSize: 14 }}> · {roles}</span> : null}</h2>
        </div>
        <span className="row no-print" style={{ gap: 6 }}>
          {ai ? <button type="button" className="btn btn-sm btn-primary" disabled={busy || !row} onClick={runAi}>{busy ? "Writing…" : brief ? "Rewrite with AI" : "AI sheet"}</button> : null}
          <button type="button" className="btn btn-sm" onClick={printOne}>Print</button>
        </span>
      </div>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {brief ? (
        <div className="pr-brief">
          <p><strong>{brief.summary}</strong></p>
          {([["On CT", brief.ctSide], ["On T", brief.tSide], ["Watch for", brief.watchFor], ["Caveats", brief.caveats]] as const).map(([t, items]) => items.length ? (
            <div key={t}><h3 className="st-h2">{t}</h3><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          ) : null)}
          <p className="faint" style={{ fontSize: 11 }}>Written by AI from the numbers below.</p>
        </div>
      ) : null}
      <div className="pr-sides">
        {([report.CT, report.T] as const).map((rep, i) => rep ? <SideReport key={i} rep={rep} map={map} /> : null)}
      </div>
    </article>
  );
}

function SideReport({ rep, map }: { rep: AreaReport; map: MapDef | null }) {
  return (
    <section className="pr-side" aria-label={`${rep.side} side`}>
      <h3 className="pr-side-h"><span className={`badge ${rep.side === "CT" ? "as-ct" : "as-t"}`}>Your {rep.side}</span> {rep.area.map(prettyPlace).join(" / ")}</h3>
      <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>{rep.headline}</p>
      {map ? <AreaMap map={map} marks={rep.marks} side={rep.side} /> : null}
      {rep.tips.length ? (
        <div className="pr-tips"><strong>What to do</strong><ul>{rep.tips.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
      ) : null}
      {rep.sections.map((s) => (
        <div key={s.title} className="pr-sec">
          <h4>{s.title}</h4>
          {s.lines.map((l, i) => (
            <div key={i} className="pr-line">
              <span>{l.text}</span>
              {l.share !== undefined ? <span className="as-bar pr-bar" role="img" aria-label={`${Math.round(l.share * 100)} percent`}><span style={{ width: `${Math.round(l.share * 100)}%` }} /></span> : null}
            </div>
          ))}
        </div>
      ))}
      {rep.examples.length ? (
        <p className="as-ex no-print"><span className="faint">Watch:</span>{" "}
          {rep.examples.map((e) => <Link key={`${e.replayId}:${e.roundId}`} className="chip" href={`/replays/${e.replayId}?r=${e.roundId}&t=${e.ms}`}>R{e.roundNumber}</Link>)}
        </p>
      ) : null}
    </section>
  );
}

const MARK_COLOR: Record<string, string> = {
  enemy: "#ef6b6b", smoke: "#dfe6ee", flash: "#fff27a", molotov: "#ff7a45", he: "#7fd18b", kill: "#ff9f43", death: "#9aa4b2",
};

/** Radar with your area shaded, their players (red), their utility and the fights. */
function AreaMap({ map, marks, side }: { map: MapDef; marks: Mark[]; side: "CT" | "T" }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The floor where most of the area is.
  const floor = useMemo(() => {
    if (map.floors.length < 2) return 0;
    const of = (z: number) => { let f = 0; map.floors.forEach((fl, i) => { if (i > 0 && fl.zMax !== undefined && z < fl.zMax) f = i; }); return f; };
    const n = new Map<number, number>();
    for (const m of marks) if (m.kind === "area") n.set(of(m.z), (n.get(of(m.z)) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  }, [map, marks]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const img = new Image();
    img.onload = () => {
      const S = c.clientWidth || 320;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = S * dpr; c.height = S * dpr;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#080b0f"; ctx.fillRect(0, 0, S, S);
      ctx.filter = "grayscale(0.7) brightness(0.6)"; ctx.drawImage(img, 0, 0, S, S); ctx.filter = "none";
      const k = S / map.imageSize;
      const onFloor = (z: number) => {
        if (map.floors.length < 2) return true;
        let f = 0; map.floors.forEach((fl, i) => { if (i > 0 && fl.zMax !== undefined && z < fl.zMax) f = i; });
        return f === floor;
      };
      const xy = (m: Mark) => { const [px, py] = worldToImage(map, m.x, m.y); return [px * k, py * k]; };
      const area = side === "CT" ? "rgba(56,198,232,0.13)" : "rgba(242,169,59,0.13)";
      for (const m of marks) {
        if (!onFloor(m.z)) continue;
        const [x, y] = xy(m);
        if (m.kind === "area") { ctx.fillStyle = area; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); continue; }
        ctx.fillStyle = MARK_COLOR[m.kind] ?? "#fff";
        ctx.globalAlpha = m.kind === "enemy" ? 0.75 : 0.9;
        ctx.beginPath();
        if (m.kind === "kill" || m.kind === "death") { ctx.fillRect(x - 2, y - 2, 4, 4); }
        else { ctx.arc(x, y, m.kind === "enemy" ? 3 : 3.5, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
    };
    img.src = `/radars/${map.id}${map.floors[floor]?.imageSuffix ?? ""}.png`;
  }, [map, marks, side, floor]);
  return (
    <figure className="pr-map">
      <canvas ref={ref} className="pr-canvas" aria-label="Map of your area with their positions, utility and fights" role="img" />
      <figcaption className="pr-legend">
        <span><i style={{ background: side === "CT" ? "rgba(56,198,232,0.6)" : "rgba(242,169,59,0.6)" }} />Your area</span>
        <span><i style={{ background: MARK_COLOR.enemy }} />Their players</span>
        <span><i style={{ background: MARK_COLOR.smoke }} />Smoke</span>
        <span><i style={{ background: MARK_COLOR.flash }} />Flash</span>
        <span><i style={{ background: MARK_COLOR.molotov }} />Molotov</span>
        <span><i style={{ background: MARK_COLOR.kill, borderRadius: 0 }} />Their kills</span>
        <span><i style={{ background: MARK_COLOR.death, borderRadius: 0 }} />Their deaths</span>
      </figcaption>
    </figure>
  );
}

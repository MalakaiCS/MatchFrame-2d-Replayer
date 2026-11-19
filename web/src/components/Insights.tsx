"use client";
/**
 * Heatmaps (positions, kills, deaths) and the grenade lineup library, drawn on the map's radar.
 * Used on the match page (one replay) and the team overview (one team across demos of a map).
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GrenadeType } from "@/shared/contract";
import { getMapDef, type MapDef, mapName, worldToImage } from "@/viewer/maps";
import { api } from "./api";

type Layer = "pos" | "kills" | "deaths" | "nades";
interface Point { x: number; y: number; z: number }
interface Nade {
  type: GrenadeType; ox: number; oy: number; oz: number; lx: number; ly: number; lz: number;
  replayId: string; roundId: string; roundNumber: number; ms: number; won: boolean; player: string; side: "CT" | "T";
}
interface Resp { mapId: string; demos: number; pending: number; players: { key: string; name: string }[]; points: Point[]; nades: Nade[] }

export type InsightsSource =
  | { kind: "replay"; replayId: string; teams: { A: string; B: string }; shareHash?: string }
  | { kind: "team"; name: string; map: string; spaceQs: string };

const LAYERS: { id: Layer; label: string }[] = [
  { id: "pos", label: "Positions" }, { id: "kills", label: "Kills" }, { id: "deaths", label: "Deaths" }, { id: "nades", label: "Utility" },
];
const TIMES = [
  { id: "all", label: "Whole round", from: 0, to: 10_000 },
  { id: "setup", label: "0–20 s", from: 0, to: 20 },
  { id: "mid", label: "20–50 s", from: 20, to: 50 },
  { id: "late", label: "50 s +", from: 50, to: 10_000 },
];
const NADES: { id: GrenadeType; label: string; color: string }[] = [
  { id: "smoke", label: "Smokes", color: "#dfe6ee" },
  { id: "flash", label: "Flashes", color: "#fff27a" },
  { id: "molotov", label: "Molotovs", color: "#ff7a45" },
  { id: "incendiary", label: "Incendiaries", color: "#ff5d73" },
  { id: "he", label: "HEs", color: "#7fd18b" },
];
const nadeColor = (t: GrenadeType) => NADES.find((n) => n.id === t)?.color ?? "#999";
/** Landing spots closer than this (world units) are grouped as one lineup. */
const CLUSTER = 160;

function floorOf(map: MapDef, z: number) {
  let idx = 0;
  map.floors.forEach((f, i) => { if (i > 0 && f.zMax !== undefined && z < f.zMax) idx = i; });
  return idx;
}

/** Heat palette: transparent -> blue -> green -> yellow -> red. */
function palette(a: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [[0, [40, 90, 255]], [0.35, [40, 220, 180]], [0.6, [250, 230, 60]], [1, [255, 60, 40]]];
  for (let i = 1; i < stops.length; i++) {
    if (a <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      const t = (a - p0) / (p1 - p0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}

export function InsightsPanel({ source }: { source: InsightsSource }) {
  const [team, setTeam] = useState<"A" | "B">("A");
  const [layer, setLayer] = useState<Layer>("pos");
  const [side, setSide] = useState<"all" | "CT" | "T">("all");
  const [time, setTime] = useState("all");
  const [player, setPlayer] = useState("");
  const [nadeType, setNadeType] = useState<GrenadeType | "">("smoke");
  const [weapon, setWeapon] = useState("");
  const [rounds, setRounds] = useState("");
  const [floor, setFloor] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const t = TIMES.find((x) => x.id === time)!;
  const qs = useMemo(() => {
    const p = new URLSearchParams({ layer, side, from: String(t.from), to: String(t.to), ...(player ? { player } : {}), ...(layer === "nades" && nadeType ? { type: nadeType } : {}),
      ...((layer === "kills" || layer === "deaths") && weapon ? { weapon } : {}), ...(rounds ? { rounds } : {}) });
    if (source.kind === "replay") { p.set("replay", source.replayId); p.set("team", team); return p.toString(); }
    p.set("name", source.name); p.set("map", source.map);
    return `${p}&${source.spaceQs}`;
  }, [layer, side, t, player, nadeType, weapon, rounds, source, team]);

  useEffect(() => {
    let cancelled = false;
    setSelected(null);
    api<Resp>(`/api/insights?${qs}`).then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the heatmap."); });
    return () => { cancelled = true; };
  }, [qs, retry]);
  // Insights for big libraries are built a few demos at a time.
  useEffect(() => {
    if (!data?.pending) return;
    const h = setTimeout(() => setRetry((n) => n + 1), 400);
    return () => clearTimeout(h);
  }, [data]);

  const map = getMapDef(data?.mapId ?? (source.kind === "team" ? source.map : "")) ?? null;

  const clusters = useMemo(() => {
    if (!data || layer !== "nades" || !map) return [];
    const groups: { key: string; type: GrenadeType; lx: number; ly: number; items: Nade[] }[] = [];
    for (const n of data.nades) {
      if (map.floors.length > 1 && floorOf(map, n.lz) !== floor) continue;
      const g = groups.find((x) => x.type === n.type && Math.hypot(x.lx - n.lx, x.ly - n.ly) < CLUSTER);
      if (g) {
        g.items.push(n);
        g.lx += (n.lx - g.lx) / g.items.length;
        g.ly += (n.ly - g.ly) / g.items.length;
      } else groups.push({ key: `${n.type}:${n.lx}:${n.ly}`, type: n.type, lx: n.lx, ly: n.ly, items: [n] });
    }
    return groups.sort((a, b) => b.items.length - a.items.length);
  }, [data, layer, map, floor]);

  return (
    <section className="card ins" aria-label="Heatmaps and utility">
      <div className="ins-head">
        <h2>Heatmaps &amp; utility{source.kind === "team" ? ` · ${mapName(source.map)}` : ""}</h2>
        {data ? <span className="faint" style={{ fontSize: 12 }}>{data.demos} demo{data.demos === 1 ? "" : "s"}{data.pending ? `, adding ${data.pending} more…` : ""}</span> : null}
      </div>
      <div className="ins-controls">
        {source.kind === "replay" ? (
          <div className="ins-group" role="group" aria-label="Team">
            {(["A", "B"] as const).map((k) => (
              <button key={k} type="button" className="chip" aria-pressed={team === k} onClick={() => { setTeam(k); setPlayer(""); }}>{source.teams[k]}</button>
            ))}
          </div>
        ) : null}
        <div className="ins-group" role="group" aria-label="Layer">
          {LAYERS.map((l) => <button key={l.id} type="button" className="chip" aria-pressed={layer === l.id} onClick={() => setLayer(l.id)}>{l.label}</button>)}
        </div>
        <div className="ins-group" role="group" aria-label="Side">
          {(["all", "CT", "T"] as const).map((s) => <button key={s} type="button" className="chip" aria-pressed={side === s} onClick={() => setSide(s)}>{s === "all" ? "Both sides" : s}</button>)}
        </div>
        <div className="ins-group" role="group" aria-label="Time in round">
          {TIMES.map((x) => <button key={x.id} type="button" className="chip" aria-pressed={time === x.id} onClick={() => setTime(x.id)}>{x.label}</button>)}
        </div>
        <label className="sr-only" htmlFor="ins-player">Player</label>
        <select id="ins-player" className="select btn-sm" style={{ height: 28 }} value={player} onChange={(e) => setPlayer(e.target.value)}>
          <option value="">Whole team</option>
          {data?.players.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        <select className="select btn-sm" style={{ height: 28 }} aria-label="Rounds" value={rounds} onChange={(e) => setRounds(e.target.value)}>
          <option value="">All rounds</option>
          <option value="pistol">Pistol rounds</option>
          <option value="gun">Gun rounds</option>
          <option value="eco">Their eco rounds</option>
          <option value="half_buy">Their half buys</option>
          <option value="full_buy">Their full buys</option>
        </select>
        {layer === "kills" || layer === "deaths" ? (
          <select className="select btn-sm" style={{ height: 28 }} aria-label={layer === "kills" ? "Kill weapon" : "Killed by weapon"} value={weapon} onChange={(e) => setWeapon(e.target.value)}>
            <option value="">{layer === "kills" ? "Any weapon" : "Killed by any weapon"}</option>
            <option value="awp">{layer === "kills" ? "AWP kills" : "Killed by AWP"}</option>
            <option value="rifles">Rifles</option>
            <option value="smgs">SMGs</option>
            <option value="pistols">Pistols</option>
          </select>
        ) : null}
        {map && map.floors.length > 1 ? (
          <select className="select btn-sm" style={{ height: 28 }} aria-label="Floor" value={floor} onChange={(e) => setFloor(Number(e.target.value))}>
            {map.floors.map((f, i) => <option key={f.id} value={i}>{f.label} floor</option>)}
          </select>
        ) : null}
      </div>
      {layer === "nades" ? (
        <div className="ins-group" role="group" aria-label="Grenade type" style={{ marginBottom: 10 }}>
          {NADES.map((n) => (
            <button key={n.id} type="button" className="chip" aria-pressed={nadeType === n.id} onClick={() => setNadeType(n.id)}>
              <span className="ins-dot" style={{ background: n.color }} />{n.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      <div className="ins-body">
        {map ? <RadarCanvas map={map} floor={floor} layer={layer} points={data?.points ?? []} clusters={clusters} selected={selected} /> : <p className="muted">Loading…</p>}
        {layer === "nades" ? (
          <div className="ins-list">
            <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>
              Landing spots, most used first. Win % is the share of those rounds the team won. Open an example to watch the throw.
            </p>
            {clusters.length === 0 ? <p className="faint">No {NADES.find((n) => n.id === nadeType)?.label.toLowerCase() ?? "grenades"} with these filters.</p> : null}
            <ol>
              {clusters.slice(0, 15).map((c, i) => {
                const won = c.items.filter((x) => x.won).length;
                const ex = c.items[0];
                const hash = source.kind === "replay" ? source.shareHash ?? "" : "";
                return (
                  <li key={c.key} data-selected={selected === c.key}>
                    <button type="button" className="ins-cluster" onClick={() => setSelected(selected === c.key ? null : c.key)}>
                      <span className="ins-rank mono">{i + 1}</span>
                      <span className="ins-dot" style={{ background: nadeColor(c.type) }} />
                      <span className="grow">{c.items.length}× · {Math.round((100 * won) / c.items.length)}% won</span>
                      <span className="faint" style={{ fontSize: 12 }}>{[...new Set(c.items.map((x) => x.player))].slice(0, 2).join(", ")}</span>
                    </button>
                    {selected === c.key ? (
                      <ul className="ins-examples">
                        {c.items.slice(0, 8).map((n, j) => (
                          <li key={j}>
                            <Link href={`/replays/${n.replayId}?r=${n.roundId}&t=${Math.max(0, n.ms - 2000)}${hash}`}>
                              Round {n.roundNumber} · {n.player} · {n.side}{n.won ? " · won" : ""}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <div className="ins-list">
            <p className="faint" style={{ fontSize: 13, margin: 0 }}>
              {layer === "pos" ? "Where the team stood, sampled every 2 seconds while alive." : layer === "kills" ? "Where the team's players were when they got kills." : "Where the team's players died."}
              {" "}{data ? `${data.points.length} points.` : ""}
            </p>
            <p className="faint" style={{ fontSize: 12 }}>Tip: pick a side and “0–20 s” to see default setups.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function RadarCanvas({ map, floor, layer, points, clusters, selected }: {
  map: MapDef; floor: number; layer: Layer; points: Point[];
  clusters: { key: string; type: GrenadeType; lx: number; ly: number; items: Nade[] }[]; selected: string | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = `/radars/${map.id}${map.floors[floor]?.imageSuffix ?? ""}.png`;
  }, [map, floor]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const S = c.clientWidth || 560;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = S * dpr;
    c.height = S * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#080b0f";
    ctx.fillRect(0, 0, S, S);
    const k = S / map.imageSize;
    const xy = (x: number, y: number) => {
      const [px, py] = worldToImage(map, x, y);
      return [px * k, py * k] as const;
    };
    if (img) {
      ctx.filter = "grayscale(0.6) brightness(0.65)";
      ctx.drawImage(img, 0, 0, S, S);
      ctx.filter = "none";
    }
    const onFloor = (z: number) => map.floors.length < 2 || floorOf(map, z) === floor;

    if (layer !== "nades") {
      const pts = points.filter((p) => onFloor(p.z));
      if (!pts.length) return;
      // Density grid (half the canvas resolution) with a Gaussian kernel per point, normalised to the
      // 99th percentile so a few very busy cells do not wash everything else out.
      const G = Math.round(S / 2);
      const cell = S / G;
      const dens = new Float32Array(G * G);
      const rad = layer === "pos" ? 6 : 8;
      const sigma2 = 2 * (rad / 2) ** 2;
      const kernel: number[] = [];
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) kernel.push(Math.exp(-(dx * dx + dy * dy) / sigma2));
      for (const p of pts) {
        const [x, y] = xy(p.x, p.y);
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        let ki = 0;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++, ki++) {
            const gx = cx + dx;
            const gy = cy + dy;
            if (gx >= 0 && gy >= 0 && gx < G && gy < G) dens[gy * G + gx] += kernel[ki];
          }
        }
      }
      const nonzero = Array.from(dens).filter((v) => v > 0).sort((a, b) => a - b);
      const top = nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * 0.99))] : 1;
      const off = document.createElement("canvas");
      off.width = G; off.height = G;
      const o = off.getContext("2d")!;
      const id = o.createImageData(G, G);
      for (let i = 0; i < dens.length; i++) {
        const a = Math.min(1, dens[i] / top);
        if (a < 0.06) continue;
        const [R, Gc, B] = palette(a);
        id.data[i * 4] = R; id.data[i * 4 + 1] = Gc; id.data[i * 4 + 2] = B; id.data[i * 4 + 3] = Math.round(Math.min(1, a * 1.5) * 225);
      }
      o.putImageData(id, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, S, S);
      if (layer !== "pos") {
        ctx.fillStyle = layer === "kills" ? "rgba(127,209,139,0.9)" : "rgba(239,107,107,0.9)";
        for (const p of pts) {
          const [x, y] = xy(p.x, p.y);
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }

    for (const c2 of clusters) {
      const dim = selected && selected !== c2.key;
      const col = nadeColor(c2.type);
      ctx.globalAlpha = dim ? 0.12 : selected ? 0.9 : 0.55;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      for (const n of c2.items) {
        const [ox, oy] = xy(n.ox, n.oy);
        const [lx, ly] = xy(n.lx, n.ly);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(lx, ly);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(ox, oy, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      const [cx, cy] = xy(c2.lx, c2.ly);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 4 + Math.min(10, c2.items.length * 1.5), 0, Math.PI * 2);
      ctx.fillStyle = `${col}55`;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [img, map, floor, layer, points, clusters, selected]);

  return <canvas ref={ref} className="ins-canvas" role="img" aria-label={`${mapName(map.id)} radar with ${layer === "nades" ? "grenade throws" : "heatmap"}`} />;
}

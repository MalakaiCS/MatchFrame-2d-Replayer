"use client";
/**
 * Several rounds on one map at once, all from the end of freeze time: e.g. a team's last 5 full-buy
 * T rounds, to see their pathing in the first seconds. Each round has its own colour; pick a player
 * to see only them; click a dot to see (and open) the round it belongs to.
 *
 * Opened with explicit rounds (?rounds=<replay>~<round>,...&team=<name>) or a query
 * (?team=<name>&map=<map>&side=T&buy=full_buy&n=5), which uses round search.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Manifest, RoundSummary, Side, TeamKey } from "@/shared/contract";
import { floorForZ, getMapDef, listMaps, type MapDef, mapName, worldToImage, yawToCanvas } from "@/viewer/maps";
import { frameAt, type RoundIndex } from "@/viewer/playback";
import { RoundCache } from "@/viewer/roundCache";
import { api } from "./api";

export const MAX_ROUNDS = 10;
const PALETTE = ["#4fc3f7", "#ffb74d", "#81c784", "#f06292", "#ba68c8", "#fff176", "#4db6ac", "#ff8a65", "#9fa8da", "#e0e0e0"];
const SPEEDS = [0.5, 1, 2, 4];
const STOPS = [{ id: "20", label: "Stop at 0:20", s: 20 }, { id: "35", label: "Stop at 0:35", s: 35 }, { id: "60", label: "Stop at 1:00", s: 60 }, { id: "end", label: "Whole round", s: Infinity }];
const TRAILS = [{ id: "full", label: "Full paths" }, { id: "5", label: "Last 5 s" }, { id: "off", label: "No paths" }];
const BUYS = [{ id: "full_buy", label: "Full buys" }, { id: "half_buy", label: "Half buys" }, { id: "eco", label: "Ecos" }, { id: "pistol", label: "Pistols" }, { id: "", label: "Any buy" }];

interface Loaded {
  key: string; replayId: string; round: RoundSummary; manifest: Manifest; index: RoundIndex; color: string;
  /** Focus team in this demo (null = show both teams). */
  team: TeamKey | null; side: Side | null; label: string;
}
interface Hit { x: number; y: number; round: number; playerId: string; name: string }

const fmt = (v: number) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
const startTick = (r: RoundSummary) => r.freezeEndTick ?? r.startTick;
const lengthS = (l: Loaded) => ((l.round.decidedTick ?? l.round.endTick) - startTick(l.round)) * (l.manifest.tickIntervalMs / 1000);

function parseRounds(v: string | null) {
  return (v ?? "").split(",").map((s) => s.split("~")).filter(([r, id]) => r && id && /^[A-Za-z0-9]{8,64}$/.test(r) && /^r\d{2,3}$/.test(id))
    .slice(0, MAX_ROUNDS).map(([replayId, roundId]) => ({ replayId, roundId }));
}

export function MultiRound() {
  const params = useSearchParams();
  const router = useRouter();
  const team = params.get("team") ?? "";
  const qMap = params.get("map") ?? "";
  const qSide = params.get("side") ?? "T";
  const qBuy = params.get("buy") ?? "full_buy";
  const qN = Math.min(MAX_ROUNDS, Math.max(2, Number(params.get("n") ?? 5) || 5));
  const explicit = params.get("rounds");

  const [rounds, setRounds] = useState<Loaded[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null); // round key
  const [player, setPlayer] = useState(""); // steamId or name
  const [showOpp, setShowOpp] = useState(false);
  const [trails, setTrails] = useState("full");
  const [stop, setStop] = useState("35");
  const [floor, setFloor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [secs, setSecs] = useState(0);
  const [hover, setHover] = useState<(Hit & { sx: number; sy: number }) | null>(null);
  const [picked, setPicked] = useState<Hit | null>(null);
  const secsRef = useRef(0);
  const hits = useRef<Hit[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const radar = useRef<HTMLImageElement | null>(null);

  // Which rounds: explicit list, or the newest rounds matching the query.
  useEffect(() => {
    let stop_ = false;
    setLoading(true); setError(null); setRounds([]); setFocus(null); setPicked(null);
    (async () => {
      let list = parseRounds(explicit);
      if (!explicit) {
        if (!team || !qMap) throw new Error("Pick a team and a map.");
        const tags = qBuy ? (qBuy === "pistol" ? "pistol" : qBuy) : "";
        const qs = new URLSearchParams({ team, map: qMap, side: qSide, ...(tags ? { tags } : {}),
          ...(params.get("space") ? { space: params.get("space")! } : {}), ...(params.get("teamId") ? { teamId: params.get("teamId")! } : {}) });
        let res: { pending: number; results: { replayId: string; id: string; when: string; number: number }[] };
        for (let i = 0; ; i++) {
          res = await api(`/api/rounds/search?${qs}`);
          if (!res.pending || i > 15) break;
          await new Promise((r) => setTimeout(r, 600));
        }
        // The most recent rounds: newest demo first, then the latest rounds in it; played in round order.
        const latest = [...res!.results].sort((x, y) => y.when.localeCompare(x.when) || y.number - x.number).slice(0, qN);
        latest.sort((x, y) => x.when.localeCompare(y.when) || x.number - y.number);
        list = latest.map((r) => ({ replayId: r.replayId, roundId: r.id }));
        if (!list.length) throw new Error(`No ${BUYS.find((b) => b.id === qBuy)?.label.toLowerCase() ?? "rounds"} on ${qSide} for ${team} on ${mapName(qMap)} yet.`);
      }
      if (list.length < 1) throw new Error("No rounds picked.");
      const manifests = new Map<string, Promise<Manifest>>();
      const man = (id: string) => manifests.get(id) ?? manifests.set(id, api<{ manifest: Manifest | null }>(`/api/replays/${id}`).then((r) => {
        if (!r.manifest) throw new Error("A demo is still processing.");
        return r.manifest;
      })).get(id)!;
      const out = await Promise.all(list.map(async ({ replayId, roundId }, i) => {
        const m = await man(replayId);
        const round = m.rounds.find((x) => x.id === roundId);
        if (!round) throw new Error(`Round ${roundId} is not in that demo.`);
        const index = await new RoundCache(replayId, () => ({})).get(roundId);
        const key = (["A", "B"] as TeamKey[]).find((k) => team && m.teams[k].name.trim().toLowerCase() === team.trim().toLowerCase()) ?? null;
        const opp = key ? m.teams[key === "A" ? "B" : "A"].name : `${m.teams.A.name} vs ${m.teams.B.name}`;
        const buy = key ? m.rounds.find((x) => x.id === roundId)?.economy?.[key]?.buyType : null;
        return {
          key: `${replayId}~${roundId}`, replayId, round, manifest: m, index, color: PALETTE[i % PALETTE.length], team: key,
          side: key ? round.sides[key] : null,
          label: `R${round.displayNumber} ${key ? `vs ${opp}` : opp}${buy ? ` · ${String(buy).replace("_", " ")}` : ""}`,
        } satisfies Loaded;
      }));
      if (stop_) return;
      const maps = new Set(out.map((l) => l.manifest.map.id));
      if (maps.size > 1) throw new Error("All rounds must be on the same map.");
      setRounds(out);
    })().catch((e) => { if (!stop_) setError(e instanceof Error ? e.message : "Could not load the rounds."); })
      .finally(() => { if (!stop_) setLoading(false); });
    return () => { stop_ = true; };
  }, [explicit, team, qMap, qSide, qBuy, qN]); // eslint-disable-line react-hooks/exhaustive-deps

  const map: MapDef | null = rounds[0] ? getMapDef(rounds[0].manifest.map.id) : null;
  useEffect(() => {
    if (!map) return;
    const img = new Image();
    img.onload = () => { radar.current = img; };
    img.src = `/radars/${map.id}${map.floors[floor]?.imageSuffix ?? ""}.png`;
    radar.current = null;
  }, [map, floor]);

  // Players you can pick: the focus team's (by Steam id, else name) across the rounds.
  const roster = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of rounds) for (const p of l.manifest.players) if (!l.team || p.team === l.team) m.set(p.steamId ?? p.name, p.name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rounds]);

  const stopS = STOPS.find((s) => s.id === stop)!.s;
  const total = Math.min(stopS, Math.max(1, ...rounds.map(lengthS)));

  // Animation and drawing.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(250, now - last);
      last = now;
      if (playing) {
        secsRef.current = Math.min(total, secsRef.current + (dt / 1000) * speed);
        if (secsRef.current >= total) setPlaying(false);
      }
      draw();
      setSecs((v) => (Math.abs(v - secsRef.current) > 0.1 ? secsRef.current : v));
      raf = requestAnimationFrame(loop);
    };
    const draw = () => {
      const c = canvas.current;
      if (!c || !map) return;
      const S = c.clientWidth;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(S * dpr)) { c.width = Math.round(S * dpr); c.height = Math.round(S * dpr); }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#080b0f"; ctx.fillRect(0, 0, S, S);
      if (radar.current) { ctx.filter = "grayscale(0.5) brightness(0.7)"; ctx.drawImage(radar.current, 0, 0, S, S); ctx.filter = "none"; }
      const k = S / map.imageSize;
      const xy = (x: number, y: number) => { const [px, py] = worldToImage(map, x, y); return [px * k, py * k] as const; };
      const onFloor = (z: number) => map.floors.length < 2 || floorForZ(map, z) === floor;
      const out: Hit[] = [];
      rounds.forEach((l, ri) => {
        if (hidden.has(l.key)) return;
        const dim = focus && focus !== l.key;
        const alpha = dim ? 0.18 : 1;
        const t0 = startTick(l.round);
        const tr = l.manifest.tickRate;
        const endT = (l.round.decidedTick ?? l.round.endTick) - 1;
        const tick = Math.min(endT, t0 + secsRef.current * tr);
        const frame = frameAt(l.index, tick);
        const wanted = (pid: string) => {
          const p = l.manifest.players.find((x) => x.id === pid);
          if (!p) return null;
          const mine = !l.team || p.team === l.team;
          if (!mine && !showOpp) return null;
          if (player && mine && (p.steamId ?? p.name) !== player) return null;
          if (player && !mine) return null;
          return { p, mine };
        };
        // Smokes and fires, faint.
        for (const e of frame.effects) {
          if (e.effect.kind !== "smoke" && e.effect.kind !== "fire") continue;
          if (!onFloor(e.effect.position.z)) continue;
          const [x, y] = xy(e.effect.position.x, e.effect.position.y);
          ctx.globalAlpha = (dim ? 0.06 : 0.22);
          ctx.fillStyle = e.effect.kind === "smoke" ? "#cfd8dc" : "#ff7043";
          ctx.beginPath(); ctx.arc(x, y, (e.effect.radius || 144) * k / map.scale, 0, Math.PI * 2); ctx.fill();
        }
        // Paths.
        if (trails !== "off") {
          const from = trails === "full" ? t0 : tick - 5 * tr;
          for (const t of l.index.payload.tracks) {
            const w = wanted(t.playerId);
            if (!w) continue;
            ctx.globalAlpha = alpha * (w.mine ? 0.75 : 0.3);
            ctx.strokeStyle = w.mine ? l.color : "#9aa4b2";
            ctx.lineWidth = w.mine ? 2 : 1;
            ctx.beginPath();
            let open = false;
            for (let i = 0; i < t.t.length; i++) {
              if (t.t[i] < from) continue;
              if (t.t[i] > tick) break;
              if (!t.alive[i] || !onFloor(t.z[i])) { open = false; continue; }
              const [x, y] = xy(t.x[i], t.y[i]);
              if (!open || t.disc[i]) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
        // Players.
        for (const f of frame.players) {
          if (!f.visible) continue;
          const w = wanted(f.id);
          if (!w || !onFloor(f.z)) continue;
          const [x, y] = xy(f.x, f.y);
          ctx.globalAlpha = alpha;
          if (!f.alive) {
            ctx.strokeStyle = w.mine ? l.color : "#9aa4b2"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
            continue;
          }
          const r = w.mine ? 6 : 4;
          ctx.fillStyle = w.mine ? l.color : "#9aa4b2";
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 1.5; ctx.stroke();
          if (w.mine) {
            const a = yawToCanvas(map, f.yaw);
            ctx.strokeStyle = l.color; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.lineTo(x + Math.cos(a) * (r + 7), y + Math.sin(a) * (r + 7)); ctx.stroke();
            if (!dim) out.push({ x, y, round: ri, playerId: f.id, name: w.p.name });
          }
          if (picked && picked.round === ri && picked.playerId === f.id) {
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      });
      hits.current = out;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rounds, map, hidden, focus, player, showOpp, trails, floor, playing, speed, total, picked]);

  const hitAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    let best: Hit | null = null, bd = 12;
    for (const h of hits.current) { const d = Math.hypot(h.x - sx, h.y - sy); if (d < bd) { bd = d; best = h; } }
    return best ? { ...best, sx, sy } : null;
  };

  const sel = picked ? rounds[picked.round] : focus ? rounds.find((l) => l.key === focus) : null;
  const openHref = (l: Loaded) => `/replays/${l.replayId}?r=${l.round.id}&t=${Math.round((startTick(l.round) - l.round.startTick) * l.manifest.tickIntervalMs + secs * 1000)}`;
  const setQuery = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ team, map: qMap || rounds[0]?.manifest.map.id || "", side: qSide, buy: qBuy, n: String(qN),
      ...(params.get("space") ? { space: params.get("space")! } : {}), ...(params.get("teamId") ? { teamId: params.get("teamId")! } : {}), ...patch });
    router.replace(`/replays/multi?${p}`);
  };

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <p className="ms-eyebrow"><Link href="/antistrat">Anti-strat</Link> · Multi-round</p>
      <h1 style={{ marginTop: 0 }}>Rounds together{team ? `: ${team}` : ""}{map ? ` on ${mapName(map.id)}` : ""}</h1>
      <p className="page-sub">Every round starts from the end of freeze time, so you can see how the paths line up. Pick a player to follow only them; click a dot to see its round.</p>
      {team ? (
        <div className="lib-toolbar" role="group" aria-label="Which rounds">
          {!explicit ? null : <span className="faint" style={{ fontSize: 13 }}>Picked rounds · or load:</span>}
          <select className="select" aria-label="Map" value={qMap || rounds[0]?.manifest.map.id || ""} onChange={(e) => setQuery({ map: e.target.value })}>
            {!qMap && !rounds[0] ? <option value="">Map…</option> : null}
            {listMaps().map((m) => <option key={m.id} value={m.id}>{mapName(m.id)}</option>)}
          </select>
          <select className="select" aria-label="Side" value={qSide} onChange={(e) => setQuery({ side: e.target.value })}>
            <option value="T">T side</option><option value="CT">CT side</option>
          </select>
          <select className="select" aria-label="Buy" value={qBuy} onChange={(e) => setQuery({ buy: e.target.value })}>
            {BUYS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
          <select className="select" aria-label="Number of rounds" value={qN} onChange={(e) => setQuery({ n: e.target.value })}>
            {[3, 5, 8, 10].map((n) => <option key={n} value={n}>Last {n}</option>)}
          </select>
        </div>
      ) : null}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {loading ? <p className="muted">Loading rounds…</p> : null}
      {rounds.length && map ? (
        <div className="mr-grid">
          <div>
            <div className="mr-canvas-wrap">
              <canvas ref={canvas} className="mr-canvas" role="img" aria-label={`${rounds.length} rounds overlaid on ${mapName(map.id)}`}
                onPointerMove={(e) => setHover(hitAt(e))} onPointerLeave={() => setHover(null)}
                onClick={(e) => { const h = hitAt(e); setPicked(h); if (h) setFocus(rounds[h.round].key); }} />
              {hover ? (
                <div className="mr-tip" style={{ left: hover.sx + 12, top: hover.sy + 8 }}>
                  <strong>{hover.name}</strong> · {rounds[hover.round].label}
                </div>
              ) : null}
            </div>
            <div className="card cmp-transport" role="toolbar" aria-label="Playback">
              <button type="button" className="btn btn-primary" onClick={() => { if (secsRef.current >= total) secsRef.current = 0; setPlaying((p) => !p); }}>{playing ? "Pause" : "Play"}</button>
              <select className="select" aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((v) => <option key={v} value={v}>{v}×</option>)}
              </select>
              <span className="mono">{fmt(secs)}</span>
              <label className="sr-only" htmlFor="mr-scrub">Time since freeze end</label>
              <input id="mr-scrub" type="range" min={0} max={Math.ceil(total)} step={0.1} value={Math.min(secs, total)} className="grow"
                onChange={(e) => { secsRef.current = Number(e.target.value); setSecs(secsRef.current); }} />
              <select className="select" aria-label="Stop at" value={stop} onChange={(e) => setStop(e.target.value)}>
                {STOPS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <aside className="mr-side">
            <section className="card">
              <h2 className="st-h2" style={{ marginTop: 0 }}>Show</h2>
              <label className="mr-field"><span>Player</span>
                <select className="select" aria-label="Player" value={player} onChange={(e) => setPlayer(e.target.value)}>
                  <option value="">Everyone{team ? ` on ${team}` : ""}</option>
                  {roster.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select>
              </label>
              <div className="ins-group" role="group" aria-label="Paths">
                {TRAILS.map((t) => <button key={t.id} type="button" className="chip" aria-pressed={trails === t.id} onClick={() => setTrails(t.id)}>{t.label}</button>)}
              </div>
              {rounds.some((l) => l.team) ? (
                <label className="row" style={{ fontSize: 13, marginTop: 8 }}><input type="checkbox" checked={showOpp} onChange={(e) => setShowOpp(e.target.checked)} /> Show their opponents (grey)</label>
              ) : null}
              {map.floors.length > 1 ? (
                <div className="ins-group" role="group" aria-label="Floor" style={{ marginTop: 8 }}>
                  {map.floors.map((f, i) => <button key={i} type="button" className="chip" aria-pressed={floor === i} onClick={() => setFloor(i)}>{f.label}</button>)}
                </div>
              ) : null}
            </section>
            <section className="card">
              <h2 className="st-h2" style={{ marginTop: 0 }}>Rounds ({rounds.length})</h2>
              <ul className="mr-rounds">
                {rounds.map((l) => (
                  <li key={l.key} className={focus === l.key ? "mr-on" : ""}>
                    <input type="checkbox" aria-label={`Show ${l.label}`} checked={!hidden.has(l.key)}
                      onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(l.key)) n.delete(l.key); else n.add(l.key); return n; })} />
                    <i className="mr-swatch" style={{ background: l.color }} />
                    <button type="button" className="mr-round" aria-pressed={focus === l.key} title="Highlight this round" onClick={() => { setPicked(null); setFocus((f) => (f === l.key ? null : l.key)); }}>
                      {l.label}{l.side ? <span className="faint"> · {l.side}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {focus ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setFocus(null); setPicked(null); }}>Show all rounds equally</button> : null}
            </section>
            {sel ? (
              <section className="card" aria-live="polite">
                <h2 className="st-h2" style={{ marginTop: 0 }}><i className="mr-swatch" style={{ background: sel.color }} /> {picked ? picked.name : "Round"}</h2>
                <p style={{ margin: "0 0 4px" }}>{sel.manifest.teams.A.name} {sel.round.scoreBefore.A}–{sel.round.scoreBefore.B} {sel.manifest.teams.B.name}</p>
                <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>Round {sel.round.displayNumber}{sel.round.winner ? ` · won by ${sel.manifest.teams[sel.round.winner].name}` : ""}</p>
                <Link className="btn btn-sm btn-primary" href={openHref(sel)}>Open this round at {fmt(secs)}</Link>
              </section>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

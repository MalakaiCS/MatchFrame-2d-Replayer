"use client";
/**
 * Two rounds side by side on one clock (time since freeze end), e.g. the same execute on two days
 * or two teams on the same site. Opened from round search (?a=<replay>~<round>&b=<replay>~<round>).
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Manifest, PlayerInfo, RoundSummary, Side } from "@/shared/contract";
import { drawFrame } from "@/viewer/draw";
import { getMapDef, mapName, type MapDef } from "@/viewer/maps";
import { frameAt, type RoundIndex } from "@/viewer/playback";
import { RoundCache } from "@/viewer/roundCache";
import { api } from "./api";

interface Side_ {
  replayId: string; manifest: Manifest; round: RoundSummary; index: RoundIndex; map: MapDef;
  players: Map<string, PlayerInfo & { side: Side }>; radar: HTMLImageElement | null;
}

const SPEEDS = [0.5, 1, 2, 4];

function parse(v: string | null) {
  const [replayId, roundId] = (v ?? "").split("~");
  return replayId && roundId && /^[A-Za-z0-9]{8,64}$/.test(replayId) && /^r\d{2,3}$/.test(roundId) ? { replayId, roundId } : null;
}

async function loadSide(replayId: string, roundId: string): Promise<Side_> {
  const r = await api<{ manifest: Manifest | null }>(`/api/replays/${replayId}`);
  if (!r.manifest) throw new Error("That demo is still processing.");
  const m = r.manifest;
  const round = m.rounds.find((x) => x.id === roundId);
  if (!round) throw new Error("That round is not in the demo.");
  const index = await new RoundCache(replayId, () => ({})).get(roundId);
  const map = getMapDef(m.map.id);
  if (!map) throw new Error("Unknown map.");
  const players = new Map(m.players.map((p) => [p.id, { ...p, side: round.sides[p.team] }]));
  const radar = await new Promise<HTMLImageElement | null>((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = `/radars/${map.id}.png`;
  });
  return { replayId, manifest: m, round, index, map, players, radar };
}

export function RoundCompare() {
  const params = useSearchParams();
  const a = parse(params.get("a"));
  const b = parse(params.get("b"));
  const [sides, setSides] = useState<[Side_ | null, Side_ | null]>([null, null]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [secs, setSecs] = useState(0);
  const secsRef = useRef(0);
  const canvases = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];

  useEffect(() => {
    if (!a || !b) { setError("Pick two rounds to compare (from Find rounds)."); return; }
    Promise.all([loadSide(a.replayId, a.roundId), loadSide(b.replayId, b.roundId)])
      .then((s) => setSides(s))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the rounds."));
  }, [a?.replayId, a?.roundId, b?.replayId, b?.roundId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lengthS = (s: Side_ | null) => (s ? ((s.round.decidedTick ?? s.round.endTick) - (s.round.freezeEndTick ?? s.round.startTick)) * (s.manifest.tickIntervalMs / 1000) : 0);
  const total = Math.max(lengthS(sides[0]), lengthS(sides[1]), 1);

  // Animation: advance the shared clock and draw both radars.
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
      sides.forEach((s, i) => {
        const c = canvases[i].current;
        if (!s || !c) return;
        const w = c.clientWidth;
        const h = c.clientHeight;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const tick = (s.round.freezeEndTick ?? s.round.startTick) + secsRef.current * s.manifest.tickRate;
        const frame = frameAt(s.index, Math.min(tick, s.round.endTick - 1));
        drawFrame(c.getContext("2d")!, {
          map: s.map, viewport: { zoom: 1, cx: s.map.imageSize / 2, cy: s.map.imageSize / 2 }, width: w, height: h, dpr, frame,
          players: s.players, selected: null, floor: "auto", radar: s.radar, showNames: true, showTrails: true, showUtility: true, showDeaths: true,
        });
      });
      setSecs((v) => (Math.abs(v - secsRef.current) > 0.2 ? secsRef.current : v));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sides, playing, speed, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (v: number) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <p className="ms-eyebrow"><Link href="/stats/rounds">Find rounds</Link> · Compare</p>
      <h1 style={{ marginTop: 0 }}>Compare rounds</h1>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      <div className="cmp-grid">
        {sides.map((s, i) => (
          <section key={i} className="card cmp-panel" aria-label={`Round ${i === 0 ? "A" : "B"}`}>
            {s ? (
              <header className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <div>
                  <strong>{s.manifest.teams.A.name} {s.round.scoreBefore.A}–{s.round.scoreBefore.B} {s.manifest.teams.B.name}</strong>
                  <div className="faint" style={{ fontSize: 12 }}>{mapName(s.manifest.map.id)} · Round {s.round.displayNumber}{s.round.winner ? ` · won by ${s.manifest.teams[s.round.winner].name}` : ""}</div>
                </div>
                <Link className="btn btn-sm" href={`/replays/${s.replayId}?r=${s.round.id}&t=${Math.round(((s.round.freezeEndTick ?? s.round.startTick) - s.round.startTick) * s.manifest.tickIntervalMs + secs * 1000)}`}>Open in replay</Link>
              </header>
            ) : <p className="muted">Loading…</p>}
            <canvas ref={canvases[i]} className="cmp-canvas" role="img" aria-label={s ? `Radar, round ${s.round.displayNumber}` : "Loading"} />
          </section>
        ))}
      </div>
      <div className="card cmp-transport" role="toolbar" aria-label="Playback">
        <button type="button" className="btn btn-primary" onClick={() => { if (secsRef.current >= total) secsRef.current = 0; setPlaying((p) => !p); }} disabled={!sides[0] || !sides[1]}>
          {playing ? "Pause" : "Play"}
        </button>
        <select className="select" aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((v) => <option key={v} value={v}>{v}×</option>)}
        </select>
        <span className="mono">{fmt(secs)}</span>
        <label className="sr-only" htmlFor="cmp-scrub">Time since freeze end</label>
        <input id="cmp-scrub" type="range" min={0} max={Math.ceil(total)} step={0.25} value={secs} className="grow"
          onChange={(e) => { secsRef.current = Number(e.target.value); setSecs(secsRef.current); }} />
        <span className="faint" style={{ fontSize: 12 }}>Both rounds run from the end of freeze time.</span>
      </div>
    </div>
  );
}

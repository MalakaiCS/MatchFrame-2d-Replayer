"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Manifest, PlayerInfo, RoundSummary, Side } from "@/shared/contract";
import { tickToRoundMs } from "@/shared/contract";
import type { AudioSync } from "@/viewer/audioSync";
import { clockAt } from "@/viewer/clock";
import { drawFrame, drawSplit, panelWidth, playerAtPoint, type Stroke } from "@/viewer/draw";
import { filterRounds, filtersFromParam, filtersToParam, type RoundFilters } from "@/viewer/filters";
import { getMapDef, mapName, screenToImage, type Viewport, worldToImage, zoomAt } from "@/viewer/maps";
import { frameAt, inventoryAt, nextEvent, type Frame, type RoundIndex } from "@/viewer/playback";
import { RoundCache } from "@/viewer/roundCache";
import { buildReplayUrl, resolveMoment, shareTokenFromHash } from "@/viewer/shareUrl";
import { api, ApiError, setShareToken } from "../api";
import {
  IconBack, IconFit, IconForward, IconKeyboard, IconLayers, IconNextEvent, IconNextRound, IconPause, IconPlay,
  IconClose, IconEdit, IconPrevEvent, IconPrevRound, IconShare, IconZoomIn, IconZoomOut,
} from "../icons";
import { StatusBadge } from "../Library";
import { CommsPanel } from "./CommsPanel";
import { KillModifiers, WeaponIcon } from "./GameIcons";
import { EventsPanel, PlaylistPanel, ReviewPanel, useReview } from "./panels";
import { TeamScoreboard } from "./Scoreboard";
import { reasonText, RoundStrip } from "./RoundStrip";
import { ShareDialog, ShortcutsDialog } from "./ShareDialog";
import { Timeline } from "./Timeline";

/** Playback speeds. Pending reference verification (docs/replayer-parity.md PLAY-04). */
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const SEEK_SECONDS = 5;
const NAV_EVENTS = new Set(["kill", "bomb_plant", "bomb_defuse", "bomb_explode"]);

interface ReplayResponse {
  replay: {
    id: string; title: string | null; status: string; failureCode: string | null; failureDetail: string | null; visibility: string;
    sourceAvailable: boolean; teamId: string | null; seriesId: string | null; seriesMapIndex: number | null; mapId: string | null;
  };
  access: { via: string; canManage: boolean; canReview: boolean; signedIn: boolean; roundId?: string | null };
  manifest: Manifest | null;
  series: { id: string; mapIndex: number | null; mapId: string | null; status: string; scoreA: number | null; scoreB: number | null }[];
}

type DockTab = "events" | "notes" | "bookmarks" | "playlists" | "comms";

function isTextInput(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["range", "checkbox", "radio", "button", "submit"].includes(el.type);
  return false;
}

export function ReplayViewer({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<ReplayResponse | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [shareToken, setToken] = useState<string | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);

  // ---- bootstrap: read share token from the fragment, then load the manifest
  const load = useCallback(async () => {
    const tok = shareTokenFromHash(window.location.hash);
    setToken(tok);
    setShareToken(tok);
    try {
      const r = await api<ReplayResponse>(`/api/replays/${id}`);
      setData(r);
      setLoadError(null);
      if (r.access.signedIn) api<{ teams: { id: string; name: string }[] }>("/api/teams").then((t) => setTeams(t.teams)).catch(() => {});
    } catch (e) {
      setLoadError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : "Could not open the replay." });
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  // Poll while processing.
  useEffect(() => {
    if (!data || data.manifest || !["queued", "processing", "uploading"].includes(data.replay.status)) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [data, load]);

  // Signed out and no valid link: go to the login screen and come back here afterwards.
  useEffect(() => {
    if (loadError?.status === 401) router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [loadError, router]);

  if (loadError) {
    if (loadError.status === 401) return <div className="page"><p className="muted">Redirecting to sign in…</p></div>;
    if (loadError.status === 402) {
      return (
        <div className="page" style={{ maxWidth: 640 }}>
          <h1>This replay needs a plan</h1>
          <p className="page-sub">{loadError.message}</p>
          <div className="row"><Link className="btn btn-primary" href="/billing">See plans</Link><Link className="btn" href="/replays">Go to library</Link></div>
        </div>
      );
    }
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <h1>{loadError.status === 401 ? "Sign in to view this replay" : "Replay unavailable"}</h1>
        <p className="page-sub">{loadError.status === 404 ? "This replay does not exist, was deleted, or the link was revoked." : loadError.message}</p>
        {loadError.status === 401 ? <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent(`/replays/${id}`)}`}>Sign in</Link> : <Link className="btn" href="/replays">Go to library</Link>}
      </div>
    );
  }
  if (!data) return <div className="page"><p className="muted">Loading replay…</p></div>;
  if (!data.manifest) {
    const r = data.replay;
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <h1>{r.title ?? "Replay"}</h1>
        <p className="row"><StatusBadge status={r.status} /></p>
        {r.status === "failed" ? (
          <div className="alert alert-err" role="alert">
            <p style={{ marginTop: 0 }}>{r.failureDetail ?? r.failureCode}</p>
            {r.failureCode === "SOURCE_MISSING" || !r.sourceAvailable ? <Link className="btn" href="/replays/new">Upload the demo again</Link> : null}
          </div>
        ) : <p className="muted" aria-live="polite">Parsing the demo. This page updates automatically.</p>}
      </div>
    );
  }
  return <Workspace key={data.manifest.revision} data={data} manifest={data.manifest} shareToken={shareToken} teams={teams} router={router} params={params} reload={load} />;
}

function Workspace({
  data, manifest, shareToken, teams, router, params, reload,
}: {
  data: ReplayResponse; manifest: Manifest; shareToken: string | null; teams: { id: string; name: string }[];
  router: ReturnType<typeof useRouter>; params: ReturnType<typeof useSearchParams>; reload: () => void;
}) {
  const id = data.replay.id;
  const map = getMapDef(manifest.map.id)!;
  const viaShare = data.access.via === "share";
  const canReview = data.access.canReview && !viaShare;

  // ---- initial moment from ?r=&t= (clamped to safe values)
  const initial = useMemo(() => resolveMoment(manifest, params.get("r"), params.get("t")), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [filters, setFiltersState] = useState<RoundFilters>(() => filtersFromParam(params.get("f")));
  const [roundId, setRoundId] = useState(initial.round.id);
  const [index, setIndex] = useState<RoundIndex | null>(null);
  const [roundError, setRoundError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [uiTick, setUiTick] = useState(initial.tick);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  // Multi-level maps default to both floors side by side; "auto" overlays them; a number shows one floor.
  const [floor, setFloor] = useState<"split" | "auto" | number>(() => (map.floors.length > 1 ? "split" : "auto"));
  const [autoplay, setAutoplay] = useState(true);
  // Freeze time is skipped by default and left off the timeline.
  const [skipFreeze, setSkipFreeze] = useState(true);
  const [toggles, setToggles] = useState({ names: true, trails: true, utility: true, deaths: true });
  const [dockTab, setDockTab] = useState<DockTab>("events");
  // The review drawer (events, notes, bookmarks, playlists, comms) sits beside the scoreboards; closed by default.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mutedRadar, setMutedRadar] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [composeSignal, setComposeSignal] = useState(0);
  const [tool, setTool] = useState<"pan" | "draw">("pan");
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const strokes = useRef<Map<string, Stroke[]>>(new Map());
  const [strokeCount, setStrokeCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(initial.clamped ? "The link pointed outside this replay; opened the nearest valid moment." : null);

  const round = manifest.rounds.find((r) => r.id === roundId)!;
  const visibleRounds = useMemo(() => filterRounds(manifest.rounds, filters), [manifest.rounds, filters]);
  const review = useReview(id, canReview);

  // ---- refs used by the animation loop
  const tickRef = useRef(initial.tick);
  const pendingTick = useRef<number | null>(initial.tick);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const indexRef = useRef<RoundIndex | null>(null);
  const roundRef = useRef<RoundSummary>(round);
  const viewport = useRef<Viewport>({ zoom: 1, cx: map.imageSize / 2, cy: map.imageSize / 2 });
  const dirty = useRef(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const radarImgs = useRef<Map<number, HTMLImageElement | null>>(new Map());
  const syncs = useRef<Map<string, AudioSync>>(new Map());
  const optsRef = useRef({ selected, follow, floor, toggles, autoplay, skipFreeze, visibleRounds, mutedRadar });
  optsRef.current = { selected, follow, floor, toggles, autoplay, skipFreeze, visibleRounds, mutedRadar };
  roundRef.current = round;
  playingRef.current = playing;
  speedRef.current = speed;

  const cache = useMemo(() => new RoundCache(id, (): Record<string, string> => (shareToken ? { "X-Share-Token": shareToken } : {})), [id, shareToken]);
  useEffect(() => () => cache.clear(), [cache]);

  // ---- players with their side for the current round
  const players = useMemo(() => {
    const m = new Map<string, PlayerInfo & { side: Side }>();
    for (const p of manifest.players) m.set(p.id, { ...p, side: round.sides[p.team] });
    return m;
  }, [manifest.players, round]);

  // ---- load the selected round; cancel stale fetches; prefetch the next
  useEffect(() => {
    let cancelled = false;
    setIndex(null);
    indexRef.current = null;
    setRoundError(null);
    cache.cancelExcept([roundId]);
    cache.get(roundId).then(
      (idx) => {
        if (cancelled) return;
        indexRef.current = idx;
        setIndex(idx);
        const want = pendingTick.current ?? (optsRef.current.skipFreeze && round.freezeEndTick ? round.freezeEndTick : round.startTick);
        pendingTick.current = null;
        const lo = optsRef.current.skipFreeze && round.freezeEndTick !== null ? round.freezeEndTick : round.startTick;
        tickRef.current = Math.min(Math.max(want, lo), round.endTick - 1);
        setUiTick(tickRef.current);
        dirty.current = true;
        const i = manifest.rounds.findIndex((r) => r.id === roundId);
        cache.prefetch(manifest.rounds[i + 1]?.id);
      },
      (e) => !cancelled && setRoundError(e instanceof Error ? e.message : "Could not load the round."),
    );
    return () => {
      cancelled = true;
    };
  }, [roundId, retry, cache, manifest.rounds, round.freezeEndTick, round.startTick, round.endTick]);

  // ---- radar images (optional, operator-installed; see docs/assets-and-licences.md)
  useEffect(() => {
    map.floors.forEach((f, i) => {
      const img = new Image();
      img.onload = () => { radarImgs.current.set(i, img); dirty.current = true; };
      img.onerror = () => radarImgs.current.set(i, null);
      img.src = `/radars/${map.id}${f.imageSuffix ?? ""}.png`;
    });
  }, [map]);

  // ---- URL sync (round, time, filters; the share fragment is preserved)
  const syncUrl = useCallback(() => {
    const r = roundRef.current;
    const u = new URL(window.location.href);
    u.searchParams.set("r", r.id);
    u.searchParams.set("t", String(Math.max(0, tickToRoundMs(Math.round(tickRef.current), r, manifest.tickIntervalMs))));
    const f = filtersToParam(filters);
    if (f) u.searchParams.set("f", f);
    else u.searchParams.delete("f");
    window.history.replaceState(window.history.state, "", u.toString());
  }, [filters, manifest.tickIntervalMs]);
  useEffect(() => {
    const t = setTimeout(syncUrl, 300);
    return () => clearTimeout(t);
  }, [roundId, playing, uiTick, filters, syncUrl]);

  // Turning freeze-skip on while inside freeze time jumps to freeze end.
  useEffect(() => {
    const r = roundRef.current;
    if (skipFreeze && r.freezeEndTick !== null && tickRef.current < r.freezeEndTick) {
      tickRef.current = r.freezeEndTick;
      setUiTick(tickRef.current);
      dirty.current = true;
    }
  }, [skipFreeze]);

  // ---- control actions
  const seek = useCallback((t: number) => {
    const r = roundRef.current;
    const lo = optsRef.current.skipFreeze && r.freezeEndTick !== null ? r.freezeEndTick : r.startTick;
    tickRef.current = Math.min(Math.max(t, lo), r.endTick - 1);
    setUiTick(tickRef.current);
    dirty.current = true;
  }, []);

  const goRound = useCallback((rid: string, tick?: number) => {
    if (rid === roundRef.current.id) {
      if (tick !== undefined) seek(tick);
      return;
    }
    pendingTick.current = tick ?? null;
    setRoundId(rid);
  }, [seek]);

  const stepRound = useCallback((dir: 1 | -1) => {
    const list = optsRef.current.visibleRounds.length ? optsRef.current.visibleRounds : manifest.rounds;
    const cur = roundRef.current;
    // Navigate within the filtered list, by actual match order.
    const next = dir > 0 ? list.find((r) => r.displayNumber > cur.displayNumber) : [...list].reverse().find((r) => r.displayNumber < cur.displayNumber);
    if (next) goRound(next.id);
    return !!next;
  }, [goRound, manifest.rounds]);

  const jumpEvent = useCallback((dir: 1 | -1) => {
    const idx = indexRef.current;
    if (!idx) return;
    const e = nextEvent(idx.payload.events, Math.round(tickRef.current), dir, NAV_EVENTS);
    if (e) seek(e.tick);
  }, [seek]);

  const togglePlay = useCallback(() => setPlaying((p) => !p), []);
  const changeSpeed = useCallback((dir: 1 | -1) => {
    setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(s) + dir))]);
  }, []);

  const setFilters = useCallback((f: RoundFilters) => {
    setFiltersState(f);
    const vis = filterRounds(manifest.rounds, f);
    // Keep the current round if it still matches; otherwise move to the first match without stealing focus.
    if (vis.length && !vis.some((r) => r.id === roundRef.current.id)) goRound(vis[0].id);
  }, [manifest.rounds, goRound]);

  const zoom = useCallback((factor: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const pw = panelWidth(el.clientWidth, optsRef.current.floor === "split" ? map.floors.length : 1);
    viewport.current = zoomAt(viewport.current, map.imageSize, pw, el.clientHeight, pw / 2, el.clientHeight / 2, factor);
    dirty.current = true;
  }, [map.imageSize]);
  const resetView = useCallback(() => {
    viewport.current = { zoom: 1, cx: map.imageSize / 2, cy: map.imageSize / 2 };
    setFollow(false);
    dirty.current = true;
  }, [map.imageSize]);

  // ---- keyboard shortcuts (ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented && e.key !== " ") return;
      if (isTextInput(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("dialog[open]")) return;
      const r = roundRef.current;
      const rate = manifest.tickRate;
      const step = indexRef.current?.payload.sampleEveryTicks ?? 4;
      let handled = true;
      switch (e.key) {
        case " ": case "k": case "K": togglePlay(); break;
        case "ArrowLeft": seek(tickRef.current - (e.shiftKey ? step : SEEK_SECONDS * rate)); break;
        case "ArrowRight": seek(tickRef.current + (e.shiftKey ? step : SEEK_SECONDS * rate)); break;
        case "j": case "J": jumpEvent(-1); break;
        case "l": case "L": jumpEvent(1); break;
        case "[": stepRound(-1); break;
        case "]": stepRound(1); break;
        case ",": case "<": changeSpeed(-1); break;
        case ".": case ">": changeSpeed(1); break;
        case "Home": seek(r.startTick); break; // clamped to freeze end when skipping
        case "End": seek(r.endTick - 1); break;
        case "f": case "F": if (r.freezeEndTick !== null) seek(r.freezeEndTick); break;
        case "v": case "V":
          if (map.floors.length > 1) setFloor((f) => (f === "split" ? "auto" : f === "auto" ? 0 : f + 1 >= map.floors.length ? "split" : f + 1));
          break;
        case "+": case "=": zoom(1.25); break;
        case "-": case "_": zoom(0.8); break;
        case "0": resetView(); break;
        case "b": case "B": if (canReview) { setReviewOpen(true); setDockTab("bookmarks"); setComposeSignal((n) => n + 1); } break;
        case "n": case "N": if (canReview) { setReviewOpen(true); setDockTab("notes"); setComposeSignal((n) => n + 1); } break;
        case "d": case "D": setTool((t) => (t === "draw" ? "pan" : "draw")); break;
        case "?": setKbdOpen(true); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [manifest.tickRate, togglePlay, seek, jumpEvent, stepRound, changeSpeed, zoom, resetView, map.floors.length, canReview]);

  // ---- animation loop: advance the playhead, draw, drive audio
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const frameFn = (now: number) => {
      const dt = Math.min(250, now - last);
      last = now;
      const idx = indexRef.current;
      const r = roundRef.current;
      const o = optsRef.current;
      if (playingRef.current && idx) {
        let t = tickRef.current + (dt / 1000) * manifest.tickRate * speedRef.current;
        if (o.skipFreeze && r.freezeEndTick !== null && t < r.freezeEndTick) t = r.freezeEndTick;
        if (t >= r.endTick - 1) {
          t = r.endTick - 1;
          const list = o.visibleRounds.length ? o.visibleRounds : manifest.rounds;
          const next = list.find((x) => x.displayNumber > r.displayNumber);
          if (o.autoplay && next) {
            pendingTick.current = o.skipFreeze && next.freezeEndTick !== null ? next.freezeEndTick : next.startTick;
            setRoundId(next.id);
          } else {
            setPlaying(false);
          }
        }
        tickRef.current = t;
        dirty.current = true;
      }
      for (const s of syncs.current.values()) s.update(idx ? tickRef.current : 0, playingRef.current && !!idx, speedRef.current);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (canvas && wrap && idx && dirty.current) {
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const frame = frameAt(idx, tickRef.current);
        if (o.follow && o.selected) {
          const p = frame.players.find((x) => x.id === o.selected);
          if (p?.visible && p.alive) {
            const [ix, iy] = worldToImage(map, p.x, p.y);
            viewport.current = { ...viewport.current, cx: ix, cy: iy, zoom: Math.max(viewport.current.zoom, 1.6) };
          }
        }
        const ctx = canvas.getContext("2d")!;
        const common = {
          map, viewport: viewport.current, width: w, height: h, dpr, frame, players: playersRef.current, selected: o.selected,
          showNames: o.toggles.names, showTrails: o.toggles.trails, showUtility: o.toggles.utility, showDeaths: o.toggles.deaths,
          strokes: strokes.current.get(r.id), mutedRadar: o.mutedRadar,
        };
        if (o.floor === "split") {
          const floors = map.floors.map((_, i) => i);
          drawSplit(ctx, { ...common, floors, radars: floors.map((i) => radarImgs.current.get(i) ?? null) });
        } else {
          drawFrame(ctx, { ...common, floor: o.floor, radar: radarImgs.current.get(o.floor === "auto" ? 0 : o.floor) ?? null });
        }
        lastFrame.current = frame;
        dirty.current = playingRef.current;
      }
      if (now - lastUi > 100) {
        lastUi = now;
        setUiTick((u) => (Math.round(u) === Math.round(tickRef.current) ? u : tickRef.current));
      }
      raf = requestAnimationFrame(frameFn);
    };
    raf = requestAnimationFrame(frameFn);
    return () => cancelAnimationFrame(raf);
  }, [manifest.tickRate, manifest.rounds, map]);

  const playersRef = useRef(players);
  playersRef.current = players;
  const lastFrame = useRef<Frame | null>(null);
  useEffect(() => { dirty.current = true; }, [players, selected, follow, floor, toggles, index, mutedRadar, reviewOpen]);

  // redraw on resize
  useEffect(() => {
    const ro = new ResizeObserver(() => { dirty.current = true; });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // ---- pointer: pan, wheel zoom, click to select
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const drawing = useRef<Stroke | null>(null);
  /** Panel under a screen point: in side-by-side mode each floor has its own panel with a shared viewport. */
  const panelAt = (clientX: number) => {
    const el = wrapRef.current!;
    const rect = el.getBoundingClientRect();
    const n = floor === "split" ? map.floors.length : 1;
    const pw = panelWidth(el.clientWidth, n);
    const i = Math.min(n - 1, Math.max(0, Math.floor((clientX - rect.left) / pw)));
    return { pw, h: el.clientHeight, x0: rect.left + i * pw, y0: rect.top, floorIdx: floor === "split" ? i : null };
  };
  const toImage = (e: React.PointerEvent): [number, number] => {
    const g = panelAt(e.clientX);
    return screenToImage(viewport.current, map.imageSize, g.pw, g.h, e.clientX - g.x0, e.clientY - g.y0);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "draw") {
      const st: Stroke = { color: penColor, width: 3, points: [toImage(e)] };
      drawing.current = st;
      const list = strokes.current.get(round.id) ?? [];
      list.push(st);
      strokes.current.set(round.id, list);
      dirty.current = true;
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drawing.current) {
      drawing.current.points.push(toImage(e));
      dirty.current = true;
      return;
    }
    const d = drag.current;
    const el = wrapRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const s = (Math.min(panelAt(e.clientX).pw, el.clientHeight) / map.imageSize) * viewport.current.zoom;
    viewport.current = { ...viewport.current, cx: viewport.current.cx - dx / s, cy: viewport.current.cy - dy / s };
    setFollow(false);
    dirty.current = true;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drawing.current) {
      drawing.current = null;
      setStrokeCount((n) => n + 1);
      return;
    }
    const d = drag.current;
    drag.current = null;
    const el = wrapRef.current;
    if (!d || d.moved || !el || !lastFrame.current) return;
    const g = panelAt(e.clientX);
    const hit = playerAtPoint({
      map, viewport: viewport.current, width: g.pw, height: g.h, frame: lastFrame.current, players,
      selected, floor: g.floorIdx ?? (floor === "split" ? "auto" : floor), hideOffFloor: g.floorIdx !== null,
      showNames: true, showTrails: true, showUtility: true, showDeaths: true,
    }, e.clientX - g.x0, e.clientY - g.y0);
    setSelected(hit);
    if (!hit) setFollow(false);
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const n = optsRef.current.floor === "split" ? map.floors.length : 1;
      const pw = panelWidth(el.clientWidth, n);
      const i = Math.min(n - 1, Math.max(0, Math.floor((e.clientX - rect.left) / pw)));
      viewport.current = zoomAt(viewport.current, map.imageSize, pw, el.clientHeight, e.clientX - rect.left - i * pw, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      dirty.current = true;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [map.imageSize, map.floors.length]);

  const registerSync = useCallback((tid: string, s: AudioSync | null) => {
    if (s) syncs.current.set(tid, s);
    else syncs.current.delete(tid);
  }, []);

  // ---- derived UI state
  const payload = index?.payload ?? null;
  const clock = clockAt(manifest, round, payload, uiTick);
  const frameNow = index ? frameAt(index, uiTick) : null;
  const inventory = payload ? inventoryAt(payload, uiTick) : new Map<string, string[]>();
  const roundMs = tickToRoundMs(Math.round(uiTick), round, manifest.tickIntervalMs);
  const timelineFrom = skipFreeze && round.freezeEndTick !== null ? round.freezeEndTick : round.startTick;
  const shownMs = Math.max(0, Math.round((uiTick - timelineFrom) * manifest.tickIntervalMs));
  const scoreBefore = round.scoreBefore;
  const roundBookmarks = review.bookmarks.filter((b) => b.roundId === round.id && b.status !== "unavailable").map((b) => ({ id: b.id, tick: b.tick, title: b.title ?? "" }));
  const reviewTeams = teams;
  const playlistNav = usePlaylistNav(params, id, goRound);
  const roundOnly = viaShare && !!data.access.roundId;

  /**
   * Copy a link to one round. Owners and coaches get a round link anyone can open; other members
   * get a plain link that works for people who already have access to the replay.
   */
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const copyRoundLink = useCallback(async (rid: string) => {
    const n = manifest.rounds.find((r) => r.id === rid)?.displayNumber;
    const origin = window.location.origin;
    let url = buildReplayUrl(origin, id, rid);
    let who = "people who can already open this replay";
    try {
      if (viaShare && shareToken && (!data.access.roundId || data.access.roundId === rid)) {
        url = buildReplayUrl(origin, id, rid, undefined, shareToken);
        who = "anyone with the link";
      } else if (data.access.canManage && !viaShare) {
        const r = await api<{ token: string }>(`/api/replays/${id}/share`, { method: "POST", json: { roundId: rid } });
        url = buildReplayUrl(origin, id, rid, undefined, r.token);
        who = "anyone with the link, no account needed";
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not create the round link.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setToast(`Link to round ${n} copied. It opens for ${who}.`);
    } catch {
      window.prompt(`Link to round ${n}`, url);
    }
  }, [manifest.rounds, id, viaShare, shareToken, data.access.roundId, data.access.canManage]);

  const dockTabs: { id: DockTab; label: string; show: boolean }[] = [
    { id: "events", label: "Events", show: true },
    { id: "notes", label: `Notes${review.notes.length ? ` (${review.notes.length})` : ""}`, show: canReview },
    { id: "bookmarks", label: `Bookmarks${review.bookmarks.length ? ` (${review.bookmarks.length})` : ""}`, show: canReview },
    { id: "playlists", label: "Playlists", show: canReview },
    { id: "comms", label: "Comms", show: true },
  ];

  const T = manifest.teams;
  const clockEl = (
    <span className="tclock" data-phase={clock.phase} aria-live="off" title={clock.label}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 9V6.2M6.5 1.8h3M12.2 4.2l1-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      <span className="tclock-time mono">{clock.text}</span>
      <span className="sr-only">{clock.label}</span>
    </span>
  );
  return (
    <div className="ws ws-edge">
      <header className="ws-header">
        <Link href="/replays" className="btn btn-ghost btn-sm" aria-label="Back to library">‹ Back</Link>
        <span className="ws-map">{mapName(manifest.map.id)}</span>
        {data.series.length > 1 ? (
          <select className="select btn-sm" style={{ height: 28 }} aria-label="Series map" value={id}
            onChange={(e) => router.push(`/replays/${e.target.value}`)}>
            {data.series.map((s) => (
              <option key={s.id} value={s.id} disabled={s.status !== "ready"}>
                Map {s.mapIndex ?? "?"}: {mapName(s.mapId)}{s.scoreA !== null ? ` (${s.scoreA}–${s.scoreB})` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <div className="ws-teams" aria-label={`Score before round ${round.displayNumber}`}>
          <span className="ws-team"><span className={`side side-${round.sides.A}`}>{T.A.name}</span>{data.access.canManage ? <RenameTeam replayId={id} team="A" current={T.A.name} onDone={reload} /> : null}</span>
          <span className="ws-score" aria-live="off">{scoreBefore.A} : {scoreBefore.B}</span>
          <span className="ws-team"><span className={`side side-${round.sides.B}`}>{T.B.name}</span>{data.access.canManage ? <RenameTeam replayId={id} team="B" current={T.B.name} onDone={reload} /> : null}</span>
        </div>
        <HalfScores manifest={manifest} />
        <span className="muted" style={{ fontSize: 13 }}>
          Round {round.displayNumber}{round.isOvertime ? " · OT" : ""}{round.winner && uiTick >= (round.decidedTick ?? Infinity) ? ` · ${T[round.winner].name} won (${reasonText(round.endReason)})` : ""}
        </span>
        <span className="grow" />
        {manifest.sourceType === "pov" ? <span className="badge badge-warn" title="Point-of-view recording">POV · partial coverage</span> : null}
        {manifest.parser.synthetic ? <span className="badge badge-warn">Synthetic fixture</span> : null}
        {viaShare ? <span className="badge">{roundOnly ? `Round link · round ${round.displayNumber} only` : "Read-only link"}</span> : null}
        <span className="faint" style={{ fontSize: 12 }}>Final {manifest.finalScore.A}–{manifest.finalScore.B}</span>
        <button type="button" className="btn btn-sm" aria-pressed={reviewOpen} aria-expanded={reviewOpen} aria-controls="review-drawer"
          onClick={() => setReviewOpen((v) => !v)}>Review{review.notes.length + review.bookmarks.length ? ` (${review.notes.length + review.bookmarks.length})` : ""}</button>
        <button type="button" className="btn btn-ghost icon-btn" onClick={() => setKbdOpen(true)} aria-label="Keyboard shortcuts"><IconKeyboard /></button>
        <button type="button" className="btn btn-sm" onClick={() => { setPlaying(false); setShareOpen(true); }}><IconShare /> Share</button>
      </header>

      {playlistNav.bar}

      <div className="ws-body" data-review={reviewOpen}>
        <div className="ws-stage">
          <div className="radar-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} role="img"
              aria-label={`Radar of ${mapName(manifest.map.id)}, round ${round.displayNumber}, ${clock.label} ${clock.text}`}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={resetView}
              data-tool={tool} />
            {payload ? <KillFeed events={payload.events} tick={uiTick} windowTicks={Math.round(6 * manifest.tickRate)} players={players} /> : null}
            <div className="view-tools" role="toolbar" aria-label="View controls">
              <details className="tool-pop">
                <summary className="btn btn-ghost icon-btn btn-sm" aria-label="Display settings" title="Display settings"><IconLayers /></summary>
                <div className="tool-menu card">
                  {([["names", "Player names"], ["trails", "Grenade paths"], ["utility", "Utility"], ["deaths", "Death markers"]] as const).map(([k, l]) => (
                    <label key={k} className="row"><input type="checkbox" checked={toggles[k]} onChange={(e) => setToggles({ ...toggles, [k]: e.target.checked })} /> {l}</label>
                  ))}
                  <label className="row"><input type="checkbox" checked={mutedRadar} onChange={(e) => setMutedRadar(e.target.checked)} /> Muted radar</label>
                  <hr />
                  <label className="row"><input type="checkbox" checked={skipFreeze} onChange={(e) => setSkipFreeze(e.target.checked)} /> Skip freeze time</label>
                  <label className="row"><input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} /> Autoplay next round</label>
                </div>
              </details>
              <button type="button" className="btn btn-ghost icon-btn btn-sm" aria-pressed={tool === "pan"} onClick={() => setTool("pan")} aria-label="Pan and select tool" title="Pan / select">✋</button>
              <button type="button" className="btn btn-ghost icon-btn btn-sm" aria-pressed={tool === "draw"} onClick={() => setTool("draw")} aria-label="Draw tool (D)" title="Draw (D)"><IconEdit /></button>
              {tool === "draw" ? (
                <select className="select btn-sm" style={{ height: 26 }} aria-label="Pen colour" value={penColor} onChange={(e) => setPenColor(e.target.value)}>
                  {PEN_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              ) : null}
              <button type="button" className="btn btn-ghost icon-btn btn-sm" disabled={!strokeCount || !(strokes.current.get(round.id)?.length)}
                onClick={() => { strokes.current.delete(round.id); setStrokeCount((n) => n + 1); dirty.current = true; }}
                aria-label="Clear drawings on this round" title="Clear drawings"><IconClose /></button>
              <span className="tool-sep" aria-hidden="true" />
              <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => zoom(1.25)} aria-label="Zoom in"><IconZoomIn /></button>
              <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => zoom(0.8)} aria-label="Zoom out"><IconZoomOut /></button>
              <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={resetView} aria-label="Reset view"><IconFit /></button>
              <button type="button" className="btn btn-ghost btn-sm" aria-pressed={follow} disabled={!selected} onClick={() => setFollow(!follow)}
                title={selected ? "Keep the selected player centred" : "Select a player to follow"}>Follow</button>
              {map.floors.length > 1 ? (
                <select className="select btn-sm" style={{ height: 26 }} aria-label="Floor" value={String(floor)}
                  onChange={(e) => setFloor(e.target.value === "split" || e.target.value === "auto" ? e.target.value : Number(e.target.value))}>
                  <option value="split">Both floors side by side</option>
                  <option value="auto">Floors overlaid</option>
                  {map.floors.map((f, i) => <option key={f.id} value={i}>{f.label} floor</option>)}
                </select>
              ) : null}
            </div>
            {!index && !roundError ? <div className="radar-note" role="status">Loading round {round.displayNumber}…</div> : null}
            {roundError ? <div className="radar-note alert-err" role="alert">{roundError} <button className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>Retry</button></div> : null}
            {index && !radarImgs.current.get(0) ? (
              <div className="radar-note">Radar image not installed: positions drawn on a {manifest.map.calibration === "calibrated-unverified" ? "calibrated (unverified)" : "provisional"} 512-unit grid.</div>
            ) : null}
            {toast ? <div className="radar-toast" role="status">{toast}</div> : null}
            {notice ? <div className="radar-note" role="status">{notice} <button className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
          </div>

          <RoundStrip manifest={manifest} visible={visibleRounds} current={round.id} onSelect={(rid) => goRound(rid)} filters={filters} setFilters={setFilters}
            onCopyLink={copyRoundLink} roundOnly={roundOnly} />

          <div className="transport">
            <div className="transport-row" role="toolbar" aria-label="Playback controls">
              <div className="play-group">
                <button type="button" className="btn btn-primary icon-btn play-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} disabled={!index}>
                  {playing ? <IconPause /> : <IconPlay />}
                </button>
                <label className="sr-only" htmlFor="speed">Playback speed</label>
                <select id="speed" className="speed-badge" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
                </select>
              </div>
              {clockEl}
              <Timeline manifest={manifest} round={round} tick={uiTick} events={payload?.events ?? []} players={players} bookmarks={roundBookmarks} onSeek={seek}
                fromTick={timelineFrom} />
              <span className="mono muted elapsed" aria-label="Elapsed in round" title={`tick ${Math.round(uiTick)}`}>
                {Math.floor(shownMs / 60000)}:{String(Math.floor((shownMs % 60000) / 1000)).padStart(2, "0")}
              </span>
              <div className="step-group">
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => stepRound(-1)} aria-label="Previous round" title="Previous round ([)"><IconPrevRound /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => jumpEvent(-1)} aria-label="Previous event" title="Previous event (J)"><IconPrevEvent /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => seek(tickRef.current - SEEK_SECONDS * manifest.tickRate)} aria-label={`Back ${SEEK_SECONDS} seconds`}><IconBack /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => seek(tickRef.current + SEEK_SECONDS * manifest.tickRate)} aria-label={`Forward ${SEEK_SECONDS} seconds`}><IconForward /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => jumpEvent(1)} aria-label="Next event" title="Next event (L)"><IconNextEvent /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => stepRound(1)} aria-label="Next round" title="Next round (])"><IconNextRound /></button>
              </div>
            </div>
          </div>
        </div>

        <aside className="scoreboards" aria-label="Scoreboards">
          {(["A", "B"] as const).map((k) => (
            <TeamScoreboard key={k} manifest={manifest} round={round} team={k} frame={frameNow} players={players} inventory={inventory}
              selected={selected} onSelect={setSelected} />
          ))}
        </aside>

        {/* Kept mounted while closed so comms audio stays in sync. */}
        <aside className="dock" id="review-drawer" aria-label="Review" hidden={!reviewOpen}>
            <div className="dock-tabs" role="tablist">
              {dockTabs.filter((t) => t.show).map((t) => (
                <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={dockTab === t.id} onClick={() => setDockTab(t.id)}>
                  {t.label}
                </button>
              ))}
              <button type="button" className="dock-close" aria-label="Close review" onClick={() => setReviewOpen(false)}><IconClose width={14} height={14} /></button>
            </div>
            <div className="dock-panel" role="tabpanel" id={`panel-${dockTab}`} aria-labelledby={`tab-${dockTab}`}>
              {dockTab === "events" ? <EventsPanel manifest={manifest} round={round} events={(payload?.events ?? []).filter((e) => e.tick >= timelineFrom)} tick={uiTick} players={players} onSeek={seek} /> : null}
              {dockTab === "bookmarks" && canReview ? (
                <ReviewPanel kind="bookmark" manifest={manifest} replayId={id} round={round} tick={uiTick} items={review.bookmarks}
                  teams={reviewTeams} canReview={canReview} reload={review.reload} onOpen={goRound} composeSignal={composeSignal} />
              ) : null}
              {dockTab === "notes" && canReview ? (
                <ReviewPanel kind="note" manifest={manifest} replayId={id} round={round} tick={uiTick} items={review.notes}
                  teams={reviewTeams} canReview={canReview} reload={review.reload} onOpen={goRound} composeSignal={composeSignal} />
              ) : null}
              {dockTab === "playlists" && canReview ? <PlaylistPanel replayId={id} round={round} tick={uiTick} manifest={manifest} canReview={canReview} /> : null}
              <div hidden={dockTab !== "comms"}>
                <CommsPanel replayId={id} tickIntervalMs={manifest.tickIntervalMs} tick={uiTick} teams={teams} viaShare={viaShare} registerSync={registerSync} />
              </div>
              {manifest.warnings.length && dockTab === "events" ? (
                <details style={{ marginTop: 12 }}>
                  <summary className="faint" style={{ fontSize: 12 }}>Data notes ({manifest.warnings.length})</summary>
                  <ul className="faint" style={{ fontSize: 12 }}>{manifest.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </details>
              ) : null}
            </div>
        </aside>
      </div>

      <ShareDialog open={shareOpen} onClose={() => { setShareOpen(false); reload(); }} replayId={id} roundId={round.id} roundMs={roundMs}
        isOwner={data.access.via === "owner"} viaShare={viaShare} teams={teams} replayTeamId={data.replay.teamId} visibility={data.replay.visibility} onChanged={reload}
        roundNumber={round.displayNumber} canManage={data.access.canManage} onRoundLink={() => copyRoundLink(round.id)} />
      <ShortcutsDialog open={kbdOpen} onClose={() => setKbdOpen(false)} />
    </div>
  );
}

const PEN_COLORS = [
  { label: "White", value: "#f3f6fa" },
  { label: "Red", value: "#ff5d73" },
  { label: "Green", value: "#7fd18b" },
  { label: "Yellow", value: "#ffd84d" },
];

/** Score per half: regulation halves, then overtime in total. Each number carries the side that team played. */
function HalfScores({ manifest }: { manifest: Manifest }) {
  const groups: { label: string; rounds: RoundSummary[] }[] = [
    { label: "1st half", rounds: manifest.rounds.filter((r) => !r.isOvertime && r.half === 1) },
    { label: "2nd half", rounds: manifest.rounds.filter((r) => !r.isOvertime && r.half === 2) },
    { label: "Overtime", rounds: manifest.rounds.filter((r) => r.isOvertime) },
  ].filter((g) => g.rounds.length);
  // Score gained in a group = score after its last round minus score before its first round. This stays
  // correct for recordings that start mid-half (the "before" score comes from the in-game scoreboard).
  const won = (rs: RoundSummary[], k: "A" | "B") => rs[rs.length - 1].scoreAfter[k] - (rs[0].half === 1 && !rs[0].isOvertime ? 0 : rs[0].scoreBefore[k]);
  return (
    <span className="half-scores faint" aria-label={groups.map((g) => `${g.label} ${won(g.rounds, "A")} to ${won(g.rounds, "B")}`).join(", ")}>
      (
      {groups.map((g, i) => (
        <span key={g.label}>
          {i ? "; " : ""}
          {g.label === "Overtime" ? "OT " : ""}
          <span className={`sidecol-${g.rounds[0].sides.A}`}>{won(g.rounds, "A")}</span>:<span className={`sidecol-${g.rounds[0].sides.B}`}>{won(g.rounds, "B")}</span>
        </span>
      ))}
      )
    </span>
  );
}

function RenameTeam({ replayId, team, current, onDone }: { replayId: string; team: "A" | "B"; current: string; onDone: () => void }) {
  return (
    <button type="button" className="btn btn-ghost icon-btn btn-sm" aria-label={`Rename ${current}`} title="Rename team"
      onClick={async () => {
        const name = window.prompt(`Team name (leave empty to restore the name from the demo)`, current);
        if (name === null) return;
        await api(`/api/replays/${replayId}`, { method: "PATCH", json: team === "A" ? { teamAName: name.trim() || null } : { teamBName: name.trim() || null } });
        onDone();
      }}>
      <IconEdit width={12} height={12} />
    </button>
  );
}

/** In-radar kill feed: kills in the last few seconds of replay time, newest last. Deterministic for a tick. */
function KillFeed({ events, tick, windowTicks, players }: {
  events: import("@/shared/contract").GameEvent[]; tick: number; windowTicks: number; players: Map<string, PlayerInfo & { side: Side }>;
}) {
  const recent = events.filter((e) => e.type === "kill" && e.tick <= tick && e.tick > tick - windowTicks).slice(-5);
  if (!recent.length) return null;
  const nm = (id?: string | null) => (id ? players.get(id)?.name ?? "?" : "World");
  const sd = (id?: string | null) => (id ? players.get(id)?.side ?? "CT" : "CT");
  return (
    <div className="killfeed" aria-hidden="true">
      {recent.map((e) => (
        <div key={e.id} className="killfeed-row" data-fresh={tick - e.tick < windowTicks / 3}>
          {e.actor ? <span className={`side side-${sd(e.actor)}`}>{nm(e.actor)}</span> : null}
          {e.assister ? <span className={`assist side-text-${sd(e.assister)}`}>+ {nm(e.assister)}</span> : null}
          <WeaponIcon name={e.weapon} height={15} />
          <KillModifiers e={e} height={14} />
          <span className={`side side-${sd(e.target)}`}>{nm(e.target)}</span>
        </div>
      ))}
    </div>
  );
}

/** Playlist playback: ?pl=<playlist>&e=<entry> shows entry-to-entry navigation. */
function usePlaylistNav(params: ReturnType<typeof useSearchParams>, replayId: string, goRound: (r: string, t?: number) => void) {
  const router = useRouter();
  const pl = params.get("pl");
  const entryId = params.get("e");
  const [entries, setEntries] = useState<{ id: string; available: boolean; replayId?: string; roundId?: string; tick?: number; label: string | null; displayNumber?: number | null; roundStartTick?: number | null; tickIntervalMs?: number }[] | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!pl) return;
    api<{ playlist: { name: string }; entries: NonNullable<typeof entries> }>(`/api/playlists/${pl}`)
      .then((r) => { setEntries(r.entries); setName(r.playlist.name); })
      .catch(() => setEntries([]));
  }, [pl]);
  if (!pl || !entries) return { bar: null };
  const i = entries.findIndex((e) => e.id === entryId);
  const open = (j: number) => {
    const e = entries[j];
    if (!e?.available || !e.replayId || !e.roundId || e.tick === undefined) return;
    if (e.replayId === replayId) {
      goRound(e.roundId, e.tick);
      const u = new URL(window.location.href);
      u.searchParams.set("e", e.id);
      window.history.replaceState(window.history.state, "", u.toString());
      return;
    }
    const ms = e.roundStartTick != null && e.tickIntervalMs ? Math.round((e.tick - e.roundStartTick) * e.tickIntervalMs) : 0;
    router.push(`/replays/${e.replayId}?r=${e.roundId}&t=${ms}&pl=${pl}&e=${e.id}`);
  };
  const findNext = (dir: 1 | -1) => {
    for (let j = i + dir; j >= 0 && j < entries.length; j += dir) if (entries[j].available) return j;
    return -1;
  };
  const prev = findNext(-1);
  const next = findNext(1);
  return {
    bar: (
      <div className="ws-header" style={{ background: "var(--bg)", paddingTop: 6, paddingBottom: 6 }} role="navigation" aria-label="Playlist">
        <Link href={`/playlists/${pl}`} className="muted" style={{ fontSize: 13 }}>Playlist: {name}</Link>
        <span className="faint" style={{ fontSize: 13 }}>{i >= 0 ? `Moment ${i + 1} of ${entries.length}` : ""}{i >= 0 && entries[i].label ? ` · ${entries[i].label}` : ""}</span>
        <span className="grow" />
        <button type="button" className="btn btn-sm" disabled={prev < 0} onClick={() => open(prev)}>Previous moment</button>
        <button type="button" className="btn btn-sm" disabled={next < 0} onClick={() => open(next)}>Next moment</button>
      </div>
    ),
  };
}


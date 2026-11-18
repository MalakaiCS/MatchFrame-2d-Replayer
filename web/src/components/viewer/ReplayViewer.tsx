"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Manifest, PlayerInfo, RoundSummary, Side } from "@/shared/contract";
import { tickToRoundMs } from "@/shared/contract";
import type { AudioSync } from "@/viewer/audioSync";
import { clockAt } from "@/viewer/clock";
import { drawFrame, playerAtPoint } from "@/viewer/draw";
import { filterRounds, filtersFromParam, filtersToParam, type RoundFilters } from "@/viewer/filters";
import { getMapDef, mapName, type Viewport, worldToImage, zoomAt } from "@/viewer/maps";
import { frameAt, inventoryAt, nextEvent, type Frame, type RoundIndex } from "@/viewer/playback";
import { RoundCache } from "@/viewer/roundCache";
import { buildReplayUrl, resolveMoment, shareTokenFromHash } from "@/viewer/shareUrl";
import { api, ApiError, setShareToken } from "../api";
import {
  IconBack, IconFit, IconForward, IconKeyboard, IconLayers, IconNextEvent, IconNextRound, IconPause, IconPlay,
  IconPrevEvent, IconPrevRound, IconShare, IconZoomIn, IconZoomOut,
} from "../icons";
import { StatusBadge } from "../Library";
import { CommsPanel } from "./CommsPanel";
import { KillModifiers, WeaponIcon } from "./GameIcons";
import { EventsPanel, PlayersPanel, PlaylistPanel, ReviewPanel, useReview } from "./panels";
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
  access: { via: string; canManage: boolean; canReview: boolean; signedIn: boolean };
  manifest: Manifest | null;
  series: { id: string; mapIndex: number | null; mapId: string | null; status: string; scoreA: number | null; scoreB: number | null }[];
}

type DockTab = "players" | "events" | "notes" | "bookmarks" | "playlists" | "comms";

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

  if (loadError) {
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
  const [floor, setFloor] = useState<"auto" | number>("auto");
  const [autoplay, setAutoplay] = useState(true);
  const [skipFreeze, setSkipFreeze] = useState(false);
  const [toggles, setToggles] = useState({ names: true, trails: true, utility: true, deaths: true });
  const [dockTab, setDockTab] = useState<DockTab>("players");
  const [shareOpen, setShareOpen] = useState(false);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [composeSignal, setComposeSignal] = useState(0);
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
  const optsRef = useRef({ selected, follow, floor, toggles, autoplay, skipFreeze, visibleRounds });
  optsRef.current = { selected, follow, floor, toggles, autoplay, skipFreeze, visibleRounds };
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
        tickRef.current = Math.min(Math.max(want, round.startTick), round.endTick - 1);
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

  // ---- control actions
  const seek = useCallback((t: number) => {
    const r = roundRef.current;
    tickRef.current = Math.min(Math.max(t, r.startTick), r.endTick - 1);
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
    viewport.current = zoomAt(viewport.current, map.imageSize, el.clientWidth, el.clientHeight, el.clientWidth / 2, el.clientHeight / 2, factor);
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
        case "Home": seek(r.startTick); break;
        case "End": seek(r.endTick - 1); break;
        case "f": case "F": if (r.freezeEndTick !== null) seek(r.freezeEndTick); break;
        case "v": case "V":
          if (map.floors.length > 1) setFloor((f) => (f === "auto" ? 0 : f + 1 >= map.floors.length ? "auto" : f + 1));
          break;
        case "+": case "=": zoom(1.25); break;
        case "-": case "_": zoom(0.8); break;
        case "0": resetView(); break;
        case "b": case "B": if (canReview) { setDockTab("bookmarks"); setComposeSignal((n) => n + 1); } break;
        case "n": case "N": if (canReview) { setDockTab("notes"); setComposeSignal((n) => n + 1); } break;
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
        const floorShown = o.floor === "auto" ? "auto" : o.floor;
        const ctx = canvas.getContext("2d")!;
        drawFrame(ctx, {
          map, viewport: viewport.current, width: w, height: h, dpr, frame, players: playersRef.current, selected: o.selected,
          floor: floorShown, radar: radarImgs.current.get(o.floor === "auto" ? 0 : o.floor) ?? null,
          showNames: o.toggles.names, showTrails: o.toggles.trails, showUtility: o.toggles.utility, showDeaths: o.toggles.deaths,
        });
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
  useEffect(() => { dirty.current = true; }, [players, selected, follow, floor, toggles, index]);

  // redraw on resize
  useEffect(() => {
    const ro = new ResizeObserver(() => { dirty.current = true; });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // ---- pointer: pan, wheel zoom, click to select
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = wrapRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const s = (Math.min(el.clientWidth, el.clientHeight) / map.imageSize) * viewport.current.zoom;
    viewport.current = { ...viewport.current, cx: viewport.current.cx - dx / s, cy: viewport.current.cy - dy / s };
    setFollow(false);
    dirty.current = true;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const el = wrapRef.current;
    if (!d || d.moved || !el || !lastFrame.current) return;
    const rect = el.getBoundingClientRect();
    const hit = playerAtPoint({
      map, viewport: viewport.current, width: el.clientWidth, height: el.clientHeight, frame: lastFrame.current, players,
      selected, floor, showNames: true, showTrails: true, showUtility: true, showDeaths: true,
    }, e.clientX - rect.left, e.clientY - rect.top);
    setSelected(hit);
    if (!hit) setFollow(false);
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      viewport.current = zoomAt(viewport.current, map.imageSize, el.clientWidth, el.clientHeight, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      dirty.current = true;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [map.imageSize]);

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
  const scoreBefore = round.scoreBefore;
  const roundBookmarks = review.bookmarks.filter((b) => b.roundId === round.id && b.status !== "unavailable").map((b) => ({ id: b.id, tick: b.tick, title: b.title ?? "" }));
  const reviewTeams = teams;
  const playlistNav = usePlaylistNav(params, id, goRound);

  const dockTabs: { id: DockTab; label: string; show: boolean }[] = [
    { id: "players", label: "Players", show: true },
    { id: "events", label: "Events", show: true },
    { id: "notes", label: `Notes${review.notes.length ? ` (${review.notes.length})` : ""}`, show: canReview },
    { id: "bookmarks", label: `Bookmarks${review.bookmarks.length ? ` (${review.bookmarks.length})` : ""}`, show: canReview },
    { id: "playlists", label: "Playlists", show: canReview },
    { id: "comms", label: "Comms", show: true },
  ];

  const T = manifest.teams;
  return (
    <div className="ws">
      <header className="ws-header">
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
          <span className="ws-team"><span className={`side side-${round.sides.A}`}>{T.A.name}</span></span>
          <span className="ws-score" aria-live="off">{scoreBefore.A} : {scoreBefore.B}</span>
          <span className="ws-team"><span className={`side side-${round.sides.B}`}>{T.B.name}</span></span>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          Round {round.displayNumber}{round.isOvertime ? " · OT" : ""}{round.winner && uiTick >= (round.decidedTick ?? Infinity) ? ` · ${T[round.winner].name} won (${reasonText(round.endReason)})` : ""}
        </span>
        <span className="grow" />
        {manifest.sourceType === "pov" ? <span className="badge badge-warn" title="Point-of-view recording">POV · partial coverage</span> : null}
        {manifest.parser.synthetic ? <span className="badge badge-warn">Synthetic fixture</span> : null}
        {viaShare ? <span className="badge">Read-only link</span> : null}
        <span className="faint" style={{ fontSize: 12 }}>Final {manifest.finalScore.A}–{manifest.finalScore.B}</span>
        <button type="button" className="btn btn-ghost icon-btn" onClick={() => setKbdOpen(true)} aria-label="Keyboard shortcuts"><IconKeyboard /></button>
        <button type="button" className="btn" onClick={() => { setPlaying(false); setShareOpen(true); }}><IconShare /> Share</button>
      </header>

      {playlistNav.bar}

      <div className="ws-body">
        <div className="ws-stage">
          <div className="radar-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} role="img"
              aria-label={`Radar of ${mapName(manifest.map.id)}, round ${round.displayNumber}, ${clock.label} ${clock.text}`}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={resetView} />
            <div className="radar-overlay">
              <div className="clock" data-phase={clock.phase} aria-live="off">
                <span className="clock-time">{clock.text}</span>
                <span className="clock-label">{clock.label}</span>
              </div>
              <div className="view-tools" role="toolbar" aria-label="View controls">
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => zoom(1.25)} aria-label="Zoom in"><IconZoomIn /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => zoom(0.8)} aria-label="Zoom out"><IconZoomOut /></button>
                <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={resetView} aria-label="Reset view"><IconFit /></button>
                {map.floors.length > 1 ? (
                  <select className="select btn-sm" style={{ height: 26 }} aria-label="Floor" value={String(floor)}
                    onChange={(e) => setFloor(e.target.value === "auto" ? "auto" : Number(e.target.value))}>
                    <option value="auto">All floors</option>
                    {map.floors.map((f, i) => <option key={f.id} value={i}>{f.label} floor</option>)}
                  </select>
                ) : null}
                <details style={{ position: "relative" }}>
                  <summary className="btn btn-ghost icon-btn btn-sm" aria-label="Layers"><IconLayers /></summary>
                  <div className="card" style={{ position: "absolute", right: 0, top: 30, zIndex: 5, width: 200 }}>
                    {([["names", "Player names"], ["trails", "Grenade paths"], ["utility", "Utility"], ["deaths", "Death markers"]] as const).map(([k, l]) => (
                      <label key={k} className="row" style={{ fontSize: 13, padding: "2px 0" }}>
                        <input type="checkbox" checked={toggles[k]} onChange={(e) => setToggles({ ...toggles, [k]: e.target.checked })} /> {l}
                      </label>
                    ))}
                  </div>
                </details>
              </div>
            </div>
            {payload ? <KillFeed events={payload.events} tick={uiTick} windowTicks={Math.round(6 * manifest.tickRate)} players={players} /> : null}
            {!index && !roundError ? <div className="radar-note" role="status">Loading round {round.displayNumber}…</div> : null}
            {roundError ? <div className="radar-note alert-err" role="alert">{roundError} <button className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>Retry</button></div> : null}
            {index && !radarImgs.current.get(0) ? (
              <div className="radar-note">Radar image not installed: positions drawn on a {manifest.map.calibration === "calibrated-unverified" ? "calibrated (unverified)" : "provisional"} 512-unit grid.</div>
            ) : null}
            {notice ? <div className="radar-note" style={{ bottom: 40 }} role="status">{notice} <button className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
          </div>

          <div className="transport">
            <Timeline manifest={manifest} round={round} tick={uiTick} events={payload?.events ?? []} players={players} bookmarks={roundBookmarks} onSeek={seek} />
            <div className="transport-row" role="toolbar" aria-label="Playback controls">
              <button type="button" className="btn btn-ghost icon-btn" onClick={() => stepRound(-1)} aria-label="Previous round"><IconPrevRound /></button>
              <button type="button" className="btn btn-ghost icon-btn" onClick={() => jumpEvent(-1)} aria-label="Previous event"><IconPrevEvent /></button>
              <button type="button" className="btn btn-ghost icon-btn" onClick={() => seek(tickRef.current - SEEK_SECONDS * manifest.tickRate)} aria-label={`Back ${SEEK_SECONDS} seconds`}><IconBack /></button>
              <button type="button" className="btn btn-primary icon-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} disabled={!index}>
                {playing ? <IconPause /> : <IconPlay />}
              </button>
              <button type="button" className="btn btn-ghost icon-btn" onClick={() => seek(tickRef.current + SEEK_SECONDS * manifest.tickRate)} aria-label={`Forward ${SEEK_SECONDS} seconds`}><IconForward /></button>
              <button type="button" className="btn btn-ghost icon-btn" onClick={() => jumpEvent(1)} aria-label="Next event"><IconNextEvent /></button>
              <button type="button" className="btn btn-ghost icon-btn" onClick={() => stepRound(1)} aria-label="Next round"><IconNextRound /></button>
              <label className="sr-only" htmlFor="speed">Playback speed</label>
              <select id="speed" className="select speed-select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              <span className="mono muted" style={{ fontSize: 12, marginLeft: 6 }} aria-label="Elapsed in round">
                {Math.floor(roundMs / 60000)}:{String(Math.floor((roundMs % 60000) / 1000)).padStart(2, "0")} elapsed · tick {Math.round(uiTick)}
              </span>
              <span className="grow" />
              <label className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={skipFreeze} onChange={(e) => setSkipFreeze(e.target.checked)} /> Skip freeze time</label>
              <label className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} /> Autoplay next round</label>
            </div>
          </div>

          <RoundStrip manifest={manifest} visible={visibleRounds} current={round.id} onSelect={(rid) => goRound(rid)} filters={filters} setFilters={setFilters} />
        </div>

        <aside className="dock" aria-label="Replay details">
          <div className="dock-tabs" role="tablist">
            {dockTabs.filter((t) => t.show).map((t) => (
              <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={dockTab === t.id} onClick={() => setDockTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="dock-panel" role="tabpanel" id={`panel-${dockTab}`} aria-labelledby={`tab-${dockTab}`}>
            {dockTab === "players" ? (
              <PlayersPanel manifest={manifest} round={round} frame={frameNow} players={players} inventory={inventory}
                selected={selected} follow={follow} onSelect={setSelected} onFollow={setFollow} />
            ) : null}
            {dockTab === "events" ? <EventsPanel manifest={manifest} round={round} events={payload?.events ?? []} tick={uiTick} players={players} onSeek={seek} /> : null}
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
        isOwner={data.access.via === "owner"} viaShare={viaShare} teams={teams} replayTeamId={data.replay.teamId} visibility={data.replay.visibility} onChanged={reload} />
      <ShortcutsDialog open={kbdOpen} onClose={() => setKbdOpen(false)} />
    </div>
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


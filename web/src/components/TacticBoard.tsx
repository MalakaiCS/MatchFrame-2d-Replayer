"use client";
/**
 * Tactic board: drag players and utility onto a map, draw paths and arrows, add labels. Saves
 * automatically (personal or team boards). Positions are radar-image pixels.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMapDef, listMaps, mapName, type MapDef } from "@/viewer/maps";
import { api, ApiError } from "./api";

type Kind = "ct" | "t" | "smoke" | "flash" | "molotov" | "he" | "bomb" | "text";
interface Token { id: string; kind: Kind; x: number; y: number; label?: string }
interface Stroke { color: string; width: number; arrow?: boolean; points: [number, number][] }
interface Step { label?: string; pos: Record<string, [number, number]> }
interface Data { floor: number; tokens: Token[]; strokes: Stroke[]; steps?: Step[] }

/** Where a token is at a (fractional) step: step 0 is the base layout; later steps override positions. */
export function posAt(d: Data, t: Token, at: number): [number, number] {
  const at0 = Math.floor(at);
  const find = (s: number): [number, number] => {
    for (let i = s; i >= 1; i--) { const p = d.steps?.[i - 1]?.pos[t.id]; if (p) return p; }
    return [t.x, t.y];
  };
  const a = find(at0);
  const f = at - at0;
  if (f <= 0 || at0 >= (d.steps?.length ?? 0)) return a;
  const b = find(at0 + 1);
  // Ease in-out between steps.
  const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
}
interface Board { id: string; name: string; mapId: string; teamId: string | null; data: Data; version: number; mine: boolean }

const COLORS = ["#f3f6fa", "#ff5d73", "#ffd84d", "#7fd18b"];
const STYLE: Record<Kind, { fill: string; r: number; text?: string }> = {
  ct: { fill: "#38c6e8", r: 11 }, t: { fill: "#f2a93b", r: 11 },
  smoke: { fill: "rgba(214,222,230,0.55)", r: 36 }, flash: { fill: "rgba(255,242,122,0.85)", r: 9 },
  molotov: { fill: "rgba(255,110,60,0.5)", r: 26 }, he: { fill: "rgba(127,209,139,0.8)", r: 9 },
  bomb: { fill: "#ef6b6b", r: 9, text: "C4" }, text: { fill: "transparent", r: 14 },
};
const uid = () => Math.random().toString(36).slice(2, 10);

type Tool = { type: "move" } | { type: "place"; kind: Kind; label?: string } | { type: "pen"; arrow: boolean } | { type: "erase" };

export function TacticBoardEditor({ id }: { id: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "unsaved">("saved");
  const [tool, setTool] = useState<Tool>({ type: "move" });
  const [color, setColor] = useState(COLORS[0]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<Data>({ floor: 0, tokens: [], strokes: [] });
  const versionRef = useRef(0);
  const dragRef = useRef<{ token?: Token; stroke?: Stroke } | null>(null);
  // Current step (0 = base layout) and, while playing, the fractional animation position.
  const [step, setStep] = useState(0);
  const [anim, setAnim] = useState<number | null>(null);
  const [, force] = useState(0);
  const redraw = () => force((n) => n + 1);

  useEffect(() => {
    api<Board>(`/api/tactics/${id}`).then((b) => {
      setBoard(b);
      dataRef.current = b.data;
      versionRef.current = b.version;
    }).catch((e) => setError(e instanceof Error ? e.message : "Could not open the board."));
  }, [id]);

  const map: MapDef | null = board ? getMapDef(board.mapId) : null;
  useEffect(() => {
    if (!map) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = `/radars/${map.id}${map.floors[dataRef.current.floor]?.imageSuffix ?? ""}.png`;
  }, [map, board?.data.floor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave a second after the last change.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback(async (extra: { name?: string } = {}) => {
    setSaved("saving");
    try {
      const r = await api<{ version: number }>(`/api/tactics/${id}`, { method: "PUT", json: { ...extra, data: dataRef.current, version: versionRef.current } });
      versionRef.current = r.version;
      setSaved("saved");
    } catch (e) {
      setSaved("unsaved");
      setError(e instanceof ApiError && e.status === 409 ? "Someone else changed this board. Reload to see their version." : e instanceof Error ? e.message : "Could not save.");
    }
  }, [id]);
  const changed = () => {
    setSaved("unsaved");
    redraw();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 1000);
  };

  // Draw.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !map) return;
    const S = c.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = S * dpr;
    c.height = S * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = S / map.imageSize;
    ctx.fillStyle = "#080b0f";
    ctx.fillRect(0, 0, S, S);
    if (img) ctx.drawImage(img, 0, 0, S, S);
    const d = dataRef.current;
    for (const st of d.strokes) {
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
      ctx.stroke();
      if (st.arrow && st.points.length > 1) {
        const [x1, y1] = st.points[st.points.length - 2];
        const [x2, y2] = st.points[st.points.length - 1];
        const a = Math.atan2(y2 - y1, x2 - x1);
        ctx.fillStyle = st.color;
        ctx.beginPath();
        ctx.moveTo(x2 * k, y2 * k);
        ctx.lineTo(x2 * k - 12 * Math.cos(a - 0.45), y2 * k - 12 * Math.sin(a - 0.45));
        ctx.lineTo(x2 * k - 12 * Math.cos(a + 0.45), y2 * k - 12 * Math.sin(a + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    }
    // Utility first, players on top.
    const order: Kind[] = ["smoke", "molotov", "flash", "he", "bomb", "ct", "t", "text"];
    for (const kind of order) {
      for (const t of d.tokens.filter((x) => x.kind === kind)) {
        const s = STYLE[t.kind];
        const [px, py] = posAt(d, t, anim ?? step);
        const x = px * k;
        const y = py * k;
        if (t.kind === "text") {
          ctx.font = "700 13px ui-sans-serif, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tw = ctx.measureText(t.label ?? "").width;
          ctx.fillStyle = "rgba(8,11,15,0.85)";
          ctx.fillRect(x - tw / 2 - 6, y - 11, tw + 12, 22);
          ctx.fillStyle = "#f3f6fa";
          ctx.fillText(t.label ?? "", x, y + 0.5);
          continue;
        }
        // Smokes and fires use their in-game radius (world units) at the map's scale.
        const r = kind === "smoke" ? (144 / map.scale) * k : kind === "molotov" ? (120 / map.scale) * k : s.r;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(6, r), 0, Math.PI * 2);
        ctx.fillStyle = s.fill;
        ctx.fill();
        if (kind === "ct" || kind === "t" || kind === "bomb") {
          ctx.strokeStyle = "#0b1016";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = "#0b1016";
          ctx.font = "800 11px ui-sans-serif, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(s.text ?? t.label ?? "", x, y + 0.5);
        }
      }
    }
  });

  const toImage = (e: React.PointerEvent): [number, number] => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const k = map!.imageSize / rect.width;
    return [(e.clientX - rect.left) * k, (e.clientY - rect.top) * k];
  };
  const hit = (x: number, y: number) => {
    const k = map ? (canvasRef.current!.clientWidth / map.imageSize) : 1;
    const d = dataRef.current;
    for (let i = d.tokens.length - 1; i >= 0; i--) {
      const t = d.tokens[i];
      const rr = t.kind === "smoke" ? 144 / map!.scale : t.kind === "molotov" ? 120 / map!.scale : Math.max(STYLE[t.kind].r, 12) / k;
      const [px, py] = posAt(d, t, step);
      if (Math.hypot(px - x, py - y) <= rr) return t;
    }
    return null;
  };
  const onDown = (e: React.PointerEvent) => {
    if (!map || !board) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toImage(e);
    const d = dataRef.current;
    if (tool.type === "place") {
      let label = tool.label;
      if (tool.kind === "text") {
        label = window.prompt("Label", "") ?? "";
        if (!label.trim()) return;
      }
      d.tokens.push({ id: uid(), kind: tool.kind, x, y, label });
      changed();
      return;
    }
    if (tool.type === "erase") {
      const t = hit(x, y);
      if (t) d.tokens = d.tokens.filter((q) => q !== t);
      else {
        const k = map.imageSize / canvasRef.current!.clientWidth;
        d.strokes = d.strokes.filter((st) => !st.points.some(([px, py]) => Math.hypot(px - x, py - y) < 10 * k));
      }
      changed();
      return;
    }
    if (tool.type === "pen") {
      const st: Stroke = { color, width: 3, arrow: tool.arrow, points: [[x, y]] };
      d.strokes.push(st);
      dragRef.current = { stroke: st };
      return;
    }
    const t = hit(x, y);
    if (t) dragRef.current = { token: t };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    const [x, y] = toImage(e);
    if (g.token) {
      // In a step, moving a token records its position for that step only.
      if (step > 0) {
        const steps = (dataRef.current.steps ??= []);
        steps[step - 1].pos[g.token.id] = [x, y];
      } else { g.token.x = x; g.token.y = y; }
      redraw();
    }
    if (g.stroke) {
      const last = g.stroke.points[g.stroke.points.length - 1];
      if (Math.hypot(last[0] - x, last[1] - y) > 3) { g.stroke.points.push([x, y]); redraw(); }
    }
  };
  const onUp = () => {
    const g = dragRef.current;
    dragRef.current = null;
    if (!g) return;
    if (g.stroke && g.stroke.points.length < 2) dataRef.current.strokes = dataRef.current.strokes.filter((s) => s !== g.stroke);
    changed();
  };

  if (error && !board) return <div className="page"><p className="alert alert-err" role="alert">{error}</p><Link className="btn" href="/tactics">All boards</Link></div>;
  if (!board || !map) return <div className="page"><p className="muted">Loading board…</p></div>;

  const placeBtn = (kind: Kind, label: string, text?: string) => (
    <button type="button" className="chip" aria-pressed={tool.type === "place" && tool.kind === kind && tool.label === text}
      onClick={() => setTool({ type: "place", kind, label: text })}>{label}</button>
  );
  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <p className="ms-eyebrow"><Link href="/tactics">Tactic boards</Link> · {mapName(board.mapId)}</p>
      <div className="ms-head">
        <input className="input tb-name" aria-label="Board name" defaultValue={board.name}
          onBlur={(e) => { if (e.target.value.trim() && e.target.value !== board.name) void save({ name: e.target.value.trim() }); }} />
        <span className="faint" style={{ fontSize: 12 }} aria-live="polite">{saved === "saved" ? "All changes saved" : saved === "saving" ? "Saving…" : "Unsaved changes"}</span>
      </div>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      <div className="tb-layout">
        <div className="tb-tools card">
          <div className="ins-group" role="group" aria-label="Tool">
            <button type="button" className="chip" aria-pressed={tool.type === "move"} onClick={() => setTool({ type: "move" })}>Move</button>
            <button type="button" className="chip" aria-pressed={tool.type === "pen" && !tool.arrow} onClick={() => setTool({ type: "pen", arrow: false })}>Pen</button>
            <button type="button" className="chip" aria-pressed={tool.type === "pen" && tool.arrow} onClick={() => setTool({ type: "pen", arrow: true })}>Arrow</button>
            <button type="button" className="chip" aria-pressed={tool.type === "erase"} onClick={() => setTool({ type: "erase" })}>Erase</button>
          </div>
          <div className="ins-group" role="group" aria-label="Pen colour">
            {COLORS.map((c) => <button key={c} type="button" className="tb-swatch" style={{ background: c }} aria-pressed={color === c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />)}
          </div>
          <span className="faint" style={{ fontSize: 12 }}>CT players</span>
          <div className="ins-group">{[1, 2, 3, 4, 5].map((n) => <span key={n}>{placeBtn("ct", `CT ${n}`, String(n))}</span>)}</div>
          <span className="faint" style={{ fontSize: 12 }}>T players</span>
          <div className="ins-group">{[1, 2, 3, 4, 5].map((n) => <span key={n}>{placeBtn("t", `T ${n}`, String(n))}</span>)}</div>
          <span className="faint" style={{ fontSize: 12 }}>Utility</span>
          <div className="ins-group">
            {placeBtn("smoke", "Smoke")}{placeBtn("flash", "Flash")}{placeBtn("molotov", "Molotov")}{placeBtn("he", "HE")}{placeBtn("bomb", "Bomb")}{placeBtn("text", "Label")}
          </div>
          {map.floors.length > 1 ? (
            <select className="select btn-sm" aria-label="Floor" value={dataRef.current.floor} onChange={(e) => { dataRef.current.floor = Number(e.target.value); setBoard({ ...board, data: { ...dataRef.current } }); changed(); }}>
              {map.floors.map((f, i) => <option key={f.id} value={i}>{f.label} floor</option>)}
            </select>
          ) : null}
          <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (confirm("Clear everything on this board?")) { dataRef.current.tokens = []; dataRef.current.strokes = []; changed(); } }}>Clear board</button>
          <p className="faint" style={{ fontSize: 12, margin: 0 }}>Pick a token, then click the map to place it. Move drags tokens; Erase removes a token or a line.</p>
        </div>
        <div className="tb-main">
        <StepBar
          steps={dataRef.current.steps ?? []} step={step} playing={anim !== null}
          onSelect={(s) => { setAnim(null); setStep(s); }}
          onAdd={() => {
            const steps = (dataRef.current.steps ??= []);
            if (steps.length >= 20) return;
            steps.push({ pos: {} });
            setStep(steps.length);
            changed();
          }}
          onRemove={() => {
            const steps = dataRef.current.steps ?? [];
            if (!step || !steps.length) return;
            steps.splice(step - 1, 1);
            setStep(Math.min(step, steps.length));
            changed();
          }}
          onLabel={(label) => {
            const s = dataRef.current.steps?.[step - 1];
            if (s) { s.label = label.slice(0, 60) || undefined; changed(); }
          }}
          onPlay={() => {
            const n = dataRef.current.steps?.length ?? 0;
            if (!n) return;
            const t0 = performance.now();
            const tick = (now: number) => {
              const at = Math.min(n, (now - t0) / 1500);
              setAnim(at);
              if (at < n) requestAnimationFrame(tick);
              else { setAnim(null); setStep(n); }
            };
            requestAnimationFrame(tick);
          }}
        />
        <canvas ref={canvasRef} className="tb-canvas" role="img" aria-label={`${mapName(board.mapId)} tactic board`} data-tool={tool.type}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
        </div>
      </div>
    </div>
  );
}

interface BoardItem { id: string; name: string; mapId: string; teamId: string | null; teamName: string | null; updatedAt: string; mine: boolean; ownerName: string }

export function TacticBoardList() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardItem[] | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string; role: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ boards: BoardItem[] }>("/api/tactics").then((r) => setBoards(r.boards)).catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.push("/login?next=/tactics");
      else setError(e instanceof Error ? e.message : "Could not load boards.");
    });
    api<{ teams: { id: string; name: string; role: string }[] }>("/api/teams").then((r) => setTeams(r.teams.filter((t) => t.role !== "viewer"))).catch(() => {});
  }, [router]);
  useEffect(() => load(), [load]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ id: string }>("/api/tactics", { method: "POST", json: { name: String(f.get("name") || "New board"), mapId: f.get("map"), teamId: String(f.get("team") || "") || null } });
      router.push(`/tactics/${r.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the board.");
    }
  }
  async function remove(id: string) {
    if (!confirm("Delete this board?")) return;
    await api(`/api/tactics/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <h1>Tactic boards</h1>
      <p className="page-sub">Plan executes, setups and retakes on the map. Team boards are shared with everyone on the team. Tip: in a replay, “Board” copies the current positions onto a new board.</p>
      <form className="row wrap card" onSubmit={create} style={{ marginBottom: 16 }}>
        <label className="sr-only" htmlFor="tb-new-name">Board name</label>
        <input id="tb-new-name" className="input grow" name="name" placeholder="e.g. B execute (Mirage)" maxLength={120} />
        <label className="sr-only" htmlFor="tb-new-map">Map</label>
        <select id="tb-new-map" className="select" name="map" defaultValue="de_mirage">{listMaps().map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>
        <label className="sr-only" htmlFor="tb-new-team">Where</label>
        <select id="tb-new-team" className="select" name="team" defaultValue="">
          <option value="">Personal board</option>
          {teams.map((t) => <option key={t.id} value={t.id}>Team: {t.name}</option>)}
        </select>
        <button className="btn btn-primary">New board</button>
      </form>
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {boards === null ? <p className="muted">Loading…</p> : boards.length === 0 ? <div className="empty">No boards yet.</div> : (
        <div className="replay-list">
          {boards.map((b) => (
            <div key={b.id} className="replay-row">
              <Link className="replay-item" href={`/tactics/${b.id}`} style={{ gridTemplateColumns: "96px 1fr auto" }}>
                <div className="map-tile"><span style={{ marginLeft: 0 }}>{mapName(b.mapId)}</span></div>
                <div>
                  <div className="replay-title">{b.name}</div>
                  <div className="replay-meta"><span>{b.teamName ? `Team: ${b.teamName}` : "Personal"}</span><span>by {b.mine ? "you" : b.ownerName}</span><span>Updated {new Date(b.updatedAt).toLocaleString()}</span></div>
                </div>
                <span />
              </Link>
              {b.mine ? <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => remove(b.id)}>Delete</button> : <span />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Step bar: base layout, then numbered steps; play animates through them. */
function StepBar({ steps, step, playing, onSelect, onAdd, onRemove, onLabel, onPlay }: {
  steps: Step[]; step: number; playing: boolean;
  onSelect: (s: number) => void; onAdd: () => void; onRemove: () => void; onLabel: (l: string) => void; onPlay: () => void;
}) {
  return (
    <div className="tb-steps" role="toolbar" aria-label="Animation steps">
      <button type="button" className="btn btn-sm btn-primary" disabled={!steps.length || playing} onClick={onPlay} title="Animate through the steps">
        {playing ? "Playing…" : "▶ Play"}
      </button>
      <div className="ins-group" role="group" aria-label="Steps">
        <button type="button" className="chip" aria-pressed={step === 0} onClick={() => onSelect(0)}>Start</button>
        {steps.map((s, i) => (
          <button key={i} type="button" className="chip" aria-pressed={step === i + 1} onClick={() => onSelect(i + 1)} title={s.label ?? `Step ${i + 1}`}>
            {s.label ? `${i + 1}. ${s.label}` : `Step ${i + 1}`}
          </button>
        ))}
        <button type="button" className="chip" onClick={onAdd} disabled={steps.length >= 20}>+ Step</button>
      </div>
      {step > 0 ? (
        <>
          <input className="input btn-sm" style={{ height: 28, maxWidth: 200 }} aria-label="Step label" placeholder="Label, e.g. Smokes land"
            key={step} defaultValue={steps[step - 1]?.label ?? ""} onBlur={(e) => onLabel(e.target.value.trim())} />
          <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={onRemove}>Remove step</button>
          <span className="faint" style={{ fontSize: 12 }}>Drag players to where they are in this step.</span>
        </>
      ) : <span className="faint" style={{ fontSize: 12 }}>Set up the start, then add steps and move players in each.</span>}
    </div>
  );
}

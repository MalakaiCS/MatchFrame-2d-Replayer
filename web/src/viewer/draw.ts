/**
 * Canvas 2D radar renderer. World coordinates are transformed to original
 * radar-image pixels first (maps.ts), then through the viewport (pan/zoom),
 * then scaled by devicePixelRatio.
 *
 * Side markers pair colour with shape: CT = circle, T = triangle. Off-floor
 * players are drawn hollow with an up/down glyph. Estimated smoke and fire
 * areas are drawn as soft clouds and labelled "est." at high zoom.
 */
import type { PlayerInfo, Side } from "@/shared/contract";
import { imageToScreen, type MapDef, type Viewport, worldToImage, yawToCanvas, fitScale } from "./maps";
import type { Frame } from "./playback";

/** Freehand annotation in original radar-image pixels, so it stays attached to the map when panning/zooming. */
export interface Stroke {
  color: string;
  width: number;
  points: [number, number][];
}

export interface DrawOptions {
  map: MapDef;
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
  frame: Frame;
  players: Map<string, PlayerInfo & { side: Side }>;
  selected: string | null;
  /** "auto" draws every floor; a number draws that floor and marks others off-floor. */
  floor: "auto" | number;
  radar: HTMLImageElement | null;
  showNames: boolean;
  showTrails: boolean;
  showUtility: boolean;
  showDeaths: boolean;
  strokes?: Stroke[];
  /** Panel origin (CSS px) when several floors are drawn side by side. */
  offsetX?: number;
  /** Side-by-side mode: draw only what is on `floor` (no hollow off-floor markers). */
  hideOffFloor?: boolean;
  /** Caption drawn at the top of the panel (e.g. "Upper", "Lower"). */
  panelLabel?: string;
  /** Draw the radar image desaturated and darker so markers stand out. */
  mutedRadar?: boolean;
}

export interface SplitOptions extends Omit<DrawOptions, "floor" | "radar" | "offsetX" | "hideOffFloor" | "panelLabel"> {
  /** Floors to draw side by side, left to right, each with its own radar image. */
  floors: number[];
  radars: (HTMLImageElement | null)[];
}

/** Width of one panel when `n` floors are shown side by side. */
export function panelWidth(width: number, n: number): number {
  return width / Math.max(1, n);
}

/** Every floor of a multi-level map at once: one panel per floor, sharing pan and zoom. */
export function drawSplit(ctx: CanvasRenderingContext2D, o: SplitOptions) {
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  const pw = panelWidth(o.width, o.floors.length);
  o.floors.forEach((f, i) => {
    drawFrame(ctx, {
      ...o, width: pw, offsetX: i * pw, floor: f, radar: o.radars[i] ?? null, hideOffFloor: true,
      panelLabel: o.map.floors[f]?.label,
    });
  });
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.strokeStyle = "rgba(154, 168, 184, 0.35)";
  ctx.lineWidth = 1;
  for (let i = 1; i < o.floors.length; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.round(i * pw) + 0.5, 0);
    ctx.lineTo(Math.round(i * pw) + 0.5, o.height);
    ctx.stroke();
  }
}

export const COLORS = {
  CT: "#38c6e8",
  T: "#f2a93b",
  smoke: "rgba(183, 194, 207, 0.42)",
  smokeEdge: "rgba(220, 228, 236, 0.75)",
  fire: "rgba(255, 93, 115, 0.35)",
  fireEdge: "rgba(255, 93, 115, 0.85)",
  flash: "rgba(255, 255, 255, 0.85)",
  he: "rgba(255, 210, 120, 0.9)",
  grid: "rgba(120, 140, 160, 0.10)",
  bomb: "#ef6b6b",
  text: "#e6edf4",
};

export function drawFrame(ctx: CanvasRenderingContext2D, o: DrawOptions) {
  const { map, viewport: v, width: w, height: h, dpr } = o;
  ctx.setTransform(dpr, 0, 0, dpr, dpr * (o.offsetX ?? 0), 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.clearRect(0, 0, w, h);
  const s = fitScale(map.imageSize, w, h) * v.zoom; // screen px per image px
  const toScreen = (x: number, y: number) => {
    const [px, py] = worldToImage(map, x, y);
    return imageToScreen(v, map.imageSize, w, h, px, py);
  };
  const units = (worldUnits: number) => (worldUnits / map.scale) * s;

  // --- background
  const [x0, y0] = imageToScreen(v, map.imageSize, w, h, 0, 0);
  const size = map.imageSize * s;
  if (o.radar && o.radar.complete && o.radar.naturalWidth) {
    ctx.imageSmoothingQuality = "high";
    if (o.mutedRadar) ctx.filter = "grayscale(0.85) brightness(0.7)";
    ctx.drawImage(o.radar, x0, y0, size, size);
    ctx.filter = "none";
  } else {
    ctx.fillStyle = "#121a23";
    ctx.fillRect(x0, y0, size, size);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    const step = (512 / map.scale) * s; // 512 world units
    ctx.beginPath();
    for (let gx = x0; gx <= x0 + size + 0.5; gx += step) { ctx.moveTo(gx, y0); ctx.lineTo(gx, y0 + size); }
    for (let gy = y0; gy <= y0 + size + 0.5; gy += step) { ctx.moveTo(x0, gy); ctx.lineTo(x0 + size, gy); }
    ctx.stroke();
  }

  const onFloor = (floor: number) => o.floor === "auto" || o.floor === floor;
  const floorOfZ = (z: number) => {
    let idx = 0;
    map.floors.forEach((f, i) => { if (i > 0 && f.zMax !== undefined && z < f.zMax) idx = i; });
    return idx;
  };

  // --- utility effects
  if (o.showUtility) {
    for (const ef of o.frame.effects) {
      const e = ef.effect;
      const [cx, cy] = toScreen(e.position.x, e.position.y);
      const dim = !onFloor(floorOfZ(e.position.z));
      if (dim && o.hideOffFloor) continue;
      ctx.globalAlpha = dim ? 0.3 : 1;
      if (e.kind === "smoke") {
        const r = units(e.radius);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        // Disrupted (cleared) regions are cut out of the smoke with an even-odd clip.
        for (const d of ef.disruptions) {
          const [dx, dy] = toScreen(d.position.x, d.position.y);
          ctx.moveTo(dx + units(d.radius), dy);
          ctx.arc(dx, dy, units(d.radius), 0, Math.PI * 2, true);
        }
        const sg = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
        sg.addColorStop(0, "rgba(214, 222, 230, 0.78)");
        sg.addColorStop(0.75, "rgba(190, 200, 210, 0.62)");
        sg.addColorStop(1, "rgba(170, 182, 194, 0.18)");
        ctx.fillStyle = sg;
        ctx.fill("evenodd");
        for (const d of ef.disruptions) {
          const [dx, dy] = toScreen(d.position.x, d.position.y);
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.arc(dx, dy, units(d.radius), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
        if (v.zoom >= 2) label(ctx, cx, cy + r + 10, ef.disruptions.length ? "smoke · cleared (inferred)" : "smoke (est.)", 10);
      } else if (e.kind === "fire") {
        const r = units(e.radius);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        const fg = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
        fg.addColorStop(0, "rgba(255, 196, 92, 0.75)");
        fg.addColorStop(0.6, "rgba(255, 110, 60, 0.55)");
        fg.addColorStop(1, "rgba(255, 70, 70, 0.12)");
        ctx.fillStyle = fg;
        ctx.fill();
        if (v.zoom >= 2) label(ctx, cx, cy + r + 10, "fire (est.)", 10);
      } else {
        const p = ef.progress ?? 0;
        const r = Math.max(4, units(e.kind === "he" ? 160 : 120) * (0.4 + 0.6 * p));
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = e.kind === "flash" ? COLORS.flash : e.kind === "he" ? COLORS.he : "rgba(200,200,200,0.6)";
        ctx.globalAlpha = (dim ? 0.3 : 1) * (1 - p);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // --- grenades in flight
  if (o.showUtility) {
    for (const g of o.frame.grenades) {
      if (o.hideOffFloor && !onFloor(floorOfZ(g.position.z))) continue;
      const thrower = g.throwerId ? o.players.get(g.throwerId) : undefined;
      const col = thrower ? COLORS[thrower.side] : "#ccc";
      if (o.showTrails && g.trail.length > 1) {
        ctx.beginPath();
        g.trail.forEach(([x, y], i) => {
          const [sx, sy] = toScreen(x, y);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        const [hx, hy] = toScreen(g.position.x, g.position.y);
        ctx.lineTo(hx, hy);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      const [gx, gy] = toScreen(g.position.x, g.position.y);
      ctx.beginPath();
      ctx.arc(gx, gy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = g.type === "smoke" ? "#dfe6ee" : g.type === "flash" ? "#ffffff" : g.type === "he" ? "#ffd278" : g.type === "decoy" ? "#999" : "#ff5d73";
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // --- death markers
  if (o.showDeaths) {
    for (const d of o.frame.deaths) {
      if (o.hideOffFloor && !onFloor(floorOfZ(d.position.z))) continue;
      const pl = o.players.get(d.playerId);
      const [dx, dy] = toScreen(d.position.x, d.position.y);
      const col = pl ? COLORS[pl.side] : "#999";
      ctx.globalAlpha = onFloor(floorOfZ(d.position.z)) ? 0.85 : 0.3;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      const k = 5;
      ctx.beginPath();
      ctx.moveTo(dx - k, dy - k); ctx.lineTo(dx + k, dy + k);
      ctx.moveTo(dx + k, dy - k); ctx.lineTo(dx - k, dy + k);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // --- bomb on the ground
  const b = o.frame.bomb;
  const bombHere = !b.position || !o.hideOffFloor || onFloor(floorOfZ(b.position.z));
  if (bombHere && b.position && (b.state === "dropped" || b.state === "planted" || b.state === "defusing" || b.state === "defused" || b.state === "exploded")) {
    const [bx, by] = toScreen(b.position.x, b.position.y);
    ctx.fillStyle = b.state === "defused" ? COLORS.CT : COLORS.bomb;
    ctx.strokeStyle = "#0b1016";
    ctx.lineWidth = 1.5;
    roundRect(ctx, bx - 7, by - 5, 14, 10, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#0b1016";
    ctx.font = "bold 8px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("C4", bx, by + 0.5);
    if (b.state === "planted" || b.state === "defusing") {
      ctx.beginPath();
      ctx.arc(bx, by, 12, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.bomb;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // --- players (alive and visible)
  const order = [...o.frame.players].sort((a, b2) => (a.id === o.selected ? 1 : 0) - (b2.id === o.selected ? 1 : 0));
  for (const p of order) {
    if (!p.visible || !p.alive) continue;
    const info = o.players.get(p.id);
    if (!info) continue;
    const [px, py] = toScreen(p.x, p.y);
    const col = COLORS[info.side];
    const off = !onFloor(p.floor);
    if (off && o.hideOffFloor) continue;
    const r = 7;
    ctx.globalAlpha = off ? 0.45 : 1;
    // view direction
    const a = yawToCanvas(map, p.yaw);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, r + 13, a - 0.38, a + 0.38);
    ctx.closePath();
    ctx.fillStyle = info.side === "CT" ? "rgba(56,198,232,0.22)" : "rgba(242,169,59,0.22)";
    ctx.fill();
    // body: CT circle, T triangle
    ctx.beginPath();
    if (info.side === "CT") ctx.arc(px, py, r, 0, Math.PI * 2);
    else {
      ctx.moveTo(px, py - r - 1);
      ctx.lineTo(px + r + 0.5, py + r - 1);
      ctx.lineTo(px - r - 0.5, py + r - 1);
      ctx.closePath();
    }
    if (off) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = "#0b1016";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (p.flags & 1) {
      // bomb carrier
      ctx.fillStyle = COLORS.bomb;
      ctx.fillRect(px + r - 2, py - r - 2, 6, 6);
    }
    if (p.id === o.selected) {
      ctx.beginPath();
      ctx.arc(px, py, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = "#f3f6fa";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (off) label(ctx, px, py - r - 8, map.floors.length > 1 && p.floor > (o.floor as number) ? "↓" : "↑", 11);
    if (o.showNames) nameTag(ctx, px, py + r + 12, info.name, col, p.id === o.selected);
    ctx.globalAlpha = 1;
  }

  // --- annotations (drawn last, on top)
  for (const st of o.strokes ?? []) {
    if (st.points.length < 2) continue;
    ctx.beginPath();
    st.points.forEach(([px, py], i) => {
      const [sx, sy] = imageToScreen(v, map.imageSize, w, h, px, py);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    ctx.stroke();
  }

  if (o.panelLabel) {
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(230, 237, 244, 0.85)";
    ctx.fillText(`${o.panelLabel} floor`, w / 2, 10);
  }
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, size: number) {
  ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(11,16,22,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(text, x, y);
}

/** Boxed player name under the marker: dark box, side-coloured top edge. */
function nameTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, side: string, selected: boolean) {
  ctx.font = "700 10.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width;
  const bw = tw + 8;
  const bh = 14;
  roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, 2);
  ctx.fillStyle = selected ? "rgba(243, 246, 250, 0.95)" : "rgba(8, 12, 17, 0.82)";
  ctx.fill();
  ctx.fillStyle = side;
  ctx.fillRect(x - bw / 2, y - bh / 2, bw, 1.5);
  ctx.fillStyle = selected ? "#0b1016" : COLORS.text;
  ctx.fillText(text, x, y + 0.5);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Hit-test players at a screen point (CSS pixels). */
export function playerAtPoint(o: Omit<DrawOptions, "dpr" | "radar">, sx: number, sy: number): string | null {
  const only = o.hideOffFloor && typeof o.floor === "number" ? o.floor : null;
  let best: string | null = null;
  let bestD = 14;
  for (const p of o.frame.players) {
    if (!p.visible || !p.alive) continue;
    if (only !== null && p.floor !== only) continue;
    const [ix, iy] = worldToImage(o.map, p.x, p.y);
    const [px, py] = imageToScreen(o.viewport, o.map.imageSize, o.width, o.height, ix, iy);
    const d = Math.hypot(px - sx, py - sy);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

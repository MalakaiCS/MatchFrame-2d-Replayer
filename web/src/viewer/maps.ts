/**
 * Map registry and coordinate transforms.
 * World (Hammer units) -> original radar image pixels -> viewport (pan/zoom) -> device pixels.
 */
import registry from "@/shared/maps.json";

export interface FloorDef {
  id: string;
  label: string;
  zMax?: number;
  imageSuffix?: string;
}

export interface MapDef {
  id: string;
  displayName: string;
  status: string;
  imageSize: number;
  originX: number;
  originY: number;
  scale: number;
  rotationDeg: number;
  assetVersion: string;
  floors: FloorDef[];
  floorUncertaintyBand?: number;
}

export const REGISTRY_VERSION: string = registry.registryVersion;

export function getMapDef(id: string): MapDef | null {
  const e = (registry.maps as Record<string, Omit<MapDef, "id">>)[id];
  return e ? { id, ...e } : null;
}

export function listMaps(): MapDef[] {
  return Object.keys(registry.maps).map((id) => getMapDef(id)!);
}

export function mapName(id: string | null | undefined): string {
  if (!id) return "Unknown map";
  return getMapDef(id)?.displayName ?? id;
}

export function worldToImage(m: MapDef, x: number, y: number): [number, number] {
  let px = (x - m.originX) / m.scale;
  let py = (m.originY - y) / m.scale;
  if (m.rotationDeg) {
    const c = m.imageSize / 2;
    const r = (m.rotationDeg * Math.PI) / 180;
    const dx = px - c;
    const dy = py - c;
    px = c + dx * Math.cos(r) - dy * Math.sin(r);
    py = c + dx * Math.sin(r) + dy * Math.cos(r);
  }
  return [px, py];
}

export function imageToWorld(m: MapDef, px: number, py: number): [number, number] {
  return [px * m.scale + m.originX, m.originY - py * m.scale];
}

/** CS yaw (degrees, 0 = +X, counter-clockwise) to a canvas angle in image space (y down). */
export function yawToCanvas(m: MapDef, yawDeg: number): number {
  return (-(yawDeg + 0) * Math.PI) / 180 + (m.rotationDeg * Math.PI) / 180;
}

export interface Viewport {
  /** Zoom factor relative to "fit". */
  zoom: number;
  /** Image-space point at the viewport centre. */
  cx: number;
  cy: number;
}

export function fitScale(imageSize: number, w: number, h: number): number {
  return Math.min(w, h) / imageSize;
}

export function imageToScreen(v: Viewport, imageSize: number, w: number, h: number, px: number, py: number): [number, number] {
  const s = fitScale(imageSize, w, h) * v.zoom;
  return [w / 2 + (px - v.cx) * s, h / 2 + (py - v.cy) * s];
}

export function screenToImage(v: Viewport, imageSize: number, w: number, h: number, sx: number, sy: number): [number, number] {
  const s = fitScale(imageSize, w, h) * v.zoom;
  return [(sx - w / 2) / s + v.cx, (sy - h / 2) / s + v.cy];
}

/** Zoom around a screen point, keeping that point fixed. */
export function zoomAt(v: Viewport, imageSize: number, w: number, h: number, sx: number, sy: number, factor: number): Viewport {
  const zoom = Math.min(8, Math.max(0.5, v.zoom * factor));
  const [ix, iy] = screenToImage(v, imageSize, w, h, sx, sy);
  const s = fitScale(imageSize, w, h) * zoom;
  return { zoom, cx: ix - (sx - w / 2) / s, cy: iy - (sy - h / 2) / s };
}

export function floorForZ(m: MapDef, z: number): number {
  let idx = 0;
  m.floors.forEach((f, i) => {
    if (i > 0 && f.zMax !== undefined && z < f.zMax) idx = i;
  });
  return idx;
}

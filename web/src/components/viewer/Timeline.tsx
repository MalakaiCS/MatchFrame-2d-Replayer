"use client";
import type { GameEvent, Manifest, PlayerInfo, RoundSummary } from "@/shared/contract";
import { formatMs } from "@/viewer/clock";

/** Planted-bomb window: plant tick to defuse/explosion (or round end when neither was recorded). */
export function bombWindow(events: GameEvent[], round: RoundSummary): [number, number] | null {
  const plant = events.find((e) => e.type === "bomb_plant");
  if (!plant) return null;
  const end = events.find((e) => e.tick >= plant.tick && (e.type === "bomb_defuse" || e.type === "bomb_explode"));
  return [plant.tick, end?.tick ?? round.endTick - 1];
}

export interface TimelineBookmark { id: string; tick: number; title: string }

export function Timeline({
  manifest, round, tick, events, players, bookmarks, onSeek, fromTick, winLine,
}: {
  /** CT win probability over the round (drawn as a line in the track). */
  winLine?: { tick: number; p: number }[];
  /** First tick shown (freeze end when freeze time is skipped). */
  fromTick?: number;
  manifest: Manifest;
  round: RoundSummary;
  tick: number;
  events: GameEvent[];
  players: Map<string, PlayerInfo & { side: "CT" | "T" }>;
  bookmarks: TimelineBookmark[];
  onSeek: (tick: number) => void;
}) {
  const from = fromTick ?? round.startTick;
  const span = Math.max(1, round.endTick - 1 - from);
  const pct = (t: number) => `${((t - from) / span) * 100}%`;
  const elapsed = (t: number) => formatMs((t - from) * manifest.tickIntervalMs);
  const name = (id?: string | null) => (id ? players.get(id)?.name ?? "?" : "World");
  const markers = events.filter((e) => e.tick >= from && (e.type === "kill" || e.type === "bomb_plant" || e.type === "bomb_defuse" || e.type === "bomb_explode"));
  const shownBookmarks = bookmarks.filter((b) => b.tick >= from);

  const secs = span * manifest.tickIntervalMs / 1000;
  const grid: number[] = [];
  for (let sec = 10; sec < secs; sec += 10) grid.push((sec / secs) * 100);
  const bw = bombWindow(events, round);

  return (
    <div className="timeline">
      <div className="timeline-track" aria-hidden="true">
        {grid.map((g) => <span key={g} className="timeline-grid" style={{ left: `${g}%` }} />)}
        <span className="timeline-played" style={{ width: pct(Math.max(from, tick)) }} />
        {bw ? (() => {
          const a = Math.max(bw[0], from);
          return (
            <div className="timeline-bomb" style={{ left: pct(a), width: `calc(${pct(bw[1])} - ${pct(a)})` }}>
              <span>Bomb</span>
            </div>
          );
        })() : null}
        {winLine && winLine.length > 1 ? (
          <svg className="timeline-wp" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" x2="1000" y1="50" y2="50" />
            <polyline points={winLine.filter((w) => w.tick >= from).map((w) => `${(((w.tick - from) / span) * 1000).toFixed(1)},${((1 - w.p) * 100).toFixed(1)}`).join(" ")} />
          </svg>
        ) : null}
        <span className="timeline-head" style={{ left: pct(Math.max(from, tick)) }} />
      </div>
      <label className="sr-only" htmlFor="round-scrubber">Round timeline</label>
      <input id="round-scrubber" type="range" min={from} max={round.endTick - 1} step={1} value={Math.round(tick)}
        aria-valuetext={`${elapsed(tick)} into round ${round.displayNumber}`}
        onChange={(e) => onSeek(Number(e.target.value))}
        onKeyDown={(e) => {
          // Let global shortcuts own arrows/space; the slider still supports Home/End/PageUp/PageDown.
          if (["ArrowLeft", "ArrowRight", " ", "ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
        }} />
      <div className="timeline-markers">
        {round.freezeEndTick !== null && round.freezeEndTick > from ? (
          <button type="button" className="tmark" data-kind="freeze" style={{ left: pct(round.freezeEndTick) }}
            aria-label={`Freeze time ends at ${elapsed(round.freezeEndTick)}`} title="Freeze time ends" onClick={() => onSeek(round.freezeEndTick!)} />
        ) : null}
        {markers.map((e) => {
          const victim = e.target ? players.get(e.target) : undefined;
          const kind = e.type === "kill" ? `kill-${victim?.side ?? "CT"}` : "bomb";
          const text = e.type === "kill"
            ? `${name(e.actor)} killed ${name(e.target)}${e.weapon ? ` with ${e.weapon}` : ""}${e.headshot ? " (headshot)" : ""}`
            : e.type === "bomb_plant" ? `Bomb planted${e.site ? ` at ${e.site}` : ""}` : e.type === "bomb_defuse" ? "Bomb defused" : "Bomb exploded";
          return (
            <button type="button" key={e.id} className="tmark" data-kind={kind} style={{ left: pct(e.tick) }}
              aria-label={`${text} at ${elapsed(e.tick)}`} title={`${elapsed(e.tick)} · ${text}`} onClick={() => onSeek(e.tick)} />
          );
        })}
        {shownBookmarks.map((b) => (
          <button type="button" key={b.id} className="tmark" data-kind="bookmark" style={{ left: pct(b.tick) }}
            aria-label={`Bookmark: ${b.title}`} title={`Bookmark · ${b.title}`} onClick={() => onSeek(b.tick)} />
        ))}
      </div>
    </div>
  );
}

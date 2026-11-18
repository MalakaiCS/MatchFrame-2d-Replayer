"use client";
import type { GameEvent, Manifest, PlayerInfo, RoundSummary } from "@/shared/contract";
import { formatMs } from "@/viewer/clock";

export interface TimelineBookmark { id: string; tick: number; title: string }

export function Timeline({
  manifest, round, tick, events, players, bookmarks, onSeek,
}: {
  manifest: Manifest;
  round: RoundSummary;
  tick: number;
  events: GameEvent[];
  players: Map<string, PlayerInfo & { side: "CT" | "T" }>;
  bookmarks: TimelineBookmark[];
  onSeek: (tick: number) => void;
}) {
  const span = round.endTick - 1 - round.startTick;
  const pct = (t: number) => `${((t - round.startTick) / span) * 100}%`;
  const elapsed = (t: number) => formatMs((t - round.startTick) * manifest.tickIntervalMs);
  const name = (id?: string | null) => (id ? players.get(id)?.name ?? "?" : "World");
  const markers = events.filter((e) => e.type === "kill" || e.type === "bomb_plant" || e.type === "bomb_defuse" || e.type === "bomb_explode");

  return (
    <div className="timeline">
      <div className="timeline-markers">
        {round.freezeEndTick !== null ? (
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
        {bookmarks.map((b) => (
          <button type="button" key={b.id} className="tmark" data-kind="bookmark" style={{ left: pct(b.tick) }}
            aria-label={`Bookmark: ${b.title}`} title={`Bookmark · ${b.title}`} onClick={() => onSeek(b.tick)} />
        ))}
      </div>
      <label className="sr-only" htmlFor="round-scrubber">Round timeline</label>
      <input id="round-scrubber" type="range" min={round.startTick} max={round.endTick - 1} step={1} value={Math.round(tick)}
        aria-valuetext={`${elapsed(tick)} into round ${round.displayNumber}`}
        onChange={(e) => onSeek(Number(e.target.value))}
        onKeyDown={(e) => {
          // Let global shortcuts own arrows/space; the slider still supports Home/End/PageUp/PageDown.
          if (["ArrowLeft", "ArrowRight", " ", "ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
        }} />
    </div>
  );
}

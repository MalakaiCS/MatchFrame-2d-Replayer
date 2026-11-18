"use client";
import { useEffect, useRef, useState } from "react";
import type { Manifest, RoundSummary, TeamKey } from "@/shared/contract";
import { BUY_LABELS, BUY_OPTIONS, EMPTY_FILTERS, isEmpty, type RoundFilters, type RoundKind } from "@/viewer/filters";

const REASON: Record<string, string> = {
  bomb_exploded: "bomb exploded", target_bombed: "bomb exploded", bomb_defused: "bomb defused",
  ct_killed: "CTs eliminated", t_killed: "Ts eliminated", target_saved: "time ran out", ct_win: "CT win", t_win: "T win",
};

export function reasonText(r: string | null) {
  if (!r) return "";
  return REASON[r] ?? r.replace(/_/g, " ");
}

export function RoundStrip({
  manifest, visible, current, onSelect, filters, setFilters,
}: {
  manifest: Manifest;
  visible: RoundSummary[];
  current: string;
  onSelect: (id: string) => void;
  filters: RoundFilters;
  setFilters: (f: RoundFilters) => void;
}) {
  const [open, setOpen] = useState(true);
  const stripRef = useRef<HTMLDivElement>(null);
  const t = manifest.teams;

  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-round="${current}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const chip = (pressed: boolean, onClick: () => void, label: string, aria?: string) => (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick} aria-label={aria}>{label}</button>
  );
  const hasEcon = manifest.capabilities.economy;

  return (
    <section className="rounds collapsible" data-open={open} aria-label="Rounds">
      <div className="rounds-head">
        <strong style={{ fontSize: 13 }}>Rounds</strong>
        <span className="faint" style={{ fontSize: 12 }} aria-live="polite">
          {isEmpty(filters) ? `${manifest.rounds.length} rounds` : `${visible.length} of ${manifest.rounds.length} rounds match`}
        </span>
        {!isEmpty(filters) ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button> : null}
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm collapse-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide rounds" : "Show rounds"}
        </button>
      </div>
      <div className="collapsible-body">
        <div className="filters" role="group" aria-label="Round filters">
          <fieldset>
            <legend>Type</legend>
            {(["pistol", "gun"] as RoundKind[]).map((k) =>
              chip(filters.kind.includes(k), () => setFilters({ ...filters, kind: toggle(filters.kind, k) }), k === "pistol" ? "Pistol" : "Gun rounds"))}
          </fieldset>
          <fieldset>
            <legend>Buy</legend>
            <select className="select btn-sm" style={{ height: 26 }} aria-label="Team for buy filter" value={filters.buyTeam}
              onChange={(e) => setFilters({ ...filters, buyTeam: e.target.value as RoundFilters["buyTeam"] })} disabled={!hasEcon}>
              <option value="either">Either team</option>
              <option value="A">{t.A.name}</option>
              <option value="B">{t.B.name}</option>
            </select>
            {BUY_OPTIONS.map((b) =>
              chip(filters.buy.includes(b), () => setFilters({ ...filters, buy: toggle(filters.buy, b) }), BUY_LABELS[b]))}
          </fieldset>
          <fieldset>
            <legend>Side</legend>
            {(["A", "B"] as TeamKey[]).flatMap((k) => (["CT", "T"] as const).map((s) =>
              chip(filters.side?.team === k && filters.side.side === s,
                () => setFilters({ ...filters, side: filters.side?.team === k && filters.side.side === s ? null : { team: k, side: s } }),
                `${t[k].name} ${s}`)))}
          </fieldset>
          <fieldset>
            <legend>Won by</legend>
            {(["A", "B"] as TeamKey[]).map((k) => chip(filters.winner.includes(k), () => setFilters({ ...filters, winner: toggle(filters.winner, k) }), t[k].name))}
          </fieldset>
          <fieldset>
            <legend>More</legend>
            {chip(filters.overtime === "only", () => setFilters({ ...filters, overtime: filters.overtime === "only" ? "all" : "only" }), "Overtime")}
            {chip(filters.bomb === "planted", () => setFilters({ ...filters, bomb: filters.bomb === "planted" ? "any" : "planted" }), "Bomb planted")}
          </fieldset>
        </div>
        {!hasEcon ? <p className="faint" style={{ fontSize: 12, padding: "0 12px", margin: "0 0 6px" }}>This demo has no equipment values, so buy filters match only “Unknown”.</p> : null}
        <div className="round-strip" ref={stripRef} role="list">
          {visible.length === 0 ? <p className="faint" style={{ margin: "6px 0" }}>No rounds match these filters.</p> : null}
          {visible.map((r, i) => {
            const prev = visible[i - 1];
            const halfStart = !!prev && prev.half !== r.half;
            const winnerName = r.winner ? t[r.winner].name : "no winner";
            return (
              <div role="listitem" key={r.id}>
                <button type="button" className="round-chip" data-round={r.id} aria-current={r.id === current}
                  data-half-start={halfStart} onClick={() => onSelect(r.id)}
                  aria-label={`Round ${r.displayNumber}${r.isOvertime ? " (overtime)" : ""}${r.isPistol ? " (pistol)" : ""}: ${winnerName} won as ${r.winnerSide ?? "?"}, ${reasonText(r.endReason)}. Score after: ${r.scoreAfter.A}–${r.scoreAfter.B}`}
                  title={`Round ${r.displayNumber} · ${winnerName} · ${reasonText(r.endReason)} · ${r.scoreAfter.A}–${r.scoreAfter.B}`}>
                  <span className="rn">{r.displayNumber}</span>
                  {r.winnerSide ? <span className="rw" data-side={r.winnerSide} /> : <span className="rtag">–</span>}
                  {r.isPistol ? <span className="rtag">P</span> : r.isOvertime ? <span className="rtag">OT</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

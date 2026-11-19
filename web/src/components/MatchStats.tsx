"use client";
/**
 * Match page: per-player stats (K/D/A, ADR, KAST, HS%, opening duels, clutches, multi-kills, utility,
 * Rating 1.0), team summaries, an economy chart and the round history. Filters by side and half.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Manifest, RoundSummary, Side, TeamKey } from "@/shared/contract";
import { normalizeBuyType } from "@/shared/contract";
import { BUY_LABELS } from "@/viewer/filters";
import { mapName } from "@/viewer/maps";
import { shareTokenFromHash } from "@/viewer/shareUrl";
import {
  derive, hasPlayerStats, playerTotals, roundHighlights, roundMatches, teamTotals,
  type PlayerTotals, type StatsFilter,
} from "@/viewer/stats";
import { api, ApiError, setShareToken } from "./api";
import { reasonText } from "./viewer/RoundStrip";

interface ReplayResponse {
  replay: { id: string; title: string | null; sourceAvailable: boolean };
  access: { via: string };
  manifest: Manifest | null;
}

type SortKey = "rating" | "k" | "d" | "a" | "diff" | "adr" | "kast" | "hs" | "open" | "clutch" | "ud" | "ef";
const buyLabel = (v: string | null) => {
  const b = normalizeBuyType(v);
  return b === "pistol" ? "Pistol" : b ? BUY_LABELS[b] : "Unknown";
};
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`);
const fixed = (v: number | null, d = 1) => (v === null ? "—" : v.toFixed(d));

export function MatchStats({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [filter, setFilter] = useState<StatsFilter>({ side: "all", half: "all" });
  const [hash, setHash] = useState("");

  useEffect(() => {
    const tok = shareTokenFromHash(window.location.hash);
    setShareToken(tok);
    setHash(tok ? window.location.hash : "");
    api<ReplayResponse>(`/api/replays/${id}`).then(setData).catch((e) => {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401) router.replace(`/login?next=${encodeURIComponent(`/replays/${id}/stats`)}`);
      setError({ status, message: e instanceof Error ? e.message : "Could not load the match." });
    });
  }, [id, router]);

  const m = data?.manifest ?? null;
  const players = useMemo(() => (m ? playerTotals(m, filter) : []), [m, filter]);
  const teams = useMemo(() => (m ? teamTotals(m, filter) : null), [m, filter]);

  if (error) {
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <h1>{error.status === 402 ? "This match needs a plan" : "Match unavailable"}</h1>
        <p className="page-sub">{error.message}</p>
        {error.status === 402 ? <Link className="btn btn-primary" href="/billing">See plans</Link> : <Link className="btn" href="/replays">Go to demos</Link>}
      </div>
    );
  }
  if (!data) return <div className="page"><p className="muted">Loading match…</p></div>;
  if (!m) return <div className="page"><p className="muted">This demo is still processing.</p></div>;

  const T = m.teams;
  const hasDamage = !!m.capabilities.damage;
  const replayHref = (roundId?: string) => `/replays/${id}${roundId ? `?r=${roundId}` : ""}${hash}`;
  const shownRounds = m.rounds.filter((r) => roundMatches(r, filter));
  const anyOt = m.rounds.some((r) => r.isOvertime);

  return (
    <div className="page ms" style={{ maxWidth: 1240 }}>
      <div className="ms-head">
        <div>
          <p className="ms-eyebrow">{mapName(m.map.id)}{data.replay.title ? ` · ${data.replay.title}` : ""}</p>
          <h1 className="ms-score">
            <span className={`side side-${m.rounds[0]?.sides.A ?? "CT"}`}>{T.A.name}</span>
            <span className="mono">{m.finalScore.A} : {m.finalScore.B}</span>
            <span className={`side side-${m.rounds[0]?.sides.B ?? "T"}`}>{T.B.name}</span>
          </h1>
        </div>
        <div className="row">
          <Link className="btn" href={data.access.via === "share" ? `/replays/${id}${hash}` : "/replays"}>‹ Back</Link>
          <Link className="btn btn-primary" href={replayHref()}>Open 2D replay</Link>
        </div>
      </div>

      {!hasPlayerStats(m) ? (
        <div className="alert alert-warn" role="status">
          Player stats are not available for this demo yet: it was processed before stats were added.
          {data.replay.sourceAvailable ? " The owner can re-process it from Share in the replay." : " Upload the demo again to get stats."}
        </div>
      ) : null}

      <div className="ms-filters" role="group" aria-label="Stats filters">
        <span className="faint">Side</span>
        {(["all", "CT", "T"] as const).map((s) => (
          <button key={s} type="button" className="chip" aria-pressed={filter.side === s} onClick={() => setFilter({ ...filter, side: s })}>
            {s === "all" ? "Both" : s}
          </button>
        ))}
        <span className="faint" style={{ marginLeft: 12 }}>Rounds</span>
        {(["all", "1", "2", ...(anyOt ? ["ot"] : [])] as StatsFilter["half"][]).map((h) => (
          <button key={h} type="button" className="chip" aria-pressed={filter.half === h} onClick={() => setFilter({ ...filter, half: h })}>
            {h === "all" ? "All" : h === "1" ? "1st half" : h === "2" ? "2nd half" : "Overtime"}
          </button>
        ))}
        <span className="faint" style={{ marginLeft: "auto", fontSize: 12 }}>{shownRounds.length} rounds</span>
      </div>

      {teams ? (
        <div className="ms-teamcards">
          {(["A", "B"] as TeamKey[]).map((k) => {
            const t = teams[k];
            return (
              <section key={k} className="card ms-teamcard" aria-label={`${T[k].name} summary`}>
                <h2>{T[k].name}</h2>
                <dl>
                  <div><dt>Rounds won</dt><dd>{t.roundsWon}/{t.roundsPlayed}</dd></div>
                  <div><dt>CT</dt><dd>{t.bySide.CT.won}/{t.bySide.CT.played}</dd></div>
                  <div><dt>T</dt><dd>{t.bySide.T.won}/{t.bySide.T.played}</dd></div>
                  <div><dt>Pistols</dt><dd>{t.pistolWon}/{t.pistolPlayed}</dd></div>
                  <div><dt>Opening duels</dt><dd>{t.openingWins}/{t.openingAttempts}</dd></div>
                  <div><dt>Clutches</dt><dd>{t.clutchesWon}/{t.clutches}</dd></div>
                </dl>
              </section>
            );
          })}
        </div>
      ) : null}

      {(["A", "B"] as TeamKey[]).map((k) => (
        <PlayerTable key={k} title={T[k].name} side={m.rounds[0]?.sides[k] ?? "CT"} rows={players.filter((p) => p.team === k)} hasDamage={hasDamage} />
      ))}
      <p className="faint" style={{ fontSize: 12, marginTop: 4 }}>
        ADR counts damage until each round is decided. Rating uses the public HLTV 1.0 formula.{hasDamage ? "" : " This demo has no damage events, so ADR and utility damage are unavailable."}
      </p>

      <EconomyChart m={m} rounds={shownRounds} href={replayHref} />
      <RoundHistory m={m} rounds={shownRounds} href={replayHref} />
    </div>
  );
}

function PlayerTable({ title, side, rows, hasDamage }: { title: string; side: Side; rows: PlayerTotals[]; hasDamage: boolean }) {
  const [sort, setSort] = useState<SortKey>("rating");
  const withD = rows.map((r) => ({ r, d: derive(r, hasDamage) }));
  const val = (x: (typeof withD)[number]): number => {
    switch (sort) {
      case "k": return x.r.k; case "d": return -x.r.d; case "a": return x.r.a; case "diff": return x.d.diff;
      case "adr": return x.d.adr ?? 0; case "kast": return x.d.kastPct; case "hs": return x.d.hsPct;
      case "open": return x.r.ok - x.r.od; case "clutch": return x.r.clutchesWon; case "ud": return x.r.ud; case "ef": return x.r.ef;
      default: return x.d.rating;
    }
  };
  withD.sort((a, b) => val(b) - val(a));
  const th = (key: SortKey, label: string, help: string) => (
    <th scope="col" title={help} aria-sort={sort === key ? "descending" : undefined}>
      <button type="button" onClick={() => setSort(key)}>{label}</button>
    </th>
  );
  return (
    <section className="ms-table-wrap" aria-label={`${title} players`} data-side={side}>
      <h2 className="ms-table-title">{title}</h2>
      <div className="ms-scroll">
        <table className="ms-table">
          <thead>
            <tr>
              <th scope="col" className="ms-name">Player</th>
              {th("k", "K", "Kills")}
              {th("d", "D", "Deaths")}
              {th("a", "A", "Assists (flash assists included)")}
              {th("diff", "+/−", "Kills minus deaths")}
              {th("adr", "ADR", "Average damage per round")}
              {th("kast", "KAST", "Rounds with a kill, assist, survival or trade")}
              {th("hs", "HS%", "Share of kills that were headshots")}
              {th("open", "Opening", "Opening kills – opening deaths")}
              {th("clutch", "Clutches", "Clutches won / played")}
              <th scope="col" title="Rounds with 2, 3, 4 and 5 kills">2K·3K·4K·5K</th>
              {th("ud", "UD", "Utility damage (HE and fire)")}
              {th("ef", "EF", "Enemies flashed")}
              <th scope="col" title="Flash assists">FA</th>
              {th("rating", "Rating 1.0", "HLTV 1.0 rating formula")}
            </tr>
          </thead>
          <tbody>
            {withD.map(({ r, d }) => (
              <tr key={r.id}>
                <th scope="row" className="ms-name">{r.name}</th>
                <td>{r.k}</td>
                <td>{r.d}</td>
                <td>{r.a}</td>
                <td className={d.diff > 0 ? "ms-pos" : d.diff < 0 ? "ms-neg" : ""}>{d.diff > 0 ? `+${d.diff}` : d.diff}</td>
                <td>{fixed(d.adr)}</td>
                <td>{pct(d.kastPct)}</td>
                <td>{pct(d.hsPct)}</td>
                <td>{r.ok}–{r.od}</td>
                <td>{r.clutchesWon}/{r.clutches}</td>
                <td className="ms-multi">{r.multi[2]}·{r.multi[3]}·{r.multi[4]}·{r.multi[5]}</td>
                <td>{hasDamage ? r.ud : "—"}</td>
                <td>{r.ef}</td>
                <td>{r.fa}</td>
                <td className="ms-rating" data-good={d.rating >= 1.1} data-bad={d.rating < 0.9}>{d.rating.toFixed(2)}</td>
              </tr>
            ))}
            {withD.length === 0 ? <tr><td colSpan={15} className="faint">No rounds match these filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Team equipment value per round: team A above the line, team B below, winner highlighted. */
function EconomyChart({ m, rounds, href }: { m: Manifest; rounds: RoundSummary[]; href: (r?: string) => string }) {
  const max = Math.max(1, ...rounds.flatMap((r) => [r.economy.A.equipmentValue ?? 0, r.economy.B.equipmentValue ?? 0]));
  if (!rounds.some((r) => r.economy.A.equipmentValue !== null)) return null;
  const W = 26;
  const H = 70;
  const width = rounds.length * W;
  return (
    <section className="card ms-econ" aria-label="Economy by round">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Economy</h2>
        <span className="faint" style={{ fontSize: 12 }}>Equipment value at freeze end · {m.teams.A.name} above, {m.teams.B.name} below · brighter bar = round winner</span>
      </div>
      <div className="ms-scroll">
        <svg width={width} height={H * 2 + 24} role="img" aria-label="Equipment value per round for both teams">
          {rounds.map((r, i) => {
            const x = i * W + 4;
            const a = ((r.economy.A.equipmentValue ?? 0) / max) * H;
            const b = ((r.economy.B.equipmentValue ?? 0) / max) * H;
            const colA = r.sides.A === "CT" ? "var(--ct)" : "var(--t)";
            const colB = r.sides.B === "CT" ? "var(--ct)" : "var(--t)";
            return (
              <a key={r.id} href={href(r.id)}>
                <title>{`Round ${r.displayNumber}: ${m.teams.A.name} $${r.economy.A.equipmentValue ?? "?"} (${buyLabel(r.economy.A.buyType)}) vs ${m.teams.B.name} $${r.economy.B.equipmentValue ?? "?"} (${buyLabel(r.economy.B.buyType)}) · won by ${r.winner ? m.teams[r.winner].name : "?"}`}</title>
                <rect x={x} y={H - a} width={W - 8} height={a} fill={colA} opacity={r.winner === "A" ? 0.95 : 0.35} rx={2} />
                <rect x={x} y={H + 24} width={W - 8} height={b} fill={colB} opacity={r.winner === "B" ? 0.95 : 0.35} rx={2} />
                <text x={x + (W - 8) / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="var(--text-dim)" fontFamily="var(--mono)">{r.displayNumber}</text>
              </a>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function RoundHistory({ m, rounds, href }: { m: Manifest; rounds: RoundSummary[]; href: (r?: string) => string }) {
  return (
    <section className="card ms-rounds" aria-label="Round history">
      <h2>Rounds</h2>
      <ol>
        {rounds.map((r) => {
          const hl = roundHighlights(m, r);
          return (
            <li key={r.id}>
              <Link href={href(r.id)} className="ms-round">
                <span className="mono ms-rn">{r.displayNumber}</span>
                <span className={`side side-${r.winnerSide ?? "CT"} ms-winner`}>{r.winner ? m.teams[r.winner].name : "—"}</span>
                <span className="faint">{reasonText(r.endReason)}</span>
                <span className="mono">{r.scoreAfter.A}–{r.scoreAfter.B}</span>
                <span className="faint ms-buys">{buyLabel(r.economy.A.buyType)} vs {buyLabel(r.economy.B.buyType)}</span>
                <span className="ms-hl">{hl.join(" · ")}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

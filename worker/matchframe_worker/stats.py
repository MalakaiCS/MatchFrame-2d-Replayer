"""Per-round player statistics, computed from the demo's kill, damage and blind events.

Definitions (documented in docs/data-contract.md, "Player stats"):

- k / d / a: enemy kills, deaths (any cause), assists (including flash assists). Team kills: ``tk`` only.
- fa: flash assists, also counted in ``a`` (the kill event says this player's flash blinded the victim).
- hs: enemy kills that were headshots.
- dmg: health damage dealt to enemies, capped at the victim's remaining health (so overkill does not
  count; the victim's health is tracked through the round), until the round is decided. ``ud`` is the part dealt with HE grenades and fire.
- ef / fd: enemies flashed and total enemy blind time (seconds) from this player's flashbangs.
- ok / od: the round's first kill (opening kill) and first death (opening death).
- trk / trd: trade kills and traded deaths: a death is traded when its killer dies to a teammate of the
  victim within ``TRADE_SECONDS``.
- surv: alive when the round ended. kast: kill, assist, survived or traded (1/0).
- cl / cw: clutch: the player became their side's last one alive against ``cl`` enemies; ``cw`` says
  whether their side won the round.
- eq: equipment value at freeze end (when the parser records it).
"""
from __future__ import annotations

from typing import Any, Iterable

import polars as pl

TRADE_SECONDS = 5.0
UTILITY_WEAPONS = {"hegrenade", "inferno", "molotov", "incgrenade"}


def _rows(df: pl.DataFrame | None, start: int, end: int) -> list[dict]:
    if df is None or df.height == 0 or "tick" not in df.columns:
        return []
    return df.filter((pl.col("tick") >= start) & (pl.col("tick") < end)).sort("tick").to_dicts()


def round_player_stats(
    *,
    start: int,
    end: int,
    decided: int | None = None,
    sides: dict[str, str],
    winner_side: str | None,
    kills: pl.DataFrame,
    damages: pl.DataFrame | None,
    blinds: pl.DataFrame | None,
    pid_of: Any,
    tick_rate: float,
    equipment: dict[str, int | None] | None = None,
) -> dict[str, dict]:
    """Stats for one round. ``sides`` maps player id -> "CT"/"T" for everyone who played the round;
    ``pid_of(steamid, name)`` turns event identities into player ids."""
    stats: dict[str, dict] = {
        pid: {"side": side, "k": 0, "d": 0, "a": 0, "fa": 0, "hs": 0, "tk": 0, "dmg": 0, "ud": 0, "ef": 0, "fd": 0.0,
              "ok": 0, "od": 0, "trk": 0, "trd": 0, "surv": 1, "kast": 0, "cl": 0, "cw": 0, "eq": (equipment or {}).get(pid)}
        for pid, side in sides.items()
    }

    def who(row: dict, prefix: str) -> str | None:
        sid = row.get(f"{prefix}_steamid")
        name = row.get(f"{prefix}_name")
        if sid in (None, "", "0") and not name:
            return None
        return pid_of(sid, name)

    trade_ticks = TRADE_SECONDS * tick_rate
    deaths: list[tuple[int, str, str | None]] = []  # (tick, victim, killer)
    alive = {s: {p for p, side in sides.items() if side == s} for s in ("CT", "T")}
    clutch_done: set[str] = set()
    opening_done = False

    for row in _rows(kills, start, end):
        victim = who(row, "victim")
        killer = who(row, "attacker")
        assister = who(row, "assister")
        tick = int(row["tick"])
        if victim is None or victim not in stats:
            continue
        vs = stats[victim]
        if not vs["surv"]:
            continue  # duplicate death event
        vs["d"] += 1
        vs["surv"] = 0
        alive[vs["side"]].discard(victim)
        enemy_kill = killer is not None and killer in stats and stats[killer]["side"] != vs["side"]
        if killer is not None and killer in stats and not enemy_kill and killer != victim:
            stats[killer]["tk"] += 1
        if enemy_kill:
            ks = stats[killer]
            ks["k"] += 1
            if row.get("headshot"):
                ks["hs"] += 1
            if not opening_done:
                ks["ok"] += 1
                vs["od"] += 1
            # Trade: ``victim`` recently killed a teammate of ``killer``; that teammate's death is traded.
            for dt, dv, dk in deaths:
                if dk == victim and tick - dt <= trade_ticks and dv in stats and stats[dv]["side"] == ks["side"]:
                    if not stats[dv]["trd"]:
                        stats[dv]["trd"] = 1
                    ks["trk"] += 1
                    break
        if not opening_done:
            opening_done = True
            if not enemy_kill:
                vs["od"] += 1  # first death of the round even without an enemy killer
        if assister is not None and assister in stats and stats[assister]["side"] != vs["side"]:
            # Flash assists count as assists too (as in Awpy); ``fa`` keeps them separately.
            stats[assister]["a"] += 1
            if row.get("assist_flash"):
                stats[assister]["fa"] += 1
        deaths.append((tick, victim, killer))
        # Clutch: a side just dropped to one player while enemies are still alive.
        for side in ("CT", "T"):
            other = "T" if side == "CT" else "CT"
            if len(alive[side]) == 1 and alive[other] and side not in clutch_done:
                (last,) = tuple(alive[side])
                clutch_done.add(side)
                stats[last]["cl"] = len(alive[other])
                stats[last]["cw"] = 1 if winner_side == side else 0

    # Damage counts until the round is decided (as the in-game scoreboard and Awpy do); kills count to round end.
    # The parser's per-event "health before" is not reliable (it can repeat the round-start value), so each
    # victim's health is tracked here: it starts at 100 and every hit is capped at the health left.
    health: dict[str, int] = {}
    for row in _rows(damages, start, decided if decided is not None else end):
        att = who(row, "attacker")
        vic = who(row, "victim")
        if vic is None or vic not in stats:
            continue
        hp = health.get(vic, 100)
        real = max(0, min(int(row.get("dmg_health") or 0), hp))
        health[vic] = hp - real
        if att is None or att not in stats or att == vic or stats[att]["side"] == stats[vic]["side"]:
            continue
        stats[att]["dmg"] += real
        if (row.get("weapon") or "") in UTILITY_WEAPONS:
            stats[att]["ud"] += real

    for row in _rows(blinds, start, end):
        att = who(row, "attacker")
        vic = who(row, "victim")
        if att is None or vic is None or att not in stats or vic not in stats or att == vic:
            continue
        if stats[att]["side"] == stats[vic]["side"]:
            continue
        dur = float(row.get("duration") or 0.0)
        if dur <= 0:
            continue
        stats[att]["ef"] += 1
        stats[att]["fd"] += dur

    for s in stats.values():
        s["fd"] = round(s["fd"], 2)
        s["kast"] = 1 if (s["k"] or s["a"] or s["surv"] or s["trd"]) else 0
    return stats


def summarize(rounds: Iterable[dict[str, dict]]) -> dict[str, dict]:
    """Add up per-round stats per player (used by tests and the cross-check tool)."""
    out: dict[str, dict] = {}
    for rs in rounds:
        for pid, s in rs.items():
            t = out.setdefault(pid, {"rounds": 0, "k": 0, "d": 0, "a": 0, "fa": 0, "hs": 0, "dmg": 0, "ud": 0, "ef": 0,
                                     "ok": 0, "od": 0, "trk": 0, "trd": 0, "kast": 0, "cl": 0, "cw": 0,
                                     "2k": 0, "3k": 0, "4k": 0, "5k": 0})
            t["rounds"] += 1
            for key in ("k", "d", "a", "fa", "hs", "dmg", "ud", "ef", "ok", "od", "trk", "trd", "kast"):
                t[key] += s[key]
            if s["cl"]:
                t["cl"] += 1
                t["cw"] += s["cw"]
            if s["k"] >= 2:
                t[f"{min(s['k'], 5)}k"] += 1
    return out

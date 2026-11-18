"""Per-player ammo (clip / reserve) for the active weapon.

Awpy 3.3.0 snapshots have no ammo fields, and reading weapon entities through
`Demo.ticks(players_only=False)` scans every entity on every tick (tens of
millions of rows). demoparser2 exposes `active_weapon_ammo` (clip) and
`total_ammo_left` (reserve) per player at chosen ticks, so we ask it only
for the sample ticks.

Ammo is optional data: any failure leaves the columns absent and adds a
warning; playback is never blocked.
"""

from __future__ import annotations

import logging

import polars as pl

log = logging.getLogger(__name__)

# Items whose "ammo" is not meaningful: melee, grenades, the bomb.
NO_AMMO = ("knife", "bayonet", "karambit", "dagger", "grenade", "flashbang", "molotov", "incendiary", "decoy", "c4", "bomb")


# Standard reserve ammo per weapon (CS2). Used to ESTIMATE reserve: GOTV demos record the
# clip exactly but the networked reserve field is coarse/unreliable (checked on real demos,
# docs/data-contract.md#ammo). Weapons not listed get no reserve estimate.
MAX_RESERVE = {
    "ak47": 90, "m4a1": 90, "m4a1_silencer": 80, "famas": 90, "galilar": 90, "aug": 90, "sg556": 90,
    "awp": 30, "ssg08": 90, "scar20": 90, "g3sg1": 90,
    "mac10": 100, "mp9": 120, "mp7": 120, "mp5sd": 120, "ump45": 100, "p90": 100, "bizon": 120,
    "nova": 32, "xm1014": 32, "mag7": 32, "sawedoff": 32, "negev": 300, "m249": 200,
    "glock": 120, "usp_silencer": 24, "hkp2000": 52, "p250": 26, "deagle": 35, "fiveseven": 100,
    "tec9": 90, "cz75a": 12, "elite": 120, "revolver": 8,
}


def max_reserve(weapon: str | None) -> int | None:
    if not weapon:
        return None
    return MAX_RESERVE.get(weapon.lower().replace("weapon_", ""))


def estimate_reserve(weapons: list[str | None], clips: list[int]) -> list[int]:
    """Per-sample reserve estimate for one player's track within one round.

    Starts each weapon at its standard reserve (CS2 refills ammo at round start) and
    subtracts the rounds loaded by each reload (clip increase on the same weapon).
    Returns -1 where no estimate applies.
    """
    left: dict[str, int] = {}
    out: list[int] = []
    prev_w: str | None = None
    prev_c = -1
    for w, c in zip(weapons, clips):
        mx = max_reserve(w)
        if mx is None or c < 0:
            out.append(-1)
            prev_w, prev_c = w, c
            continue
        r = left.setdefault(w, mx)
        if w == prev_w and prev_c >= 0 and c > prev_c:
            r = max(0, r - (c - prev_c))
            left[w] = r
        out.append(r)
        prev_w, prev_c = w, c
    return out


def has_ammo(weapon: str | None) -> bool:
    if not weapon:
        return False
    w = weapon.lower()
    return not any(k in w for k in NO_AMMO)


def load_ammo(path: str, ticks: list[int]) -> pl.DataFrame | None:
    """Return a frame (tick, steamid, clip, reserve) or None when unavailable."""
    try:
        from demoparser2 import DemoParser
    except ImportError:
        return None
    try:
        df = DemoParser(path).parse_ticks(["active_weapon_ammo"], ticks=ticks)
    except Exception as e:  # noqa: BLE001 - optional enrichment
        log.warning("ammo extraction failed: %s", e)
        return None
    if df is None or len(df) == 0:
        return None
    out = pl.from_pandas(df[["tick", "steamid", "active_weapon_ammo"]])
    return out.select(
        pl.col("tick").cast(pl.Int64),
        pl.col("steamid").cast(pl.UInt64, strict=False).cast(pl.Utf8).alias("steamid"),
        pl.col("active_weapon_ammo").cast(pl.Int64, strict=False).alias("clip"),
    ).unique(subset=["tick", "steamid"], keep="first")

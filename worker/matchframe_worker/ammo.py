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


def load_recorded_reserve(path: str, sample_ticks: list[int]) -> pl.DataFrame | None:
    """Recorded reserve of each player's active weapon: weapon entity `m_pReserveAmmo[0]`.

    This is the value the reference viewer shows (verified 2026-11-19 on a shared demo:
    35/4, 13/3, 4/2 ...). demoparser2 decodes this field incorrectly, so it is read from
    Awpy's all-entity table, which is memory-heavy (about 6.6 GiB for a 361 MB demo).
    Enabled only with WORKER_RECORDED_RESERVE=1 on a worker sized for it.
    """
    try:
        from awpy import Demo

        d = Demo(path)
        wanted = pl.Series("tick", sample_ticks, dtype=pl.Int64)
        w = (
            d.ticks(["m_pReserveAmmo.0000"], players_only=False)
            .drop_nulls("m_pReserveAmmo.0000")
            .filter(pl.col("tick").is_in(wanted))
            .select(pl.col("tick").cast(pl.Int64), pl.col("entity_id").cast(pl.Int64), pl.col("entity_serial").cast(pl.Int64),
                    pl.col("m_pReserveAmmo.0000").cast(pl.Int64).alias("reserve"))
        )
        p = (
            d.ticks(["m_pWeaponServices.m_hActiveWeapon"], players_only=True)
            .filter(pl.col("tick").is_in(wanted))
            .select(
                pl.col("tick").cast(pl.Int64),
                pl.col("steamid").cast(pl.Utf8),
                (pl.col("m_pWeaponServices.m_hActiveWeapon") % 16384).cast(pl.Int64).alias("entity_id"),
                (pl.col("m_pWeaponServices.m_hActiveWeapon") // 16384).cast(pl.Int64).alias("entity_serial"),
            )
        )
        return p.join(w, on=["tick", "entity_id", "entity_serial"], how="inner").select(["tick", "steamid", "reserve"])
    except Exception as e:  # noqa: BLE001 - optional enrichment
        log.warning("recorded reserve extraction failed: %s", e)
        return None

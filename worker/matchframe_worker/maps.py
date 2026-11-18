"""Map registry access and floor assignment."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache

from .errors import UnsupportedMap


@dataclass(frozen=True)
class MapInfo:
    id: str
    display_name: str
    status: str
    floors: list[dict]
    uncertainty_band: float
    registry_version: str

    def floor_of(self, z: float) -> tuple[int, bool]:
        """Return (floor index, uncertain). Floors after the first carry an exclusive zMax."""
        if len(self.floors) < 2:
            return 0, False
        idx = 0
        uncertain = False
        for i, f in enumerate(self.floors[1:], start=1):
            zmax = f.get("zMax")
            if zmax is None:
                continue
            if z < zmax:
                idx = i
            if abs(z - zmax) <= self.uncertainty_band:
                uncertain = True
        return idx, uncertain


@lru_cache(maxsize=4)
def load_registry(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def get_map(path: str, map_id: str) -> MapInfo:
    reg = load_registry(path)
    entry = reg["maps"].get(map_id)
    if entry is None:
        raise UnsupportedMap(f"Map '{map_id}' is not in the Matchframe map registry.")
    return MapInfo(
        id=map_id,
        display_name=entry["displayName"],
        status=entry["status"],
        floors=entry["floors"],
        uncertainty_band=float(entry.get("floorUncertaintyBand", 0)),
        registry_version=reg["registryVersion"],
    )

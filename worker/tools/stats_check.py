"""Compare Matchframe's per-round player stats with Awpy's match stats for one demo.

    python -I worker/tools/stats_check.py path/to/demo.dem

Prints both side by side per player. Differences are expected only where definitions differ
(documented in docs/data-contract.md, "Player stats").
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from matchframe_worker.awpy_source import load  # noqa: E402
from matchframe_worker.config import _default_registry as _registry  # noqa: E402
from matchframe_worker.maps import get_map  # noqa: E402
from matchframe_worker.stats import summarize  # noqa: E402
from matchframe_worker.transform import build  # noqa: E402


def main(path: str) -> None:
    from awpy import Demo

    raw = load(path, sample_every=4)
    res = build(raw, get_map(_registry(), raw.map_name), replay_id="check", revision=1, prefix="x", sample_every=4)
    ours = summarize(r["playerStats"] for r in res.manifest["rounds"])
    d = Demo(path)
    d.load("rounds", "kills", "damages", "blinds", "stats")
    theirs = {f"s:{r['steamid']}": r for r in d.stats.to_dicts()}
    names = {p["id"]: p["name"] for p in res.manifest["players"]}
    cols = [("k", "kills"), ("d", "deaths"), ("a", "assists"), ("fa", "flash_assists"), ("hs", "headshot_kills"),
            ("ok", "opening_kills"), ("od", "opening_deaths"), ("trd", "traded_deaths"), ("cl", "clutches_played"),
            ("cw", "clutches_won"), ("ud", "utility_damage"), ("ef", "enemies_flashed")]
    print(f"{'player':16} rounds  " + "  ".join(f"{a:>7}" for a, _ in cols) + "      ADR    KAST%")
    for pid, s in sorted(ours.items(), key=lambda kv: -kv[1]["k"]):
        t = theirs.get(pid, {})
        n = max(1, s["rounds"])
        line = f"{names.get(pid, pid)[:16]:16} {s['rounds']:>3}/{t.get('rounds_played', '?'):<3}"
        line += "  ".join(f"{s[a]:>3}/{t.get(b, '?'):<3}" for a, b in cols)
        adr = s["dmg"] / n
        kast = 100 * s["kast"] / n
        line += f"  {adr:6.1f}/{t.get('adr', 0):<6.1f} {kast:5.1f}/{100 * t.get('kast', 0) if (t.get('kast') or 0) <= 1 else t.get('kast', 0):<5.1f}"
        print(line)


if __name__ == "__main__":
    main(sys.argv[1])

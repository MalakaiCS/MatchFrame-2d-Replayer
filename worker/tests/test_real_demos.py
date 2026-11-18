"""Regression tests on owner-supplied real CS2 demos (not stored in git).

Set MF_REAL_DEMOS_DIR to a directory containing the extracted .dem files.
Expected values were produced by this pipeline on 2026-11-19 and spot-checked
(round counts, half scores, clan-tag team names, buy agreement with Awpy).
They are a regression baseline, not an independent ground truth.
"""

import os
from pathlib import Path

import pytest

from matchframe_worker.config import _default_registry
from matchframe_worker.maps import get_map
from matchframe_worker.transform import build

DIR = os.environ.get("MF_REAL_DEMOS_DIR")
pytestmark = pytest.mark.skipif(not DIR, reason="MF_REAL_DEMOS_DIR not set")

EXPECTED = {
    # file: (map, team A, team B, final A, final B, rounds, halves {H1, H2})
    "bc-game-vs-wbt-dust2.dem": ("de_dust2", "BC.GAME", "WBT", 13, 10, 23, {"H1": [8, 4], "H2": [5, 6]}),
    "iberian-soul-vs-hyperspirit-mirage.dem": ("de_mirage", "HYPERSPIRIT", "Iberian Soul", 5, 13, 18, {"H1": [4, 8], "H2": [1, 5]}),
    "iberian-soul-vs-sashi-m1-inferno.dem": ("de_inferno", "Iberian Soul", "Sashi Esport", 13, 8, 21, {"H1": [8, 4], "H2": [5, 4]}),
    "infinite-vs-basement-boys-ancient.dem": ("de_ancient", "INFINITE", "Basement Boys", 13, 5, 18, {"H1": [12, 0], "H2": [1, 5]}),
    "sashi-vs-mouz-nxt-nuke.dem": ("de_nuke", "Sashi Esport", "MOUZ NXT", 13, 9, 22, {"H1": [6, 6], "H2": [7, 3]}),
    "saw-vs-astral-m1-cache.dem": ("de_cache", "SAW", "ASTRAL", 13, 7, 20, {"H1": [10, 2], "H2": [3, 5]}),
    "saw-vs-bayankhongor-anubis.dem": ("de_anubis", "SAW", "Bayankhongor", 13, 1, 14, {"H1": [11, 1], "H2": [2, 0]}),
    "mm1.dem": ("de_mirage", "Team A", "Team B", 18, 6, 24, {"H1": [9, 3], "H2": [9, 3]}),
    # BO3 archives (2026-11-19): overtime, partial recording (starts at round 7), truncated recording.
    "furia-vs-falcons-m1-ancient.dem": ("de_ancient", "FURIA", "Falcons", 16, 14, 30, {"H1": [7, 5], "H2": [5, 7], "OT": [4, 2]}),
    "furia-vs-falcons-m2-dust2.dem": ("de_dust2", "Falcons", "FURIA", 5, 13, 12, {"H1": [1, 5], "H2": [0, 6]}),
    "baks-vs-the-last-resort-m1-nuke.dem": ("de_nuke", "BAKS", "The Last Resort", 13, 3, 16, {"H1": [10, 2], "H2": [3, 1]}),
    "baks-vs-the-last-resort-m2-cache.dem": ("de_cache", "The Last Resort", "BAKS", 4, 13, 17, {"H1": [1, 11], "H2": [3, 2]}),
    "scrim-8pm-inferno.dem": ("de_inferno", "TEAM1", "TEAM2", 18, 6, 24, {"H1": [11, 1], "H2": [7, 5]}),
}


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_real_demo(name):
    path = Path(DIR) / name
    if not path.exists():
        pytest.skip(f"{name} not present")
    from matchframe_worker.awpy_source import load

    raw = load(str(path), sample_every=4)
    res = build(raw, get_map(_default_registry(), raw.map_name), replay_id="t", revision=1, prefix="p", sample_every=4)
    m = res.manifest
    mp, ta, tb, fa, fb, n, halves = EXPECTED[name]
    assert (m["map"]["id"], m["teams"]["A"]["name"], m["teams"]["B"]["name"]) == (mp, ta, tb)
    assert (m["finalScore"]["A"], m["finalScore"]["B"], len(m["rounds"])) == (fa, fb, n)
    got = {}
    for r in m["rounds"]:
        k = "OT" if r["isOvertime"] else f"H{r['half']}"
        got.setdefault(k, [0, 0])[0 if r["winner"] == "A" else 1] += 1
    assert got == halves
    assert m["sourceType"] == "gotv" and m["capabilities"]["clock"] == "countdown"
    # Our buy classes agree with Awpy's own classification in every round.
    pairs = {("pistol", "pistol"), ("eco", "eco"), ("half_buy", "force"), ("full_buy", "full")}
    # Awpy labels the first *recorded* round as a pistol round, so on partial recordings
    # (starting mid-match) that one round is skipped; our numbering knows it is round 7.
    check = m["rounds"][1:] if m["rounds"][0]["displayNumber"] > 1 else m["rounds"]
    assert all((r["economy"][k]["buyType"], r["economy"][k]["parserBuyType"]) in pairs for r in check for k in "AB")
    # Every kill lands inside its round window; team identity stays stable through the half swap.
    for r in m["rounds"]:
        p = res.payloads[r["id"]]
        assert all(r["startTick"] <= e["tick"] < r["endTick"] for e in p["events"])
    first = m["rounds"][0]["displayNumber"]
    if first == 1:
        assert m["rounds"][0]["sides"]["A"] != m["rounds"][12]["sides"]["A"]
    # The computed score always agrees with the in-game scoreboard.
    assert not any("differs from the in-game scoreboard" in w for w in m["warnings"])
    # Ammo: clips recorded for guns.
    assert m["capabilities"]["ammo"] is True
    assert any(c > 0 for p in res.payloads.values() for t in p["tracks"] if t["clip"] for c in t["clip"])


def test_overtime_flags():
    path = Path(DIR) / "furia-vs-falcons-m1-ancient.dem"
    if not path.exists():
        pytest.skip("overtime demo not present")
    from matchframe_worker.awpy_source import load

    raw = load(str(path), sample_every=4)
    m = build(raw, get_map(_default_registry(), raw.map_name), replay_id="t", revision=1, prefix="p", sample_every=4).manifest
    assert [r["displayNumber"] for r in m["rounds"] if r["isOvertime"]] == list(range(25, 31))
    assert [r["displayNumber"] for r in m["rounds"] if r["isOvertimeHalfStart"]] == [25, 28]
    assert [r["displayNumber"] for r in m["rounds"] if r["isPistol"]] == [1, 13]


def test_partial_recording_keeps_real_round_numbers_and_score():
    path = Path(DIR) / "furia-vs-falcons-m2-dust2.dem"
    if not path.exists():
        pytest.skip("partial demo not present")
    from matchframe_worker.awpy_source import load

    raw = load(str(path), sample_every=4)
    m = build(raw, get_map(_default_registry(), raw.map_name), replay_id="t", revision=1, prefix="p", sample_every=4).manifest
    assert m["rounds"][0]["displayNumber"] == 7 and m["rounds"][0]["id"] == "r07"
    assert m["rounds"][0]["scoreBefore"] == {"A": 4, "B": 2}
    assert m["capabilities"]["recordingStartsAtRound"] == 7
    assert [r["displayNumber"] for r in m["rounds"] if r["isPistol"]] == [13]

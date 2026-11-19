"""Fit the round win-probability model shipped in web/src/shared/winprob.json.

    python -I worker/tools/fit_winprob.py out.json demo1.dem demo2.dem ...

A small logistic regression on the round state, from the CT side's point of view, sampled every
second from freeze end until the round is decided. Features (must match web/src/viewer/winprob.ts):

    1, alive diff (CT - T), CT alive, T alive, health diff / 100, equipment diff / 10000,
    planted, bomb time left (fraction, when planted), round time left (fraction, before a plant),
    planted * alive diff

Hard rules are applied outside the model (no CTs alive -> 0; no Ts alive and no plant -> 1).
The last 20% of demos (by name) are held out to report log loss, Brier score and accuracy.
"""
from __future__ import annotations

import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FEATURES = ["bias", "alive_diff", "ct_alive", "t_alive", "hp_diff", "eq_diff", "planted", "bomb_left", "round_left", "planted_x_alive_diff"]


def features(ct_alive, t_alive, ct_hp, t_hp, ct_eq, t_eq, planted, bomb_left, round_left):
    d = ct_alive - t_alive
    return [1.0, d, ct_alive, t_alive, (ct_hp - t_hp) / 100.0, (ct_eq - t_eq) / 10000.0,
            float(planted), bomb_left if planted else 0.0, 0.0 if planted else round_left, d if planted else 0.0]


def states_for(path: str):
    from matchframe_worker.awpy_source import load
    from matchframe_worker.config import _default_registry
    from matchframe_worker.maps import get_map
    from matchframe_worker.transform import build

    raw = load(path, sample_every=4)
    res = build(raw, get_map(_default_registry(), raw.map_name), replay_id="fit", revision=1, prefix="x", sample_every=4)
    m = res.manifest
    rate = m["tickRate"]
    round_s = m["timing"]["roundTimeS"]
    bomb_s = m["timing"]["bombTimerS"]
    team_of = {p["id"]: p["team"] for p in m["players"]}
    X, y = [], []
    for r in m["rounds"]:
        if not r["winnerSide"] or r["freezeEndTick"] is None:
            continue
        pl = res.payloads[r["id"]]
        start = r["freezeEndTick"]
        end = r["decidedTick"] or r["endTick"]
        plant = next((e["tick"] for e in pl["events"] if e["type"] == "bomb_plant"), None)
        side_team = {r["sides"]["A"]: "A", r["sides"]["B"]: "B"}
        eq = {s: (r["economy"][side_team[s]]["equipmentValue"] or 0) for s in ("CT", "T")}
        deaths = {}
        for e in pl["events"]:
            if e["type"] == "kill" and e.get("target") and e["target"] not in deaths:
                deaths[e["target"]] = e["tick"]
        tracks = [(tr, r["sides"][team_of.get(tr["playerId"], "A")]) for tr in pl["tracks"] if tr["playerId"] in team_of]
        for tick in range(start, end, int(rate)):
            alive = {"CT": 0, "T": 0}
            hp = {"CT": 0, "T": 0}
            for tr, side in tracks:
                ts = tr["t"]
                lo, hi = 0, len(ts) - 1
                if not ts or ts[0] > tick:
                    continue
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if ts[mid] <= tick:
                        lo = mid
                    else:
                        hi = mid - 1
                dead = tr["playerId"] in deaths and deaths[tr["playerId"]] <= tick
                if tr["alive"][lo] and not dead:
                    alive[side] += 1
                    hp[side] += (tr["hp"][lo] if tr.get("hp") else 100)
            if alive["CT"] == 0 or alive["T"] == 0:
                continue  # decided by the hard rules
            planted = plant is not None and tick >= plant
            bomb_left = max(0.0, bomb_s - (tick - plant) / rate) / bomb_s if planted else 0.0
            round_left = max(0.0, round_s - (tick - start) / rate) / round_s
            X.append(features(alive["CT"], alive["T"], hp["CT"], hp["T"], eq["CT"], eq["T"], planted, bomb_left, round_left))
            y.append(1.0 if r["winnerSide"] == "CT" else 0.0)
    return Path(path).name, X, y


def fit(X, y, l2=1.0, iters=50):
    X = np.asarray(X)
    y = np.asarray(y)
    w = np.zeros(X.shape[1])
    reg = np.eye(X.shape[1]) * l2
    reg[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + reg @ w
        H = (X * (p * (1 - p))[:, None]).T @ X + reg
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def evaluate(w, X, y):
    X = np.asarray(X)
    y = np.asarray(y)
    p = np.clip(1 / (1 + np.exp(-X @ w)), 1e-6, 1 - 1e-6)
    base = np.clip(np.full_like(y, y.mean()), 1e-6, 1 - 1e-6)
    ll = lambda q: float(-(y * np.log(q) + (1 - y) * np.log(1 - q)).mean())  # noqa: E731
    return {"states": int(len(y)), "logLoss": round(ll(p), 4), "baselineLogLoss": round(ll(base), 4),
            "brier": round(float(((p - y) ** 2).mean()), 4), "accuracy": round(float(((p > 0.5) == (y > 0.5)).mean()), 4)}


def main(out: str, paths: list[str]) -> None:
    paths = sorted(paths)
    with ProcessPoolExecutor(max_workers=3) as ex:
        results = list(ex.map(states_for, paths))
    n_test = max(1, math.ceil(len(results) * 0.2))
    train, test = results[:-n_test], results[-n_test:]
    Xtr = [x for _, X, _ in train for x in X]
    ytr = [v for _, _, Y in train for v in Y]
    Xte = [x for _, X, _ in test for x in X]
    yte = [v for _, _, Y in test for v in Y]
    w = fit(Xtr, ytr)
    held = evaluate(w, Xte, yte)
    # Ship the model refitted on everything; report the held-out score of the train-only fit.
    w_all = fit(Xtr + Xte, ytr + yte)
    doc = {
        "model": "logistic-v1",
        "features": FEATURES,
        "weights": [round(float(v), 5) for v in w_all],
        "trainedOn": {"demos": [n for n, _, _ in results], "states": len(Xtr) + len(Xte)},
        "heldOut": {"demos": [n for n, _, _ in test], **held},
        "note": "Logistic regression on alive players, health, equipment, bomb and time; CT side's view. Hard rules: no CTs alive -> 0; no Ts alive and no plant -> 1.",
    }
    Path(out).write_text(json.dumps(doc, indent=2) + "\n")
    print(json.dumps({k: doc[k] for k in ("weights", "heldOut")}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])

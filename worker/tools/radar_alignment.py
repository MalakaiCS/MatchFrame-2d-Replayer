"""Radar calibration check: what share of live-player positions in real demos land on the
radar image's playable (opaque) area, per floor. Writes overlay PNGs for visual review.

    pip install pillow   # tool-only dependency
    python tools/radar_alignment.py <overlay_out_dir> demo1.dem [demo2.dem ...]

Results on 2026-11-19 are recorded in docs/replayer-parity.md (MAP-*).
"""
import sys, json, polars as pl
from PIL import Image, ImageDraw
from awpy import Demo
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2] / "web"
reg = json.load(open(ROOT / "src/shared/maps.json"))["maps"]
R = str(ROOT / "public/radars")
for f in sys.argv[2:]:
    d = Demo(f); m = d.header["map_name"]; e = reg[m]
    s = d.snapshots(every=32).filter(pl.col("health") > 0)
    floors = e["floors"]
    res = {"file": f.split("/")[-1], "map": m, "n": s.height}
    for fi, fl in enumerate(floors):
        img = Image.open(f"{R}/{m}{fl.get('imageSuffix', '')}.png").convert("RGBA")
        A = img.getchannel("A").load()
        z = s["z"]
        if len(floors) > 1:
            zmax = floors[1]["zMax"]
            sub = s.filter((pl.col("z") < zmax) if fi == 1 else (pl.col("z") >= zmax))
        else:
            sub = s
        ok = tot = 0
        ov = img.copy(); dr = ImageDraw.Draw(ov)
        for x, y in zip(sub["x"].to_list(), sub["y"].to_list()):
            px = (x - e["originX"]) / e["scale"]; py = (e["originY"] - y) / e["scale"]
            tot += 1
            if 0 <= px < 1024 and 0 <= py < 1024:
                # 2px tolerance: radar edges are anti-aliased and players hug walls
                if any(A[min(1023, max(0, int(px) + dx)), min(1023, max(0, int(py) + dy))] > 40 for dx in (-2, 0, 2) for dy in (-2, 0, 2)):
                    ok += 1
                dr.point((px, py), fill=(255, 0, 255, 255))
        ov.save(f"{sys.argv[1]}/align-{m}{fl.get('imageSuffix','')}.png")
        res[fl["id"]] = f"{ok}/{tot} = {100*ok/max(1,tot):.2f}%"
    print(json.dumps(res))

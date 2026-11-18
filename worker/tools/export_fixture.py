"""Export a SYNTHETIC replay (manifest + selected rounds) for web unit tests and local demos.

    python tools/export_fixture.py <out_dir> [map] [rounds...]
    python tools/export_fixture.py --demo-file <path.dem>   # write a synthetic upload file
"""

import gzip
import json
import sys
from pathlib import Path

from matchframe_worker.config import _default_registry
from matchframe_worker.maps import get_map
from matchframe_worker.synthetic import encode, generate
from matchframe_worker.transform import build


def main() -> None:
    if sys.argv[1] == "--demo-file":
        params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {"map": "de_mirage"}
        Path(sys.argv[2]).write_bytes(encode(params))
        return
    out = Path(sys.argv[1])
    map_id = sys.argv[2] if len(sys.argv) > 2 else "de_mirage"
    want = sys.argv[3:] or ["r01", "r05", "r06"]
    raw = generate({"map": map_id})
    res = build(raw, get_map(_default_registry(), map_id), replay_id="fixture", revision=1, prefix="fixture", sample_every=4)
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(res.manifest, separators=(",", ":")))
    for rid in want:
        (out / f"{rid}.json.gz").write_bytes(gzip.compress(json.dumps(res.payloads[rid], separators=(",", ":")).encode(), mtime=0))


if __name__ == "__main__":
    main()

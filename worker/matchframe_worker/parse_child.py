"""Parse one demo in an isolated, resource-limited subprocess.

Usage: python -m matchframe_worker.parse_child <params.json>
Writes <out_dir>/manifest.json and <out_dir>/rounds/<id>.json.gz, or
<out_dir>/error.json on a classified failure (exit code 2).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sys
import traceback
from pathlib import Path

from .demo_header import classify_header
from .errors import InvalidDemo, JobError
from .maps import get_map
from .transform import build


def run(p: dict) -> None:
    out = Path(p["out_dir"])
    (out / "rounds").mkdir(parents=True, exist_ok=True)
    with open(p["source"], "rb") as fh:
        head = fh.read(16)
    kind = classify_header(head, allow_synthetic=p["allow_synthetic"])
    if kind == "synthetic":
        from .synthetic import decode, generate

        raw = generate(decode(Path(p["source"]).read_bytes()))
    else:
        from .awpy_source import load

        raw = load(p["source"], sample_every=p["sample_every"])
    if not raw.map_name:
        raise InvalidDemo("The demo header has no map name.")
    m = get_map(p["map_registry"], raw.map_name)
    res = build(raw, m, replay_id=p["replay_id"], revision=p["revision"], prefix=p["prefix"],
                sample_every=p["sample_every"], series=p.get("series"))
    for s in res.manifest["rounds"]:
        body = gzip.compress(json.dumps(res.payloads[s["id"]], separators=(",", ":")).encode(), compresslevel=6, mtime=0)
        (out / "rounds" / f"{s['id']}.json.gz").write_bytes(body)
        s["payload"]["bytes"] = len(body)
        s["payload"]["sha256"] = hashlib.sha256(body).hexdigest()
    (out / "manifest.json").write_text(json.dumps(res.manifest, separators=(",", ":")))


def main() -> int:
    p = json.loads(Path(sys.argv[1]).read_text())
    out = Path(p["out_dir"])
    out.mkdir(parents=True, exist_ok=True)
    try:
        run(p)
        return 0
    except JobError as e:
        (out / "error.json").write_text(json.dumps({"code": e.code, "message": str(e), "permanent": e.permanent}))
        return 2
    except MemoryError:
        (out / "error.json").write_text(json.dumps({"code": "PARSE_LIMIT", "message": "The demo exceeded the parser memory limit.", "permanent": True}))
        return 2
    except Exception as e:  # noqa: BLE001 - parser failures on corrupt input are permanent
        traceback.print_exc()
        (out / "error.json").write_text(json.dumps({"code": "PARSE_ERROR", "message": f"The demo could not be parsed ({type(e).__name__}).", "permanent": True}))
        return 2


if __name__ == "__main__":
    sys.exit(main())

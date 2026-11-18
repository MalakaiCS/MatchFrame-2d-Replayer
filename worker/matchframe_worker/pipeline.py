"""Process one claimed job."""

from __future__ import annotations

import json
import logging
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import jobs
from .config import Config
from .archive import MAX_SERIES_DEMOS, archive_kind, extract, extract_member, list_demos
from .demo_header import classify_header
from .errors import DemoTooLarge, JobError, LeaseLost, ParseResourceLimit, SourceMissing, TransientError
from .storage import Storage

log = logging.getLogger(__name__)


def _limits(mem: int):
    """Bound the parser's address space. RLIMIT_AS limits *virtual* memory; Rust/Polars allocators can
    reserve far more than they touch, so size it generously or set WORKER_PARSE_MEMORY_BYTES=0 and rely
    on the container memory limit instead."""
    def apply():
        if mem > 0:
            resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


def run_parse_child(cfg: Config, params: dict, workdir: Path) -> tuple[dict | None, dict]:
    pfile = workdir / "params.json"
    pfile.write_text(json.dumps(params))
    t0 = time.monotonic()
    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "matchframe_worker.parse_child", str(pfile)],
            preexec_fn=_limits(cfg.parse_memory_bytes), timeout=cfg.parse_timeout_s,
            capture_output=True, text=True,
        )
    except subprocess.TimeoutExpired as e:
        raise ParseResourceLimit("Parsing took longer than the configured limit.") from e
    stats = {
        "parseSeconds": round(time.monotonic() - t0, 2),
        "peakChildRssKiB": max(before, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss),
    }
    out = Path(params["out_dir"])
    if proc.returncode == 0:
        return json.loads((out / "manifest.json").read_text()), stats
    err_file = out / "error.json"
    if err_file.exists():
        err = json.loads(err_file.read_text())
        e = JobError(err["message"], code=err["code"])
        e.permanent = err["permanent"]
        raise e
    if proc.returncode < 0:
        raise ParseResourceLimit(f"The parser was stopped by signal {-proc.returncode} (resource limit).")
    log.error("parser crashed: %s", proc.stderr[-4000:])
    raise TransientError("parser process crashed")


def process_parse(cfg: Config, conn, storage: Storage, job: dict) -> None:
    owner = cfg.worker_id
    rep = conn.execute("select * from replays where id = %s", (job["replay_id"],)).fetchone()
    if rep is None or rep["deleted_at"] is not None:
        jobs.complete(conn, job, owner, {"skipped": "replay deleted"})
        return
    if rep["revision"] != job["revision"]:
        jobs.complete(conn, job, owner, {"skipped": "superseded revision"})
        return
    if not rep["source_key"]:
        raise SourceMissing("The uploaded demo has expired. Upload it again to process this replay.")
    size = rep["source_size"] or storage.size(rep["source_key"]) or 0
    if size > cfg.max_demo_bytes:
        raise DemoTooLarge("The demo is larger than the configured limit.")
    root = Path(cfg.work_dir)
    root.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(root).free
    # Room for the upload, an extracted demo (when compressed) and parser scratch space.
    if size + min(cfg.max_extracted_bytes, size * 4) + (64 << 20) > min(free, cfg.max_tmp_bytes):
        raise TransientError("Not enough temporary disk space for this demo; will retry.")

    conn.execute("update replays set status = 'processing', updated_at = now() where id = %s and revision = %s and status in ('queued','processing','failed')",
                 (rep["id"], rep["revision"]))
    workdir = root / f"job-{job['id']}-a{job['attempts']}"
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True)
    prefix = f"replays/{rep['id']}/r{rep['revision']}/a{job['attempts']}"
    try:
        with jobs.Heartbeat(cfg.database_url, job["id"], owner, cfg.lease_seconds, cfg.heartbeat_seconds) as hb:
            src = workdir / "source.dem"
            try:
                storage.download(rep["source_key"], str(src), cfg.max_demo_bytes)
            except ValueError as e:
                raise DemoTooLarge(str(e)) from e
            with open(src, "rb") as fh:
                head = fh.read(16)
            kind = archive_kind(head)
            members = list_demos(kind, src) if kind in ("zip", "rar") else []
            if len(members) > 1:
                src = _fan_out_series(cfg, conn, storage, rep, job, kind, src, members, workdir)
                kind = None
                with open(src, "rb") as fh:
                    head = fh.read(16)
            if kind:
                extracted = workdir / "extracted.dem"
                n = extract(kind, src, extracted, cfg.max_extracted_bytes)
                log.info("extracted %s upload: %d -> %d bytes", kind, src.stat().st_size, n)
                src.unlink()
                src = extracted
                with open(src, "rb") as fh:
                    head = fh.read(16)
            classify_header(head, allow_synthetic=cfg.allow_synthetic)
            if hb.lost.is_set():
                raise LeaseLost("lease lost during download")
            series = {"id": rep["series_id"], "mapIndex": rep["series_map_index"]} if rep["series_id"] else None
            manifest, stats = run_parse_child(cfg, {
                "source": str(src), "out_dir": str(workdir / "out"), "map_registry": cfg.map_registry_path,
                "replay_id": rep["id"], "revision": rep["revision"], "prefix": prefix,
                "sample_every": cfg.sample_every_ticks, "allow_synthetic": cfg.allow_synthetic, "series": series,
            }, workdir)
            if hb.lost.is_set():
                raise LeaseLost("lease lost during parsing")
            out = workdir / "out"
            for s in manifest["rounds"]:
                storage.put_bytes(s["payload"]["key"], (out / "rounds" / f"{s['id']}.json.gz").read_bytes(),
                                  "application/json", "gzip")
            import gzip as _gz
            storage.put_bytes(f"{prefix}/manifest.json.gz", _gz.compress(json.dumps(manifest, separators=(",", ":")).encode(), mtime=0),
                              "application/json", "gzip")
            # All round objects must exist before the revision is published.
            for s in manifest["rounds"]:
                if storage.size(s["payload"]["key"]) != s["payload"]["bytes"]:
                    raise TransientError(f"round object {s['id']} missing after upload")
            if hb.lost.is_set() or not jobs.publish(conn, job, owner, prefix, manifest):
                raise LeaseLost("lease lost before publish; another worker owns this job")
            log.info("published replay %s rev %s (%d rounds) %s", rep["id"], rep["revision"], len(manifest["rounds"]), stats)
            conn.execute("update jobs set result = result || %s::jsonb where id = %s", (json.dumps(stats), job["id"]))
    except LeaseLost:
        try:
            storage.delete_prefix(prefix)
        except Exception:  # noqa: BLE001
            log.warning("could not remove orphaned prefix %s; maintenance will retry", prefix)
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    # Source cleanup never blocks playback; on failure maintenance retries it.
    if not cfg.keep_source:
        try:
            storage.delete(rep["source_key"])
            conn.execute("update replays set source_key = null, source_expires_at = null where id = %s and source_key = %s",
                         (rep["id"], rep["source_key"]))
        except Exception:  # noqa: BLE001
            log.warning("source cleanup failed for %s; scheduling retry", rep["id"])
            conn.execute("update replays set source_expires_at = now() where id = %s", (rep["id"],))


def _child_id(parent_id: str, index: int) -> str:
    """Deterministic, so a retried job never creates duplicate series maps."""
    return f"{parent_id}M{index}"


def _fan_out_series(cfg: Config, conn, storage: Storage, rep: dict, job: dict, kind: str, src: Path,
                    members: list[str], workdir: Path) -> Path:
    """A multi-map archive (e.g. a BO3) becomes one replay per map in the same series.

    This replay keeps map 1; maps 2..n get sibling replays (same owner, team and visibility)
    with their own extracted source object and parse job. Returns the path of map 1's demo.
    """
    from .errors import UnsupportedDemo

    if len(members) > MAX_SERIES_DEMOS:
        raise UnsupportedDemo(f"The archive contains {len(members)} demos; at most {MAX_SERIES_DEMOS} maps per upload.",
                              code="ARCHIVE_TOO_MANY_DEMOS")
    series_id = rep["series_id"] or rep["id"]
    base_title = rep["title"] or (rep["source_filename"] or "Series").rsplit(".", 1)[0]
    first = workdir / "map1.dem"
    extract_member(kind, src, members[0], first, cfg.max_extracted_bytes)
    for i, name in enumerate(members[1:], start=2):
        cid = _child_id(rep["id"], i)
        if conn.execute("select 1 from replays where id = %s", (cid,)).fetchone():
            continue  # created by an earlier attempt
        out = workdir / f"map{i}.dem"
        size = extract_member(kind, src, name, out, cfg.max_extracted_bytes)
        key = f"uploads/{rep['owner_id']}/{cid}.dem"
        storage.put_file(key, str(out), "application/octet-stream")
        out.unlink()
        with conn.transaction():
            conn.execute(
                "insert into replays(id, owner_id, team_id, title, status, visibility, source_key, source_size, source_filename, "
                "source_expires_at, series_id, series_map_index) values (%s,%s,%s,%s,'queued',%s,%s,%s,%s, now() + interval '3 days', %s, %s) "
                "on conflict (id) do nothing",
                (cid, rep["owner_id"], rep["team_id"], f"{base_title} · map {i}", rep["visibility"], key, size,
                 name.rsplit("/", 1)[-1], series_id, i),
            )
            conn.execute("insert into jobs(replay_id, revision, kind) values (%s, 1, 'parse') on conflict do nothing", (cid,))
        log.info("series %s: queued map %d (%s) as %s", series_id, i, name, cid)
    conn.execute(
        "update replays set series_id = coalesce(series_id, %s), series_map_index = coalesce(series_map_index, 1), "
        "title = coalesce(title, %s) where id = %s",
        (series_id, f"{base_title} · map 1", rep["id"]),
    )
    src.unlink()
    return first


def process_cleanup(cfg: Config, conn, storage: Storage, job: dict) -> None:
    rid = job["replay_id"]
    n = storage.delete_prefix(f"replays/{rid}")
    n += storage.delete_prefix(f"audio/{rid}")
    rep = conn.execute("select source_key from replays where id = %s", (rid,)).fetchone()
    if rep and rep["source_key"]:
        storage.delete(rep["source_key"])
        n += 1
    conn.execute("update replays set source_key = null, published_prefix = null where id = %s", (rid,))
    conn.execute("update audio_tracks set status = 'deleted' where replay_id = %s", (rid,))
    jobs.complete(conn, job, cfg.worker_id, {"deletedObjects": n})

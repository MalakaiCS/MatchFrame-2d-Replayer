"""Worker configuration from environment variables."""

from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _default_registry() -> str:
    return str(Path(__file__).resolve().parents[2] / "web" / "src" / "shared" / "maps.json")


@dataclass(frozen=True)
class Config:
    database_url: str = field(default_factory=lambda: os.environ["DATABASE_URL"])
    storage_driver: str = field(default_factory=lambda: os.environ.get("STORAGE_DRIVER", "fs"))
    storage_fs_root: str = field(default_factory=lambda: os.environ.get("STORAGE_FS_ROOT", "./.data/objects"))
    s3_bucket: str = field(default_factory=lambda: os.environ.get("S3_BUCKET", ""))
    s3_endpoint: str | None = field(default_factory=lambda: os.environ.get("S3_ENDPOINT") or None)
    s3_region: str = field(default_factory=lambda: os.environ.get("S3_REGION", "auto"))
    map_registry_path: str = field(default_factory=lambda: os.environ.get("MAP_REGISTRY_PATH", _default_registry()))
    work_dir: str = field(default_factory=lambda: os.environ.get("WORKER_TMP_DIR", "/tmp/matchframe-worker"))
    max_demo_bytes: int = field(default_factory=lambda: _int("MAX_DEMO_BYTES", 512 * 1024 * 1024))
    # Cap on the demo extracted from a .bz2/.gz/.zip/.rar upload (tournament demos are often 300-500 MiB).
    max_extracted_bytes: int = field(default_factory=lambda: _int("MAX_EXTRACTED_DEMO_BYTES", 1536 * 1024 * 1024))
    max_tmp_bytes: int = field(default_factory=lambda: _int("WORKER_MAX_TMP_BYTES", 4 * 1024 * 1024 * 1024))
    parse_memory_bytes: int = field(default_factory=lambda: _int("WORKER_PARSE_MEMORY_BYTES", 6 * 1024 * 1024 * 1024))
    parse_timeout_s: int = field(default_factory=lambda: _int("WORKER_PARSE_TIMEOUT_S", 900))
    lease_seconds: int = field(default_factory=lambda: _int("WORKER_LEASE_SECONDS", 60))
    heartbeat_seconds: int = field(default_factory=lambda: _int("WORKER_HEARTBEAT_SECONDS", 15))
    poll_seconds: float = field(default_factory=lambda: _float("WORKER_POLL_SECONDS", 2.0))
    backoff_base_s: int = field(default_factory=lambda: _int("WORKER_BACKOFF_BASE_S", 30))
    backoff_max_s: int = field(default_factory=lambda: _int("WORKER_BACKOFF_MAX_S", 900))
    maintenance_every_s: int = field(default_factory=lambda: _int("MAINTENANCE_EVERY_S", 300))
    failed_source_ttl_s: int = field(default_factory=lambda: _int("FAILED_SOURCE_TTL_S", 24 * 3600))
    abandoned_revision_age_s: int = field(default_factory=lambda: _int("ABANDONED_REVISION_AGE_S", 3600))
    keep_source: bool = field(default_factory=lambda: os.environ.get("KEEP_SOURCE_AFTER_PARSE", "0") == "1")
    allow_synthetic: bool = field(default_factory=lambda: os.environ.get("MF_ALLOW_SYNTHETIC", "0") == "1")
    sample_every_ticks: int = field(default_factory=lambda: _int("SAMPLE_EVERY_TICKS", 4))
    worker_id: str = field(default_factory=lambda: f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}")

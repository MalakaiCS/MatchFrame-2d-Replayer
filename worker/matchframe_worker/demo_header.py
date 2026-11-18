"""Cheap, pre-parse validation of the uploaded file header."""

from __future__ import annotations

from .errors import InvalidDemo, UnsupportedDemo

CS2_MAGIC = b"PBDEMS2\x00"
LEGACY_MAGIC = b"HL2DEMO\x00"
SYNTHETIC_MAGIC = b"MFSYNTH1"

_COMPRESSED = {
    b"\x1f\x8b": "gzip",
    b"BZh": "bzip2",
    b"PK\x03\x04": "zip",
    b"\xfd7zXZ": "xz",
    b"7z\xbc\xaf": "7z",
    b"Rar!": "rar",
    b"\x28\xb5\x2f\xfd": "zstd",
}


def classify_header(head: bytes, *, allow_synthetic: bool = False) -> str:
    """Return 'cs2' or 'synthetic'; raise a permanent error for anything else."""
    if head.startswith(CS2_MAGIC):
        return "cs2"
    if head.startswith(SYNTHETIC_MAGIC):
        if allow_synthetic:
            return "synthetic"
        raise UnsupportedDemo("Synthetic fixtures are disabled on this deployment.", code="UNSUPPORTED_FORMAT")
    if head.startswith(LEGACY_MAGIC):
        raise UnsupportedDemo("This is a CS:GO (Source 1) demo. Only CS2 demos are supported.", code="LEGACY_DEMO")
    for magic, kind in _COMPRESSED.items():
        if head.startswith(magic):
            raise UnsupportedDemo(
                f"The file is a {kind} archive. Extract it and upload the .dem file.", code="COMPRESSED_ARCHIVE"
            )
    raise InvalidDemo("The file is not a CS2 demo (missing PBDEMS2 header).")

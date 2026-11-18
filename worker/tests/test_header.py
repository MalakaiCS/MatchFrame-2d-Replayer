import pytest

from matchframe_worker.demo_header import classify_header
from matchframe_worker.errors import InvalidDemo, UnsupportedDemo


def test_cs2_magic():
    assert classify_header(b"PBDEMS2\x00\x10\x00\x00\x00") == "cs2"


@pytest.mark.parametrize("head,code", [
    (b"HL2DEMO\x00rest", "LEGACY_DEMO"),
    (b"\x1f\x8b\x08\x00....", "COMPRESSED_ARCHIVE"),
    (b"PK\x03\x04....", "COMPRESSED_ARCHIVE"),
    (b"BZh91AY&SY", "COMPRESSED_ARCHIVE"),
])
def test_unsupported(head, code):
    with pytest.raises(UnsupportedDemo) as e:
        classify_header(head)
    assert e.value.code == code and e.value.permanent


def test_garbage_is_invalid():
    with pytest.raises(InvalidDemo):
        classify_header(b"hello world, not a demo")


def test_synthetic_gated():
    with pytest.raises(UnsupportedDemo):
        classify_header(b"MFSYNTH1{}")
    assert classify_header(b"MFSYNTH1{}", allow_synthetic=True) == "synthetic"

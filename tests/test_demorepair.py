"""Demo repair on small hand-built demos: frames, snappy, bit-shifted messages, protobuf."""

import json

import pytest
from awpy import InvalidDemoError

from cs2lens import demorepair, extract as extract_module
from cs2lens.demorepair import _encode_varint as v, _fields, _repair_stream, _snappy, repair_demo

BAD = b"\x90\xeeP\x96@\x05"


def field(number: int, data: bytes) -> bytes:
    return v(number << 3 | 2) + v(len(data)) + data


def event(*values: bytes) -> bytes:
    """A legacy game event with these string values, and an integer key between them."""
    keys = b"".join(field(3, v(1 << 3) + v(1) + field(2, s)) for s in values)
    return v(2 << 3) + v(7) + field(3, v(1 << 3) + v(3) + v(4 << 3) + v(9)) + keys


def stream(*messages: tuple[int, bytes]) -> bytes:
    """Messages as the game writes them: type and size bit-packed, so nothing is byte-aligned."""
    bits = length = 0

    def put(value: int, count: int) -> None:
        nonlocal bits, length
        bits |= value << length
        length += count

    for kind, body in messages:
        if kind < 16:
            put(kind, 6)
        else:
            put(kind & 15 | 32, 6)
            put(kind >> 4, 8)
        for b in v(len(body)):
            put(b, 8)
        put(int.from_bytes(body, "little"), len(body) * 8)
    return bits.to_bytes((length + 7) // 8, "little")


def literal_snappy(data: bytes) -> bytes:
    size = len(data) - 1
    head = bytes([size << 2]) if size < 60 else bytes([61 << 2]) + size.to_bytes(2, "little")
    return v(len(data)) + head + data


def frame(cmd: int, tick: int, payload: bytes, compressed: bool = True) -> bytes:
    body = literal_snappy(payload) if compressed else payload
    return v(cmd | (64 if compressed else 0)) + v(tick) + v(len(body)) + body


def demo(*frames: bytes) -> bytes:
    body = b"".join(frames)
    tail = frame(0, 0, b"", compressed=False)
    info = 16 + len(body) + len(tail)
    return b"PBDEMS2\0" + info.to_bytes(4, "little") + (info + 1).to_bytes(4, "little") + body + tail + b"fileinfo"


def walk(data: bytes):
    """Frames back out of a demo: (cmd, tick, decompressed payload)."""
    i = 16
    out = []
    while True:
        cmd, i = demorepair._varint(data, i)
        tick, i = demorepair._varint(data, i)
        size, i = demorepair._varint(data, i)
        raw = data[i:i + size]
        i += size
        out.append((cmd & ~64, tick, _snappy(raw) if cmd & 64 else raw))
        if cmd == 0:
            return out, i


def messages(d: bytes):
    """Parse a stream with the repair's own reader by repairing nothing further: bodies of legacy events."""
    pos, end = 0, len(d) * 8
    found = []
    while end - pos > 8:
        kind = demorepair._bits(d, pos, 6)
        pos += 6
        if kind & 0x30:
            extra = {16: 4, 32: 8, 48: 28}[kind & 0x30]
            kind = (kind & 15) | (demorepair._bits(d, pos, extra) << 4)
            pos += extra
        size = shift = 0
        while True:
            c = demorepair._bits(d, pos, 8)
            pos += 8
            size |= (c & 127) << shift
            shift += 7
            if c < 128:
                break
        found.append((kind, demorepair._bits(d, pos, size * 8).to_bytes(size, "little")))
        pos += size * 8
    return found


def test_repairs_only_the_broken_string(tmp_path):
    good = event(b"Operator", "ник".encode())
    broken = event(b"Operator", BAD, "ник".encode())
    noise = (5, b"\xff\xfe\xfd")  # binary, not an event: left alone even though it is not UTF-8
    packet = field(3, stream(noise, (207, good), (207, broken), noise))
    other = field(3, stream((207, good)))
    src, dst = tmp_path / "a.dem", tmp_path / "b.dem"
    src.write_bytes(demo(frame(7, 100, other), frame(8, 200, b"x" * 70, compressed=False), frame(7, 300, packet), frame(7, 400, other)))

    assert repair_demo(src, dst) == 1
    frames, _ = walk(dst.read_bytes())
    assert [(c, t) for c, t, _ in frames] == [(7, 100), (8, 200), (7, 300), (7, 400), (0, 0)]
    assert frames[2][2] != packet and len(frames[2][2]) == len(packet)
    [stream_bytes] = [v2 for n, v2, _ in _fields(frames[2][2]) if n == 3]
    found = messages(stream_bytes)
    assert found[0] == noise and found[3] == noise and found[1] == (207, good)
    assert found[2] == (207, event(b"Operator", b"?" * len(BAD), "ник".encode()))
    # untouched frames are the same bytes
    assert frames[0][2] == other and frames[3][2] == other


def test_header_offsets_follow_the_grown_frame(tmp_path):
    packet = field(3, stream((207, event(BAD))))
    src, dst = tmp_path / "a.dem", tmp_path / "b.dem"
    src.write_bytes(demo(frame(7, 1, packet)))
    assert repair_demo(src, dst) == 1
    data = dst.read_bytes()
    _, stop_end = walk(data)
    assert int.from_bytes(data[8:12], "little") == stop_end
    assert data[stop_end:] == b"fileinfo"
    assert int.from_bytes(data[12:16], "little") == stop_end + 1


def test_full_packet_is_repaired(tmp_path):
    inner = field(3, stream((207, event(BAD))))
    src, dst = tmp_path / "a.dem", tmp_path / "b.dem"
    src.write_bytes(demo(frame(13, 5, field(1, b"tables") + field(2, inner))))
    assert repair_demo(src, dst) == 1
    frames, _ = walk(dst.read_bytes())
    assert b"?" * len(BAD) not in frames[0][2]  # bit-shifted, so compare by parsing
    [packet] = [p for n, p, _ in _fields(frames[0][2]) if n == 2]
    [s] = [x for n, x, _ in _fields(packet) if n == 3]
    assert messages(s) == [(207, event(b"?" * len(BAD)))]


def test_a_healthy_demo_is_not_copied(tmp_path):
    src, dst = tmp_path / "a.dem", tmp_path / "b.dem"
    src.write_bytes(demo(frame(7, 1, field(3, stream((207, event(b"fine")))))))
    assert repair_demo(src, dst) == 0
    assert not dst.exists()
    assert _repair_stream(stream((207, event(b"fine"))))[1] == 0


class FakeDemo:
    """Refuses the original demo the way awpy does; fine with the repaired copy."""

    opened: list[str] = []
    header = {"map_name": "de_test"}
    tick_rate = 64.0
    events = type("E", (), {"names": []})()

    def __init__(self, path):
        self.path = str(path)
        FakeDemo.opened.append(self.path)

    @staticmethod
    def available_datasets():
        return []

    def load(self, *_names):
        if not self.path.endswith("_repaired.dem"):
            raise InvalidDemoError(self.message)

    message = "protobuf decode error: invalid string value: data is not UTF-8 encoded"


def _setup(tmp_path, monkeypatch, count):
    FakeDemo.opened = []
    monkeypatch.setattr(extract_module, "Demo", FakeDemo)
    monkeypatch.setattr(extract_module, "write_replay", lambda *a, **k: 0)

    def fake_repair(_src, dst):
        if count:
            type(dst)(dst).write_bytes(b"copy")
        return count

    monkeypatch.setattr(extract_module, "repair_demo", fake_repair)
    return tmp_path / "out"


def test_extract_falls_back_to_a_repaired_copy(tmp_path, monkeypatch):
    out = _setup(tmp_path, monkeypatch, 1)
    manifest = extract_module.extract(tmp_path / "m.dem", out)
    assert manifest["repaired_strings"] == 1
    assert manifest["demo_path"].endswith("m.dem")  # the original stays the demo of this match
    assert json.loads((out / "manifest.json").read_text(encoding="utf-8"))["repaired_strings"] == 1
    assert not (out / "_repaired.dem").exists()
    assert len(FakeDemo.opened) == 2


def test_other_errors_and_unrepairable_demos_still_fail(tmp_path, monkeypatch):
    out = _setup(tmp_path, monkeypatch, 0)
    with pytest.raises(InvalidDemoError):
        extract_module.extract(tmp_path / "m.dem", out)  # says "not UTF-8" but nothing was found to repair
    monkeypatch.setattr(FakeDemo, "message", "not a demo at all")
    out = _setup(tmp_path, monkeypatch, 1)
    with pytest.raises(InvalidDemoError):
        extract_module.extract(tmp_path / "m.dem", out)
    assert FakeDemo.opened == [str(tmp_path / "m.dem")]  # no repair attempted

"""Repair demos the parser refuses because of one broken string.

Some demos carry a game event with bytes that are not UTF-8, seen as a garbage ``networkid``
in the ``player_disconnect`` of a bot. awpy then rejects every event of the demo, and without
rounds nothing can be analysed. ``repair_demo`` writes a copy with those bytes replaced by the
same number of ``?``; the original is left alone and stays what CS2 opens.

A demo is a chain of frames (command, tick, size, protobuf, snappy-compressed if flagged). In a
packet frame the protobuf holds a bit stream of messages, not aligned to bytes. Only the frames
that change are written anew, uncompressed; the file header's offsets follow.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

HEADER = 16  # magic (8), offset of the file info (4), offset of the spawn groups (4)
COMPRESSED = 64
PACKET_FRAMES = (7, 8)  # DEM_Packet, DEM_SignonPacket: CDemoPacket with its stream in field 3
FULL_PACKET = 13  # DEM_FullPacket: the CDemoPacket is in field 2
LEGACY_EVENT = 207  # GE_Source1LegacyGameEvent: its keys are field 3, a key's val_string field 2


def _varint(b: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        c = b[i]
        i += 1
        value |= (c & 127) << shift
        shift += 7
        if c < 128:
            return value, i


def _encode_varint(value: int) -> bytes:
    out = bytearray()
    while value >= 128:
        out.append(value & 127 | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def _snappy(src: bytes) -> bytes:
    """Decompress a snappy block (pure Python: this runs only for the rare broken demo)."""
    _, i = _varint(src, 0)
    out = bytearray()
    while i < len(src):
        tag = src[i]
        i += 1
        kind = tag & 3
        if kind == 0:  # literal
            length = tag >> 2
            if length >= 60:
                extra = length - 59
                length = int.from_bytes(src[i:i + extra], "little")
                i += extra
            length += 1
            out += src[i:i + length]
            i += length
            continue
        if kind == 1:
            length = 4 + ((tag >> 2) & 7)
            offset = ((tag >> 5) << 8) | src[i]
            i += 1
        else:
            length = (tag >> 2) + 1
            size = 2 if kind == 2 else 4
            offset = int.from_bytes(src[i:i + size], "little")
            i += size
        start = len(out) - offset
        if offset >= length:
            out += out[start:start + length]
        else:  # the copy overlaps what it writes
            for k in range(length):
                out.append(out[start + k])
    return bytes(out)


def _fields(b: bytes | bytearray) -> Iterator[tuple[int, int | bytes, int]]:
    """Protobuf fields: (number, value, where a length-delimited value starts)."""
    i = 0
    while i < len(b):
        key, i = _varint(b, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(b, i)
            yield number, value, i
        elif wire == 2:
            size, i = _varint(b, i)
            yield number, bytes(b[i:i + size]), i
            i += size
        elif wire in (1, 5):
            i += 8 if wire == 1 else 4
        else:
            return


def _bits(d: bytes, pos: int, count: int) -> int:
    return (int.from_bytes(d[pos >> 3:(pos + count + 7) >> 3], "little") >> (pos & 7)) & ((1 << count) - 1)


def _repair_event(body: bytes) -> tuple[bytes, int]:
    """The event with each non-UTF-8 string value replaced by as many ``?``, and how many there were."""
    fixed = bytearray(body)
    count = 0
    for number, key, key_at in _fields(body):
        if number != 3 or not isinstance(key, bytes):
            continue
        for sub, value, value_at in _fields(key):
            if sub != 2 or not isinstance(value, bytes):
                continue
            try:
                value.decode("utf-8")
            except UnicodeDecodeError:
                fixed[key_at + value_at:key_at + value_at + len(value)] = b"?" * len(value)
                count += 1
    return bytes(fixed), count


def _repair_stream(d: bytes) -> tuple[bytes, int]:
    """The message stream of a packet with its broken events repaired; sizes do not change."""
    pos, end = 0, len(d) * 8
    count = 0
    patched = None
    while end - pos > 8:
        kind = _bits(d, pos, 6)
        pos += 6
        selector = kind & 0x30
        if selector:
            extra = {16: 4, 32: 8, 48: 28}[selector]
            kind = (kind & 15) | (_bits(d, pos, extra) << 4)
            pos += extra
        size = shift = 0
        while True:
            c = _bits(d, pos, 8)
            pos += 8
            size |= (c & 127) << shift
            shift += 7
            if c < 128:
                break
        if kind == LEGACY_EVENT and size:
            body = _bits(d, pos, size * 8).to_bytes(size, "little")
            fixed, n = _repair_event(body)
            if n:
                count += n
                value = patched if patched is not None else int.from_bytes(d, "little")
                mask = ((1 << size * 8) - 1) << pos
                patched = value & ~mask | int.from_bytes(fixed, "little") << pos
        pos += size * 8
    return (patched.to_bytes(len(d), "little") if patched is not None else d), count


def _repair_frame(cmd: int, raw: bytes) -> tuple[bytes, int]:
    """A packet frame's protobuf with its streams repaired (same length)."""
    fixed = bytearray(raw)
    count = 0
    for number, value, at in _fields(raw):
        if not isinstance(value, bytes):
            continue
        if cmd == FULL_PACKET and number == 2:
            streams = [(v, at + inner) for n, v, inner in _fields(value) if n == 3 and isinstance(v, bytes)]
        elif cmd != FULL_PACKET and number == 3:
            streams = [(value, at)]
        else:
            continue
        for stream, stream_at in streams:
            repaired, n = _repair_stream(stream)
            if n:
                count += n
                fixed[stream_at:stream_at + len(stream)] = repaired
    return bytes(fixed), count


def repair_demo(src: str | Path, dst: str | Path) -> int:
    """Write a repaired copy of ``src`` to ``dst``. Returns how many strings were replaced;
    with 0 there was nothing to repair and ``dst`` is not written."""
    data = Path(src).read_bytes()
    pieces: list[bytes] = [data[:HEADER]]
    changes: list[tuple[int, int]] = []  # (old position of a frame, how much it grew)
    total = 0
    copied = i = HEADER
    while i < len(data):
        frame_at = i
        command, i = _varint(data, i)
        tick, i = _varint(data, i)
        size, i = _varint(data, i)
        cmd = command & ~COMPRESSED
        if cmd == 0:  # DEM_Stop: what follows is the file info
            break
        payload_at = i
        i += size
        if cmd not in (*PACKET_FRAMES, FULL_PACKET):
            continue
        raw = data[payload_at:i]
        if command & COMPRESSED:
            raw = _snappy(raw)
        fixed, n = _repair_frame(cmd, raw)
        if not n:
            continue
        total += n
        frame = _encode_varint(cmd) + _encode_varint(tick) + _encode_varint(len(fixed)) + fixed
        pieces += [data[copied:frame_at], frame]
        copied = i
        changes.append((frame_at, len(frame) - (i - frame_at)))
    if not total:
        return 0
    pieces.append(data[copied:])

    def moved(offset: int) -> int:
        return offset + sum(grew for at, grew in changes if at < offset)

    pieces[0] = data[:8] + b"".join(moved(int.from_bytes(data[k:k + 4], "little")).to_bytes(4, "little") for k in (8, 12))
    Path(dst).write_bytes(b"".join(pieces))
    return total

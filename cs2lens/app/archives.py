"""Unpack .dem files from uploaded archives.

zip, tar (plain or compressed) and single compressed files (``x.dem.gz``, ``.bz2``, ``.xz``,
``.zst``) are read with the standard library (``zstandard`` for ``.zst`` before Python 3.14).
Everything else (rar, 7z) goes through bsdtar (libarchive), which ships with Windows 10+ as
``System32\\tar.exe``. Only ``.dem`` members are kept; they are written flat into the target
folder under their base name, so paths inside the archive cannot escape it.
"""

from __future__ import annotations

import bz2
import gzip
import lzma
import os
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import IO

ARCHIVE_SUFFIXES = (".zip", ".rar", ".7z", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".zst")
CHUNK = 1 << 20
DEMO_MAGIC = b"PBDEMS2\0"

Progress = Callable[[float, str], None]


def is_archive(name: str) -> bool:
    return name.lower().endswith(ARCHIVE_SUFFIXES)


def _target(dest: Path, name: str, size: int | None) -> Path | None:
    """Where to write a member called ``name``; None when the same file (by size) is already there."""
    base = Path(name.replace("\\", "/")).name
    path = dest / base
    n = 2
    while path.exists():
        if size is not None and path.stat().st_size == size:
            return None
        path = dest / f"{Path(base).stem}_{n}.dem"
        n += 1
    return path


def _copy(src: IO[bytes], path: Path, progress: Callable[[int], None]) -> None:
    part = path.with_name(path.name + ".part")
    with part.open("wb") as out:
        while chunk := src.read(CHUNK):
            out.write(chunk)
            progress(len(chunk))
    part.replace(path)


def _bsdtar() -> str | None:
    system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "tar.exe"
    if system.exists():
        return str(system)
    return shutil.which("bsdtar") or shutil.which("tar")


def _zstd_open(path: Path) -> IO[bytes]:
    try:
        from compression import zstd  # Python 3.14+

        return zstd.open(path, "rb")
    except ImportError:
        import zstandard

        return zstandard.ZstdDecompressor().stream_reader(path.open("rb"), closefd=True)


SINGLE = {".gz": gzip.open, ".bz2": bz2.open, ".xz": lzma.open, ".zst": _zstd_open}


def _members(archive: Path) -> Iterator[tuple[str, int | None, Callable[[], IO[bytes]]]]:
    """(name, size, open) for every .dem inside a zip or tar archive."""
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                if not info.is_dir() and info.filename.lower().endswith(".dem"):
                    yield info.filename, info.file_size, lambda info=info: z.open(info)
        return
    with tarfile.open(archive, "r:*") as t:
        for member in t:
            if member.isfile() and member.name.lower().endswith(".dem"):
                yield member.name, member.size, lambda member=member: t.extractfile(member)


def unpack(archive: str | Path, dest: str | Path, progress: Progress | None = None) -> list[Path]:
    """Extract every .dem from ``archive`` into ``dest``; returns the demo paths (new or already present)."""
    archive, dest = Path(archive), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    total = max(archive.stat().st_size, 1)
    done = 0

    def advance(n: int) -> None:
        nonlocal done
        done += n
        if progress:
            progress(min(done / total, 0.99), "unpacking")

    if progress:
        progress(0.01, "unpacking")
    found: list[Path] = []
    suffix = archive.suffix.lower()
    if zipfile.is_zipfile(archive) or (suffix != ".zst" and _is_tar(archive)):
        for name, size, open_member in _members(archive):
            path = _target(dest, name, size)
            if path is None:
                found.append(dest / Path(name.replace("\\", "/")).name)
                continue
            with open_member() as src:
                _copy(src, path, advance)
            found.append(path)
    elif suffix in SINGLE:
        name = archive.name[: -len(suffix)]
        with SINGLE[suffix](archive) as src:
            if src.read(len(DEMO_MAGIC)) != DEMO_MAGIC:
                raise ValueError(f"{archive.name}: not a compressed .dem")
        if not name.lower().endswith(".dem"):
            name += ".dem"
        path = _target(dest, name, None)
        with SINGLE[suffix](archive) as src:
            _copy(src, path, advance)
        found.append(path)
    else:
        found = _unpack_bsdtar(archive, dest)
    if not found:
        raise ValueError(f"{archive.name}: no .dem files inside")
    return found


def _is_tar(path: Path) -> bool:
    try:
        return tarfile.is_tarfile(path)
    except (OSError, tarfile.TarError, EOFError):
        return False


def _unpack_bsdtar(archive: Path, dest: Path) -> list[Path]:
    tar = _bsdtar()
    if tar is None:
        raise RuntimeError(f"{archive.name}: unpacking {archive.suffix} needs bsdtar (tar.exe in Windows 10+)")
    found = []
    with tempfile.TemporaryDirectory(dir=dest, prefix=".unpack-") as tmp:
        # bsdtar strips absolute paths and ".." from member names by default.
        r = subprocess.run([tar, "-xf", str(archive), "-C", tmp, "*.dem"], capture_output=True, text=True)
        demos = sorted(Path(tmp).rglob("*.dem"))
        if r.returncode and not demos:
            raise RuntimeError(f"{archive.name}: {r.stderr.strip() or 'cannot unpack'}")
        for p in demos:
            path = _target(dest, p.name, p.stat().st_size)
            if path is None:
                found.append(dest / p.name)
                continue
            shutil.move(p, path)
            found.append(path)
    return found

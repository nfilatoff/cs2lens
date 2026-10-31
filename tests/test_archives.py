import gzip
import tarfile
import zipfile

import pytest

from cs2lens.app.archives import DEMO_MAGIC, is_archive, unpack

DEMO = DEMO_MAGIC + b"payload"


def test_zip_tar_gz(tmp_path):
    src = tmp_path / "src"
    (src / "sub").mkdir(parents=True)
    (src / "sub" / "a.dem").write_bytes(DEMO)
    (src / "readme.txt").write_text("x")
    with zipfile.ZipFile(tmp_path / "x.zip", "w") as z:
        z.write(src / "sub" / "a.dem", "sub/a.dem")
        z.write(src / "readme.txt", "readme.txt")
        z.writestr("../../evil.dem", DEMO + b"2")
    with tarfile.open(tmp_path / "x.tar.gz", "w:gz") as t:
        t.add(src / "sub" / "a.dem", "deep/a.dem")
    (tmp_path / "b.dem.gz").write_bytes(gzip.compress(DEMO))

    out = tmp_path / "out"
    assert sorted(p.name for p in unpack(tmp_path / "x.zip", out)) == ["a.dem", "evil.dem"]
    assert [p.name for p in unpack(tmp_path / "x.tar.gz", out)] == ["a.dem"]  # same size: kept, not duplicated
    assert [p.name for p in unpack(tmp_path / "b.dem.gz", out)] == ["b.dem"]
    assert sorted(p.name for p in out.iterdir()) == ["a.dem", "b.dem", "evil.dem"]  # nothing escaped out/
    assert (out / "b.dem").read_bytes() == DEMO


def test_rejects_non_demos(tmp_path):
    (tmp_path / "x.txt.gz").write_bytes(gzip.compress(b"hello"))
    with pytest.raises(ValueError):
        unpack(tmp_path / "x.txt.gz", tmp_path / "out")
    assert is_archive("a.rar") and is_archive("A.DEM.ZST") and not is_archive("a.dem")

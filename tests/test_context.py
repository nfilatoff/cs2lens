import json
import shutil

import polars as pl

from cs2lens.context import load_match, with_round

ROUNDS = pl.DataFrame(
    {
        "round_num": [1, 2],
        "start_tick": [0, 1000],
        "freeze_end_tick": [100, 1100],
        "end_tick": [800, 1800],
    },
    schema_overrides={"start_tick": pl.Int32, "freeze_end_tick": pl.Int32, "end_tick": pl.Int32},
)


def test_with_round_binds_ticks_and_drops_gaps():
    df = pl.DataFrame({"tick": [50, 800, 900, 1000, 1500, 2000], "v": list("abcdef")})
    out = with_round(df, ROUNDS)
    assert out.select("v", "round_num").rows() == [("a", 1), ("b", 1), ("d", 2), ("e", 2)]


def test_with_round_drops_ticks_before_first_round():
    rounds = ROUNDS.with_columns(pl.col("start_tick") + 10)
    out = with_round(pl.DataFrame({"tick": [5, 20]}), rounds)
    assert out["tick"].to_list() == [20]


def test_load_match_sides_and_teams(dust2_mini):
    m = load_match(dust2_mini)
    assert m.map_name == "de_dust2"
    # Two teams, one side each per round, never the same side.
    per_round = m.sides.group_by("round_num").agg(pl.col("team").n_unique(), pl.col("side").n_unique(), pl.len())
    assert per_round["team"].to_list() == [2] * m.rounds.height
    assert per_round["side"].to_list() == [2] * m.rounds.height
    assert per_round["len"].to_list() == [2] * m.rounds.height
    # One winner per round, consistent with the round table.
    assert m.tr.group_by("round_num").agg(pl.col("won").sum())["won"].to_list() == [1] * m.rounds.height


def test_snapshot_offset(dust2_mini):
    m = load_match(dust2_mini)
    assert (m.snap_step, m.snap_offset) == (32, 1)
    assert m.snap_floor(1000) == 993
    snap_ticks = set(m.data["snapshots"]["tick"].to_list())
    assert m.snap_floor(20000) in snap_ticks


def test_coach_is_not_a_player(dust2_mini, tmp_path):
    from cs2lens.team_stats import team_stats

    d = tmp_path / "m"
    shutil.copytree(dust2_mini, d)
    before = team_stats(d)["summary"].select("team", "adr", "kast").sort("team")
    stats = pl.read_parquet(d / "stats.parquet")
    coach = stats.head(1).with_columns(
        pl.lit(1, pl.UInt64).alias("steamid"), pl.lit("").alias("name"),
        *[pl.lit(0).cast(stats.schema[c]).alias(c) for c in ("kills", "deaths", "assists", "adr", "kast")],
    )
    pl.concat([stats, coach]).write_parquet(d / "stats.parquet")
    players = pl.read_parquet(d / "players.parquet")
    pl.concat([players, players.head(1).with_columns(pl.lit(1, pl.UInt64).alias("steamid"))]).write_parquet(d / "players.parquet")
    m = load_match(d)
    assert 1 not in m.teams["steamid"].to_list()
    assert team_stats(d)["summary"].select("team", "adr", "kast").sort("team").equals(before)


def test_missing_first_round_start_is_filled(dust2_mini, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(dust2_mini, d)
    rounds = pl.read_parquet(d / "rounds.parquet")
    rounds.with_columns(pl.when(pl.col("round_num") == 1).then(None).otherwise(pl.col("start_tick")).alias("start_tick")).write_parquet(d / "rounds.parquet")
    m = load_match(d)
    assert m.rounds.filter(pl.col("round_num") == 1)["start_tick"].item() == 0
    assert json.loads((d / "manifest.json").read_text())["tick_rate"] == m.tick_rate

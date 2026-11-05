import json
import shutil

import polars as pl

from cs2lens.context import alive_counts, load_match, round_context, with_man_diff, with_round

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


def test_round_context_one_row_per_round_and_team(dust2_mini):
    m = load_match(dust2_mini)
    ctx = round_context(m)
    assert ctx.height == m.tr.height
    assert ctx.group_by("round_num", "team").len()["len"].max() == 1
    assert ctx.filter(pl.col("is_pistol"))["round_num"].unique().to_list() == [1]


def test_round_context_follows_the_score(dust2_mini):
    ctx = round_context(load_match(dust2_mini))
    for _team, g in ctx.sort("round_num").group_by("team", maintain_order=True):
        rows = g.rows(named=True)
        assert rows[0]["prev_won"] is None and rows[0]["loss_streak"] == 0
        streak = 0
        for prev, cur in zip(rows, rows[1:]):
            assert cur["prev_won"] == prev["won"]
            streak = 0 if prev["won"] else streak + 1
            assert cur["loss_streak"] == streak
        # after_pistol_loss is set only in the round after the pistol round
        assert rows[1]["after_pistol_loss"] == (not rows[0]["won"])
        assert all(r["after_pistol_loss"] is None for r in rows[2:])


def test_round_context_alive_counts(dust2_mini):
    m = load_match(dust2_mini)
    ctx = round_context(m)
    assert ctx["alive_t_end"].drop_nulls().is_between(0, 5).all()
    assert ctx["alive_ct_end"].drop_nulls().is_between(0, 5).all()
    # without a plant a round ends by elimination: the losers have nobody alive (a bomb can end it with survivors)
    no_plant = ctx.filter(pl.col("alive_t_plant").is_null())
    assert no_plant.filter(pl.col("winner_side") == "terrorist")["alive_ct_end"].unique().to_list() == [0]
    assert no_plant.filter(pl.col("winner_side") == "counter-terrorist")["alive_t_end"].unique().to_list() == [0]
    planted = with_round(m.data["bomb"].filter(pl.col("event") == "finish_plant").select("tick"), m.rounds)["round_num"].to_list()
    assert set(ctx.filter(pl.col("alive_t_plant").is_not_null())["round_num"].to_list()) == set(planted)


def test_man_diff_uses_the_rows_side():
    alive = pl.DataFrame({"tick": [0, 100], "alive_t": [5, 4], "alive_ct": [5, 2]}, schema_overrides={"tick": pl.Int32, "alive_t": pl.Int32, "alive_ct": pl.Int32})
    df = pl.DataFrame({"tick": [50, 150, 150, 150], "side": ["terrorist", "terrorist", "counter-terrorist", None]})
    assert with_man_diff(df, alive)["man_diff"].to_list() == [0, 2, -2, None]


def test_alive_counts_start_full(dust2_mini):
    m = load_match(dust2_mini)
    alive = alive_counts(m)
    at_freeze = m.rounds.select(tick=pl.col("freeze_end_tick").cast(pl.Int32)).sort("tick").join_asof(alive, on="tick")
    assert at_freeze["alive_t"].to_list() == [5] * m.rounds.height
    assert at_freeze["alive_ct"].to_list() == [5] * m.rounds.height

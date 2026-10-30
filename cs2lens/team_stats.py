"""Team-level statistics computed from an ``extract`` output directory."""

from __future__ import annotations

from pathlib import Path

import polars as pl

from cs2lens.context import load_match
from cs2lens.context import pct as _pct
from cs2lens.context import with_round as _with_round



def team_stats(directory: str | Path) -> dict[str, pl.DataFrame]:
    """Compute team tables. Knife rounds are excluded.

    Returns ``summary``, ``by_side``, ``by_buy``, ``win_reasons``, ``opening``,
    ``trades``, ``bomb_t`` and ``bomb_ct``, each with a ``team`` column.
    """
    m = load_match(directory)
    data, tick_rate, rounds, teams, tr = m.data, m.tick_rate, m.rounds, m.teams, m.tr

    by_side = (
        tr.group_by("team", "side")
        .agg(rounds=pl.len(), wins=pl.col("won").sum())
        .with_columns(win_pct=_pct(pl.col("wins"), pl.col("rounds")))
        .sort("team", "side")
    )
    by_buy = (
        tr.group_by("team", "buy", "opp_buy")
        .agg(
            rounds=pl.len(),
            wins=pl.col("won").sum(),
            avg_equip=pl.col("equip").mean().round(0),
            avg_opp_equip=pl.col("opp_equip").mean().round(0),
        )
        .with_columns(win_pct=_pct(pl.col("wins"), pl.col("rounds")))
        .sort("team", "buy", "opp_buy")
    )
    win_reasons = (
        tr.filter(pl.col("won"))
        .group_by("team", "side", "reason_name")
        .agg(rounds=pl.len())
        .sort("team", "side", "reason_name")
    )

    # Kills with round and teams resolved; cross-team kills only.
    kills = (
        _with_round(data["kills"], rounds)
        .join(teams.rename({"steamid": "attacker_steamid", "team": "att_team"}), on="attacker_steamid", how="left")
        .join(teams.rename({"steamid": "victim_steamid", "team": "vic_team"}), on="victim_steamid", how="left")
        .filter(
            pl.col("att_team").is_not_null()
            & pl.col("vic_team").is_not_null()
            & (pl.col("att_team") != pl.col("vic_team"))
        )
    )
    first = (
        kills.sort("tick")
        .group_by("round_num", maintain_order=True)
        .first()
        .select("round_num", opener="att_team", opened="vic_team")
    )
    tro = tr.join(first, on="round_num", how="left").with_columns(
        ok=pl.col("opener") == pl.col("team"), od=pl.col("opened") == pl.col("team")
    )
    opening = (
        tro.group_by("team", "side")
        .agg(
            rounds=pl.len(),
            opening_kills=pl.col("ok").sum(),
            opening_deaths=pl.col("od").sum(),
            won_after_kill=(pl.col("won") & pl.col("ok")).sum(),
            won_after_death=(pl.col("won") & pl.col("od")).sum(),
        )
        .with_columns(
            opening_win_pct=_pct(pl.col("opening_kills"), pl.col("opening_kills") + pl.col("opening_deaths")),
            round_win_after_kill_pct=_pct(pl.col("won_after_kill"), pl.col("opening_kills")),
            round_win_after_death_pct=_pct(pl.col("won_after_death"), pl.col("opening_deaths")),
        )
        .sort("team", "side")
    )

    trades = (
        kills.group_by(team="att_team")
        .agg(kills=pl.len(), trade_kills=pl.col("is_trade").sum())
        .join(
            kills.group_by(team="vic_team").agg(deaths=pl.len(), traded_deaths=pl.col("victim_traded").sum()),
            on="team",
            how="full",
            coalesce=True,
        )
        .with_columns(
            trade_kill_pct=_pct(pl.col("trade_kills"), pl.col("kills")),
            traded_death_pct=_pct(pl.col("traded_deaths"), pl.col("deaths")),
        )
        .sort("team")
    )

    # Bomb: plants by the T team, retakes by the CT team.
    bomb = _with_round(data["bomb"].select("tick", "event", "bombsite"), rounds)
    plants = bomb.filter(pl.col("event") == "finish_plant").select(
        "round_num", "bombsite", plant_sec=((pl.col("tick") - pl.col("freeze_end_tick")) / tick_rate).round(1)
    )
    defused = bomb.filter(pl.col("event") == "defuse").select("round_num").unique().with_columns(defused=pl.lit(True))

    t_rounds = (
        tr.filter(pl.col("side") == "terrorist")
        .join(plants, on="round_num", how="left")
        .with_columns(planted=pl.col("bombsite").is_not_null())
    )
    bomb_t = (
        t_rounds.group_by("team")
        .agg(
            t_rounds=pl.len(),
            plants=pl.col("planted").sum(),
            site_a=(pl.col("bombsite") == "A").sum(),
            site_b=(pl.col("bombsite") == "B").sum(),
            avg_plant_sec=pl.col("plant_sec").mean().round(1),
            post_plant_wins=(pl.col("won") & pl.col("planted")).sum(),
            no_plant_wins=(pl.col("won") & ~pl.col("planted")).sum(),
            no_plant_rounds=(~pl.col("planted")).sum(),
        )
        .with_columns(
            plant_pct=_pct(pl.col("plants"), pl.col("t_rounds")),
            post_plant_win_pct=_pct(pl.col("post_plant_wins"), pl.col("plants")),
            no_plant_win_pct=_pct(pl.col("no_plant_wins"), pl.col("no_plant_rounds")),
        )
        .sort("team")
    )
    ct_rounds = (
        tr.filter(pl.col("side") == "counter-terrorist")
        .join(plants.select("round_num", opp_planted=pl.lit(True)), on="round_num", how="left")
        .join(defused, on="round_num", how="left")
        .with_columns(pl.col("opp_planted").fill_null(False), pl.col("defused").fill_null(False))
    )
    bomb_ct = (
        ct_rounds.group_by("team")
        .agg(
            ct_rounds=pl.len(),
            bombs_planted_on_them=pl.col("opp_planted").sum(),
            defuses=pl.col("defused").sum(),
            retake_wins=(pl.col("won") & pl.col("opp_planted")).sum(),
            hold_wins=(pl.col("won") & ~pl.col("opp_planted")).sum(),
        )
        .with_columns(retake_win_pct=_pct(pl.col("retake_wins"), pl.col("bombs_planted_on_them")))
        .sort("team")
    )

    # Summary: score plus per-player stats aggregated by team.
    score = tr.group_by("team").agg(rounds=pl.len(), rounds_won=pl.col("won").sum())
    players = (
        data["stats"]
        .join(teams, on="steamid")
        .group_by("team")
        .agg(
            kills=pl.col("kills").sum(),
            deaths=pl.col("deaths").sum(),
            assists=pl.col("assists").sum(),
            headshots=pl.col("headshot_kills").sum(),
            hs_pct=_pct(pl.col("headshot_kills").sum(), pl.col("kills").sum()),
            adr=pl.col("adr").cast(pl.Float64).mean().round(1),
            kast=pl.col("kast").cast(pl.Float64).mean().round(1),
            clutches_won=pl.col("clutches_won").sum(),
            clutches_played=pl.col("clutches_played").sum(),
            multikill_rounds=(
                pl.col("multikill_2k") + pl.col("multikill_3k") + pl.col("multikill_4k") + pl.col("multikill_5k")
            ).sum(),
            utility_damage=pl.col("utility_damage").sum(),
            flashes_thrown=pl.col("flashes_thrown").sum(),
            enemies_flashed=pl.col("enemies_flashed").sum(),
            flash_seconds=pl.col("flash_duration_dealt").cast(pl.Float64).sum().round(1),
        )
    )
    summary = (
        score.join(players, on="team")
        .with_columns(
            round_win_pct=_pct(pl.col("rounds_won"), pl.col("rounds")),
            kd=(pl.col("kills") / pl.col("deaths")).round(2),
            utility_damage_per_round=(pl.col("utility_damage") / pl.col("rounds")).round(1),
            enemies_flashed_per_flash=(pl.col("enemies_flashed") / pl.col("flashes_thrown")).round(2),
        )
        .sort("rounds_won", descending=True)
    )

    return {
        "summary": summary,
        "by_side": by_side,
        "by_buy": by_buy,
        "win_reasons": win_reasons,
        "opening": opening,
        "trades": trades,
        "bomb_t": bomb_t,
        "bomb_ct": bomb_ct,
    }

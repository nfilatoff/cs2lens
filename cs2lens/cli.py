from __future__ import annotations

from pathlib import Path

import typer

from cs2lens.aggregate import aggregate
from cs2lens.extract import extract
from cs2lens.report import aggregate_markdown, tactics_markdown, to_markdown
from cs2lens.tactics import tactics
from cs2lens.team_stats import team_stats

app = typer.Typer(help="CS2 demo analyzer", no_args_is_help=True)


@app.callback()
def main() -> None:
    """CS2 demo analyzer."""


@app.command("extract")
def extract_cmd(demo: Path, out: Path = Path("out"), snapshot_seconds: float = 0.5) -> None:
    """Dump all demo data to Parquet."""
    manifest = extract(demo, out / demo.stem, snapshot_seconds=snapshot_seconds)
    for table, rows in manifest["tables"].items():
        typer.echo(f"{table:40s} {rows}")


def _resolve(source: Path, out: Path) -> Path:
    """Return the extract directory for a .dem file (extracting it if needed) or a directory."""
    if source.is_dir():
        return source
    directory = out / source.stem
    if not (directory / "manifest.json").exists():
        extract(source, directory)
    return directory


@app.command("report")
def report_cmd(source: Path, out: Path = Path("out")) -> None:
    """Team statistics report from a .dem file or an extract directory."""
    directory = _resolve(source, out)
    text = to_markdown(team_stats(directory), f"Team report: {directory.name}")
    (directory / "team_report.md").write_text(text, encoding="utf-8")
    typer.echo(text)


@app.command("tactics")
def tactics_cmd(source: Path, out: Path = Path("out")) -> None:
    """Tactical report (executes, CT setups, rotations) from a .dem file or an extract directory."""
    directory = _resolve(source, out)
    text = tactics_markdown(tactics(directory), f"Tactics report: {directory.name}")
    (directory / "tactics_report.md").write_text(text, encoding="utf-8")
    typer.echo(text)


@app.command("batch")
def batch_cmd(
    sources: list[Path],
    out: Path = Path("out"),
    name: str = "aggregate",
    alias: list[str] = typer.Option([], "--alias", help="Merge team names: OLD=NEW (repeatable)"),
) -> None:
    """Aggregate several matches. SOURCES are .dem files, folders of .dem files, or extract folders."""
    aliases = {}
    for item in alias:
        old, sep, new = item.partition("=")
        if not sep or not old or not new:
            raise typer.BadParameter(f"--alias expects OLD=NEW, got {item!r}")
        aliases[old] = new
    directories: list[Path] = []
    for source in sources:
        if source.is_dir() and not (source / "manifest.json").exists():
            demos = sorted(source.glob("*.dem"))
            if not demos:
                raise typer.BadParameter(f"no .dem files in {source}")
        else:
            demos = [source]
        for demo in demos:
            if demo.is_file() and not (out / demo.stem / "manifest.json").exists():
                typer.echo(f"extracting {demo.name} ...")
            directory = _resolve(demo, out)
            if directory not in directories:
                directories.append(directory)

    tables = aggregate(directories, aliases)
    target = out / name
    target.mkdir(parents=True, exist_ok=True)
    for key, df in tables.items():
        df.write_parquet(target / f"{key}.parquet")
    text = aggregate_markdown(tables, f"Aggregate over {len(directories)} matches")
    (target / "aggregate_report.md").write_text(text, encoding="utf-8")
    typer.echo(text)
    typer.echo(f"saved to {target}")


viz_app = typer.Typer(help="Radar visualizations", no_args_is_help=True)
app.add_typer(viz_app, name="viz")


@viz_app.command("kills")
def viz_kills(source: Path, out: Path = Path("out"), side: str | None = None, attacker: bool = False) -> None:
    """Kill-location heatmap (victim positions, or attacker positions with --attacker)."""
    from cs2lens import viz

    d = _resolve(source, out)
    typer.echo(viz.kill_heatmap(d, d / "viz" / f"kills_{side or 'all'}.png", side=side, role="attacker" if attacker else "victim"))


@viz_app.command("utility")
def viz_utility(source: Path, out: Path = Path("out"), side: str | None = None, team: str | None = None) -> None:
    """Grenade landing map, optionally for one side (t/ct) or team."""
    from cs2lens import viz

    d = _resolve(source, out)
    name = "_".join(p for p in ("utility", side, team and team.replace(" ", "-")) if p)
    typer.echo(viz.utility_map(d, d / "viz" / f"{name}.png", side=side, team=team))


@viz_app.command("frame")
def viz_frame(source: Path, round_num: int, sec: float = 30.0, out: Path = Path("out")) -> None:
    """One frame of a round, SEC seconds after freeze time."""
    from cs2lens import viz

    d = _resolve(source, out)
    typer.echo(viz.round_frame(d, d / "viz" / f"round{round_num}_{sec:g}s.png", round_num=round_num, sec=sec))


@viz_app.command("gif")
def viz_gif(source: Path, round_num: int, step_sec: float = 0.5, fps: int = 4, out: Path = Path("out")) -> None:
    """Animated 2D replay of a round."""
    from cs2lens import viz

    d = _resolve(source, out)
    typer.echo(viz.round_gif(d, d / "viz" / f"round{round_num}.gif", round_num=round_num, step_sec=step_sec, fps=fps))


if __name__ == "__main__":
    app()

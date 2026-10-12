from __future__ import annotations

import json
from pathlib import Path

import typer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analytics import collect_due
from app.database import Content, get_content
from app.runtime import build_runtime
from app.reporting import daily_report

app = typer.Typer(no_args_is_help=True, help="YouTube Quiz Agent")


@app.command()
def generate():
    """Generate, render and QA one content item using configured providers."""
    _, _, pipeline = build_runtime()
    typer.echo(pipeline.generate())


@app.command()
def render(content_id: str):
    """Resume a content item from its latest persisted state."""
    _, _, pipeline = build_runtime(); pipeline.resume(content_id); typer.echo("OK")


@app.command()
def preview(content_id: str):
    settings, engine, _ = build_runtime()
    with Session(engine) as s:
        content = get_content(s, content_id)
        typer.echo(str(Path(content.final_video_path).resolve()) if content.final_video_path else "Not rendered")


@app.command()
def approve(content_id: str):
    _, _, pipeline = build_runtime(); pipeline.approve(content_id); typer.echo("APPROVED")


@app.command()
def reject(content_id: str, reason: str = typer.Option(...)):
    _, _, pipeline = build_runtime(); pipeline.reject(content_id, reason); typer.echo("REJECTED")


@app.command()
def upload(content_id: str):
    _, _, pipeline = build_runtime(); typer.echo(pipeline.upload(content_id))


@app.command("run-daily")
def run_daily():
    generate()


@app.command("collect-analytics")
def collect_analytics():
    _, engine, pipeline = build_runtime(); typer.echo(collect_due(engine, pipeline.youtube))


@app.command()
def retry(content_id: str):
    _, _, pipeline = build_runtime(); pipeline.resume(content_id); typer.echo("OK")


@app.command()
def status(content_id: str):
    _, engine, _ = build_runtime()
    with Session(engine) as s:
        c = get_content(s, content_id)
        typer.echo(json.dumps({"content_id": c.content_id, "status": c.status,
                               "video": c.final_video_path, "youtube_video_id": c.youtube_video_id},
                              ensure_ascii=False, indent=2))


@app.command("list")
def list_contents():
    _, engine, _ = build_runtime()
    with Session(engine) as s:
        for c in s.scalars(select(Content).order_by(Content.id.desc()).limit(20)):
            typer.echo(f"{c.content_id} {c.status} {c.topic}")


@app.command("daily-report")
def report():
    _, engine, _ = build_runtime()
    typer.echo(json.dumps(daily_report(engine), ensure_ascii=False, indent=2))


@app.command("real-football")
def real_football():
    """Build a licensed, real-footage football controversy clip without generative AI."""
    from scripts.build_real_football_incident import main
    main()


if __name__ == "__main__":
    app()

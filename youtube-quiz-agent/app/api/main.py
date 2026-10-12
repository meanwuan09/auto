from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import Content, get_content
from app.runtime import build_runtime

app = FastAPI(title="YouTube Quiz Agent", version="0.1.0")
settings, engine, pipeline = build_runtime()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/contents")
def contents():
    with Session(engine) as s:
        return [{"content_id": c.content_id, "status": c.status, "topic": c.topic}
                for c in s.scalars(select(Content).order_by(Content.id.desc()).limit(100))]


@app.post("/contents/{content_id}/approve")
def approve(content_id: str):
    try:
        pipeline.approve(content_id)
        return {"status": "APPROVED"}
    except (LookupError, ValueError) as exc:
        raise HTTPException(400, str(exc))

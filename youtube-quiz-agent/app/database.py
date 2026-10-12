from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from app.models.schemas import ContentStatus
from app.state import can_transition


class Base(DeclarativeBase):
    pass


class Content(Base):
    __tablename__ = "contents"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    topic: Mapped[str] = mapped_column(String(300))
    category: Mapped[str] = mapped_column(String(50))
    difficulty: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(30), default=ContentStatus.IDEA)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    youtube_video_id: Mapped[str | None] = mapped_column(String(100))
    final_video_path: Mapped[str | None] = mapped_column(Text)
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    nearest_content_id: Mapped[str | None] = mapped_column(String(36))
    similarity_score: Mapped[float | None] = mapped_column(Float)


class QuestionRow(Base):
    __tablename__ = "questions"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), unique=True)
    data: Mapped[dict] = mapped_column(JSON)


class ScriptRow(Base):
    __tablename__ = "scripts"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), unique=True)
    data: Mapped[dict] = mapped_column(JSON)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), index=True)
    agent_name: Mapped[str] = mapped_column(String(50))
    input_json: Mapped[dict] = mapped_column(JSON)
    output_json: Mapped[dict | None] = mapped_column(JSON)
    provider: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(100))
    prompt_version: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20))
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retry_count: Mapped[int] = mapped_column(Integer, default=0)


class RenderJob(Base):
    __tablename__ = "render_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), index=True)
    template: Mapped[str] = mapped_column(String(30))
    output_path: Mapped[str] = mapped_column(Text)
    checksum: Mapped[str | None] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(20))


class YouTubeUpload(Base):
    __tablename__ = "youtube_uploads"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), unique=True)
    checksum: Mapped[str] = mapped_column(String(64), unique=True)
    youtube_video_id: Mapped[str | None] = mapped_column(String(100))
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(30))


class AnalyticsSnapshot(Base):
    __tablename__ = "analytics_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), index=True)
    age_hours: Mapped[int] = mapped_column(Integer)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    metrics: Mapped[dict] = mapped_column(JSON)


class OptimizationProfile(Base):
    __tablename__ = "optimization_profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(String(30), unique=True)
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PromptVersion(Base):
    __tablename__ = "prompt_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    agent_name: Mapped[str] = mapped_column(String(50))
    version: Mapped[str] = mapped_column(String(30))
    checksum: Mapped[str] = mapped_column(String(64))


class ContentLink(Base):
    __tablename__ = "content_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    previous_content_id: Mapped[str | None] = mapped_column(String(36), index=True)
    series_title: Mapped[str] = mapped_column(String(200))
    episode_number: Mapped[int] = mapped_column(Integer)
    episode_title: Mapped[str] = mapped_column(String(300))
    connection_to_previous: Mapped[str] = mapped_column(Text, default="")
    callback_line: Mapped[str] = mapped_column(Text, default="")
    next_teaser: Mapped[str] = mapped_column(Text)
    hook_type: Mapped[str] = mapped_column(String(50), default="continuity")


class StateTransition(Base):
    __tablename__ = "state_transitions"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), index=True)
    from_status: Mapped[str] = mapped_column(String(30))
    to_status: Mapped[str] = mapped_column(String(30))
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def create_db(url: str):
    if url.startswith("sqlite:///"):
        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    return engine


def transition(session: Session, content: Content, target: ContentStatus, reason: str | None = None):
    source = ContentStatus(content.status)
    if not can_transition(source, target):
        raise ValueError(f"invalid transition {source} -> {target}")
    session.add(StateTransition(content_id=content.content_id, from_status=source, to_status=target, reason=reason))
    content.status = target
    session.commit()


def get_content(session: Session, content_id: str) -> Content:
    result = session.scalar(select(Content).where(Content.content_id == content_id))
    if not result:
        raise LookupError(f"content not found: {content_id}")
    return result

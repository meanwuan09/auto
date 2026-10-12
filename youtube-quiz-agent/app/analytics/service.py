from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import AnalyticsSnapshot, Content, OptimizationProfile
from app.models.schemas import ContentStatus


def collect_due(engine, youtube):
    captured = 0
    now = datetime.now(timezone.utc)
    with Session(engine) as s:
        for content in s.scalars(select(Content).where(Content.youtube_video_id.is_not(None))):
            age = (now - (content.publish_at or content.updated_at).replace(tzinfo=timezone.utc)).total_seconds() / 3600
            for target in (24, 72, 168):
                exists = s.scalar(select(AnalyticsSnapshot).where(
                    AnalyticsSnapshot.content_id == content.content_id,
                    AnalyticsSnapshot.age_hours == target))
                if age >= target and not exists:
                    metrics = youtube.get_video_statistics(content.youtube_video_id)
                    s.add(AnalyticsSnapshot(content_id=content.content_id, age_hours=target,
                                            captured_at=now, metrics=metrics)); captured += 1
        s.commit()
    return captured


def optimize(engine):
    with Session(engine) as s:
        rows = list(s.scalars(select(AnalyticsSnapshot).where(AnalyticsSnapshot.age_hours == 168)))
        data = {
            "preferred_duration_range": [30, 38],
            "difficulty_weights": {"beginner": .60, "intermediate": .35, "advanced": .05},
            "category_weights": {},
            "preferred_publish_times": ["20:00"],
            "successful_hook_patterns": [],
            "underperforming_topics": [],
            "recommendations": ["Cần tối thiểu 10 video trước khi thay đổi trọng số."] if len(rows) < 10 else [],
        }
        s.add(OptimizationProfile(version=now_version(), data=data, created_at=datetime.now(timezone.utc)))
        s.commit()
        return data


def now_version():
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

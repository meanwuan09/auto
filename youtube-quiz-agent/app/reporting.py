from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import AnalyticsSnapshot, Content
from app.models.schemas import ContentStatus


def daily_report(engine):
    today = datetime.now(timezone.utc).date().isoformat()
    with Session(engine) as s:
        rows = list(s.scalars(select(Content).where(func.date(Content.created_at) == today)))
        latest = s.scalar(select(AnalyticsSnapshot).order_by(AnalyticsSnapshot.captured_at.desc()).limit(1))
        return {
            "date": today,
            "created": len(rows),
            "rejected": sum(c.status == ContentStatus.REJECTED for c in rows),
            "rendered": sum(bool(c.final_video_path) for c in rows),
            "awaiting_approval": sum(c.status == ContentStatus.AWAITING_APPROVAL for c in rows),
            "scheduled": sum(c.status == ContentStatus.SCHEDULED for c in rows),
            "failed": [{"content_id": c.content_id, "reason": c.rejection_reason}
                       for c in rows if c.status == ContentStatus.FAILED],
            "latest_analytics": latest.metrics if latest else None,
        }

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
import yaml

from app.config import Settings, load_settings
from app.models.schemas import ContentStatus
from app.state import can_transition
from app.workflows.pipeline import publish_at_utc


def test_state_transitions():
    assert can_transition(ContentStatus.IDEA, ContentStatus.QUESTION_DRAFTED)
    assert not can_transition(ContentStatus.IDEA, ContentStatus.PUBLISHED)


def test_config_loading(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump({"target_duration_seconds": 40, "timezone": "Asia/Ho_Chi_Minh"}))
    assert load_settings(path).target_duration_seconds == 40


def test_config_rejects_bad_weights():
    with pytest.raises(ValueError):
        Settings(difficulty_weights={"beginner": .2})


def test_timezone_and_publish_at():
    settings = Settings(default_publish_time="20:00")
    now = datetime(2026, 1, 2, 19, 0, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh"))
    utc = publish_at_utc(settings, now)
    assert utc.isoformat() == "2026-01-02T13:00:00+00:00"

from pathlib import Path

import pytest

from app.config import Settings
from app.database import create_db
from app.providers.mock import MockLLMProvider, MockTTSProvider, MockYouTubeProvider
from app.workflows.pipeline import Pipeline


@pytest.fixture
def runtime(tmp_path):
    settings = Settings(
        database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        output_dir=tmp_path / "output",
        daily_video_limit=3,
    )
    engine = create_db(settings.database_url)
    youtube = MockYouTubeProvider()
    return settings, engine, Pipeline(settings, engine, MockLLMProvider(), MockTTSProvider(), youtube)

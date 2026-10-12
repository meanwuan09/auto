from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import Content, ContentLink, QuestionRow, YouTubeUpload
from app.models.schemas import ContentStatus, Question, VoiceResult
from app.providers.mock import MockLLMProvider, MockTTSProvider


def test_mock_llm_and_tts(tmp_path):
    q = MockLLMProvider().structured("question", {
        "content_id": "x", "topic": "borrow", "category": "grammar", "difficulty": "beginner"}, Question)
    voice = MockTTSProvider().synthesize("xin chào", tmp_path / "voice.wav")
    assert q.confidence > .9 and voice.audio_path.exists() and voice.duration_seconds == 35


def test_dry_run_integration_and_no_duplicate_upload(runtime):
    settings, engine, pipeline = runtime
    content_id = pipeline.generate()
    with Session(engine) as s:
        content = s.scalar(select(Content).where(Content.content_id == content_id))
        assert content.status == ContentStatus.AWAITING_APPROVAL
        assert Path(content.final_video_path).exists()
    pipeline.approve(content_id)
    video_id = pipeline.upload(content_id)
    assert video_id.startswith("dry_")
    assert pipeline.upload(content_id) == video_id
    with Session(engine) as s:
        assert s.scalar(select(YouTubeUpload).where(YouTubeUpload.content_id == content_id))


def test_daily_series_continues_without_repeating(runtime):
    _, engine, pipeline = runtime
    first_id = pipeline.generate()
    second_id = pipeline.generate()
    with Session(engine) as s:
        first = s.scalar(select(ContentLink).where(ContentLink.content_id == first_id))
        second = s.scalar(select(ContentLink).where(ContentLink.content_id == second_id))
        first_question = s.scalar(select(QuestionRow).where(QuestionRow.content_id == first_id))
        second_question = s.scalar(select(QuestionRow).where(QuestionRow.content_id == second_id))
        assert first.episode_number == 1
        assert second.episode_number == 2
        assert second.previous_content_id == first_id
        assert second.callback_line
        assert first.next_teaser
        assert first_question.data["topic"] != second_question.data["topic"]

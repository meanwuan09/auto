import hashlib
from pathlib import Path

from sqlalchemy.orm import Session

from app.agents import DuplicateDetectionAgent
from app.database import QuestionRow
from app.models.schemas import Question
from app.providers.mock import MockLLMProvider
from app.rendering.video import qa_video


def make_question(content_id):
    return MockLLMProvider().structured("question", {
        "content_id": content_id, "topic": "borrow", "category": "grammar", "difficulty": "beginner"}, Question)


def test_duplicate_detection(runtime):
    settings, engine, _ = runtime
    q1, q2 = make_question("one"), make_question("two")
    with Session(engine) as s:
        s.add(QuestionRow(content_id="one", data=q1.model_dump(mode="json"))); s.commit()
        result = DuplicateDetectionAgent().check(s, q2, settings.duplicate_threshold)
    assert result["duplicate"] and result["nearest_content_id"] == "one"


def test_checksum_is_stable(tmp_path):
    path = tmp_path / "x"
    path.write_bytes(b"same")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == hashlib.sha256(b"same").hexdigest()


def test_qa_rejects_missing_file(tmp_path):
    qa = qa_video(tmp_path / "missing.mp4")
    assert not qa.passed and "exists_nonzero" in qa.errors

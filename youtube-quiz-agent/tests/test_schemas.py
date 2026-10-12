import pytest
from pydantic import ValidationError

from app.models.schemas import Answer, Choice, FactCheck, Question
from app.providers.mock import MockLLMProvider


def question():
    return MockLLMProvider().structured("question", {
        "content_id": "x", "topic": "borrow", "category": "grammar", "difficulty": "beginner"}, Question)


def test_question_schema_has_three_choices_and_one_answer():
    q = question()
    assert len(q.choices) == 3
    assert sum(c.label == q.proposed_answer.label and c.text == q.proposed_answer.text for c in q.choices) == 1


def test_question_rejects_nonmatching_answer():
    data = question().model_dump()
    data["proposed_answer"] = {"label": "A", "text": "not a choice"}
    with pytest.raises(ValidationError):
        Question.model_validate(data)


def test_factcheck_gate():
    valid = FactCheck(verdict="pass", independent_answer=Answer(label="A", text="x"),
                      matches_proposed_answer=True, single_correct_answer=True,
                      ambiguity_detected=False, confidence=.91)
    assert valid.passes(.90)
    assert not valid.model_copy(update={"confidence": .89}).passes(.90)
    assert not valid.model_copy(update={"ambiguity_detected": True}).passes(.90)

from __future__ import annotations

from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field, model_validator


class Difficulty(StrEnum):
    BEGINNER = "beginner"
    INTERMEDIATE = "intermediate"
    ADVANCED = "advanced"


class DailyPlan(BaseModel):
    topic: str
    category: str
    difficulty: Difficulty
    series_title: str
    episode_title: str
    connection_to_previous: str = ""
    callback_line: str = ""
    next_teaser: str
    hook_type: str = "continuity"


class ContentStatus(StrEnum):
    IDEA = "IDEA"
    QUESTION_DRAFTED = "QUESTION_DRAFTED"
    FACT_CHECK_PENDING = "FACT_CHECK_PENDING"
    FACT_CHECKED = "FACT_CHECKED"
    SCRIPT_CREATED = "SCRIPT_CREATED"
    VOICE_CREATED = "VOICE_CREATED"
    RENDERED = "RENDERED"
    QA_PENDING = "QA_PENDING"
    QA_PASSED = "QA_PASSED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    SCHEDULED = "SCHEDULED"
    PUBLISHED = "PUBLISHED"
    MEASURED = "MEASURED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"


class Choice(BaseModel):
    label: str = Field(pattern="^[ABC]$")
    text: str = Field(min_length=1)


class Answer(BaseModel):
    label: str = Field(pattern="^[ABC]$")
    text: str


class Question(BaseModel):
    content_id: str
    topic: str
    category: str
    difficulty: Difficulty
    question: str
    choices: list[Choice]
    proposed_answer: Answer
    explanation: str
    example: str
    confidence: float = Field(ge=0, le=1)
    review_required: bool = False

    @model_validator(mode="after")
    def exactly_three_unique_choices(self):
        if len(self.choices) != 3 or {c.label for c in self.choices} != {"A", "B", "C"}:
            raise ValueError("exactly three choices A/B/C are required")
        matches = [c for c in self.choices if c.label == self.proposed_answer.label and c.text == self.proposed_answer.text]
        if len(matches) != 1:
            raise ValueError("proposed_answer must match exactly one choice")
        return self


class FactCheck(BaseModel):
    verdict: str = Field(pattern="^(pass|reject|manual_review)$")
    independent_answer: Answer
    matches_proposed_answer: bool
    single_correct_answer: bool
    ambiguity_detected: bool
    confidence: float = Field(ge=0, le=1)
    issues: list[str] = []
    sources: list[str] = []
    regeneration_instruction: str = ""

    def passes(self, threshold: float) -> bool:
        return (self.verdict == "pass" and self.confidence >= threshold
                and self.matches_proposed_answer and self.single_correct_answer
                and not self.ambiguity_detected)


class Segment(BaseModel):
    scene: int
    start_second: float
    end_second: float
    voiceover: str
    main_text: str
    supporting_text: str = ""
    animation: str = "fade"


class Script(BaseModel):
    hook: str
    countdown_text: str = "Bạn có 5 giây!"
    answer_reveal: str
    explanation_voiceover: str
    example_voiceover: str
    cta: str
    full_voiceover: str
    estimated_duration_seconds: float
    segments: list[Segment]


class Metadata(BaseModel):
    title: str = Field(max_length=70)
    description: str
    hashtags: list[str]
    tags: list[str]
    category_id: str = "27"
    default_language: str = "vi"
    made_for_kids: bool = False
    contains_synthetic_media: bool = False

    @model_validator(mode="after")
    def shorts_title(self):
        if not self.title.lower().endswith("#shorts"):
            raise ValueError("title must end with #shorts")
        return self


class VoiceResult(BaseModel):
    audio_path: Path
    duration_seconds: float
    provider: str
    voice_id: str
    speech_rate: float = 1
    word_timestamps: list[dict] = []


class QAResult(BaseModel):
    passed: bool
    technical_checks: dict
    content_checks: dict
    warnings: list[str] = []
    errors: list[str] = []
    video_checksum: str = ""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import AgentRun, Content, QuestionRow, ScriptRow
from app.models.schemas import DailyPlan, FactCheck, Metadata, Question, Script
from app.providers.base import LLMProvider


class StructuredAgent:
    def __init__(self, name: str, provider: LLMProvider, schema, prompt_version="1.0.0", timeout=60):
        self.name, self.provider, self.schema = name, provider, schema
        self.prompt_version, self.timeout = prompt_version, timeout

    def run(self, session: Session, content_id: str, payload: dict, attempts=3):
        row = AgentRun(content_id=content_id, agent_name=self.name, input_json=payload,
                       provider=self.provider.name, model=self.provider.model,
                       prompt_version=self.prompt_version, status="running",
                       started_at=datetime.now(timezone.utc), retry_count=0)
        session.add(row); session.commit()
        error = None
        for attempt in range(attempts):
            try:
                started = time.monotonic()
                result = self.provider.structured(self.name, payload, self.schema)
                if time.monotonic() - started > self.timeout:
                    raise TimeoutError(self.name)
                row.output_json = result.model_dump(mode="json")
                row.status = "success"; row.completed_at = datetime.now(timezone.utc); row.retry_count = attempt
                session.commit()
                return result
            except Exception as exc:
                error = exc
                row.retry_count = attempt + 1
                session.commit()
                if attempt + 1 < attempts:
                    time.sleep(min(2 ** attempt, 4))
        row.status = "failed"; row.error_message = str(error); row.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise error


def normalize(value: str) -> str:
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in value).split())


class DuplicateDetectionAgent:
    name = "duplicate_detection"

    def check(self, session: Session, candidate: Question, threshold: float):
        candidate_text = normalize(" ".join([
            candidate.topic, candidate.question, candidate.proposed_answer.text,
            candidate.example, candidate.explanation,
        ]))
        best = (0.0, None)
        for row in session.scalars(select(QuestionRow).order_by(QuestionRow.id.desc()).limit(30)):
            if row.content_id == candidate.content_id:
                continue
            old = Question.model_validate(row.data)
            old_text = normalize(" ".join([old.topic, old.question, old.proposed_answer.text, old.example, old.explanation]))
            score = SequenceMatcher(None, candidate_text, old_text).ratio()
            if score > best[0]:
                best = (score, row.content_id)
        return {"duplicate": best[0] > threshold, "score": best[0], "nearest_content_id": best[1]}


def agents(provider: LLMProvider):
    return {
        "topic": StructuredAgent("topic_agent", provider, DailyPlan),
        "question": StructuredAgent("question_agent", provider, Question),
        "factcheck": StructuredAgent("factcheck_agent", provider, FactCheck),
        "script": StructuredAgent("script_agent", provider, Script),
        "metadata": StructuredAgent("metadata_agent", provider, Metadata),
    }

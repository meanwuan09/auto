from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.agents import DuplicateDetectionAgent, agents
from app.config import Settings
from app.database import (
    Content, ContentLink, QuestionRow, RenderJob, ScriptRow, YouTubeUpload, get_content, transition,
)
from app.models.schemas import ContentStatus, DailyPlan, Metadata, Question, Script
from app.providers.base import LLMProvider, TTSProvider, YouTubeProvider
from app.rendering import fit_audio_duration, qa_video, render_video


def publish_at_utc(settings: Settings, now=None):
    local_now = (now or datetime.now(ZoneInfo(settings.timezone))).astimezone(ZoneInfo(settings.timezone))
    hour, minute = map(int, settings.default_publish_time.split(":"))
    value = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if value <= local_now:
        value += timedelta(days=1)
    while value.date() in settings.pause_dates:
        value += timedelta(days=1)
    return value.astimezone(timezone.utc)


class Pipeline:
    def __init__(self, settings: Settings, engine, llm: LLMProvider, tts: TTSProvider, youtube: YouTubeProvider):
        self.settings, self.engine, self.llm, self.tts, self.youtube = settings, engine, llm, tts, youtube
        self.agent = agents(llm)

    def generate(self) -> str:
        if self.settings.emergency_stop or self.settings.kill_switch:
            raise RuntimeError("pipeline stopped by emergency stop/kill switch")
        with Session(self.engine) as s:
            today = datetime.now(timezone.utc).date()
            count = s.scalar(select(func.count()).select_from(Content).where(func.date(Content.created_at) == str(today))) or 0
            if count >= self.settings.daily_video_limit:
                raise RuntimeError("DAILY_VIDEO_LIMIT reached")
            content_id = str(uuid4())
            previous = s.scalar(select(Content).where(
                Content.status.not_in([ContentStatus.REJECTED, ContentStatus.FAILED])
            ).order_by(Content.id.desc()).limit(1))
            previous_link = (
                s.scalar(select(ContentLink).where(ContentLink.content_id == previous.content_id))
                if previous else None
            )
            episode_number = (s.scalar(select(func.max(ContentLink.episode_number))) or 0) + 1
            recent_rows = list(s.scalars(
                select(QuestionRow).order_by(QuestionRow.id.desc()).limit(self.settings.series_memory_size)
            ))
            history = [
                {"content_id": row.content_id, "topic": row.data.get("topic"),
                 "question": row.data.get("question"), "example": row.data.get("example")}
                for row in recent_rows
            ]
            category = self.settings.categories[episode_number % len(self.settings.categories)]
            c = Content(content_id=content_id, topic="pending", category=category,
                        difficulty=self.settings.default_difficulty, status=ContentStatus.IDEA)
            s.add(c); s.commit()
            plan = self.agent["topic"].run(s, content_id, {
                "content_id": content_id,
                "niche": self.settings.niche,
                "audience": self.settings.target_audience,
                "series_title": self.settings.series_title,
                "episode_number": episode_number,
                "difficulty": self.settings.default_difficulty,
                "allowed_categories": self.settings.categories,
                "previous": {
                    "content_id": previous.content_id,
                    "topic": previous.topic,
                    "episode_title": previous_link.episode_title if previous_link else previous.topic,
                    "next_teaser": previous_link.next_teaser if previous_link else "",
                } if previous else None,
                "recent_history": history,
                "continuity_rules": {
                    "must_deliver_previous_teaser": True,
                    "must_add_new_standalone_value": True,
                    "next_teaser_must_be_specific_but_not_reveal_answer": True,
                    "do_not_fake_statistics_or_withhold_current_answer": True,
                },
            })
            if plan.category not in self.settings.categories:
                raise ValueError(f"Topic Agent returned unsupported category: {plan.category}")
            c.topic, c.category, c.difficulty = plan.topic, plan.category, plan.difficulty
            s.add(ContentLink(
                content_id=content_id,
                previous_content_id=previous.content_id if previous else None,
                series_title=plan.series_title,
                episode_number=episode_number,
                episode_title=plan.episode_title,
                connection_to_previous=plan.connection_to_previous,
                callback_line=plan.callback_line,
                next_teaser=plan.next_teaser,
                hook_type=plan.hook_type,
            ))
            s.commit()
            self._continue(s, c)
            return content_id

    def resume(self, content_id: str):
        with Session(self.engine) as s:
            c = get_content(s, content_id)
            self._continue(s, c)

    def _continue(self, s: Session, c: Content):
        status = ContentStatus(c.status)
        link = s.scalar(select(ContentLink).where(ContentLink.content_id == c.content_id))
        continuity = {
            "series_title": link.series_title,
            "episode_number": link.episode_number,
            "episode_title": link.episode_title,
            "previous_content_id": link.previous_content_id,
            "connection_to_previous": link.connection_to_previous,
            "callback_line": link.callback_line,
            "next_teaser": link.next_teaser,
            "hook_type": link.hook_type,
        } if link else {}
        if status == ContentStatus.IDEA:
            q = self.agent["question"].run(s, c.content_id, {
                "content_id": c.content_id, "topic": c.topic, "category": c.category,
                "difficulty": c.difficulty, "episode_number": continuity.get("episode_number", 1),
                "continuity": continuity})
            s.add(QuestionRow(content_id=c.content_id, data=q.model_dump(mode="json"))); s.commit()
            transition(s, c, ContentStatus.QUESTION_DRAFTED); status = ContentStatus.QUESTION_DRAFTED
        qrow = s.scalar(select(QuestionRow).where(QuestionRow.content_id == c.content_id))
        q = Question.model_validate(qrow.data)
        if status == ContentStatus.QUESTION_DRAFTED:
            duplicate = DuplicateDetectionAgent().check(s, q, self.settings.duplicate_threshold)
            c.similarity_score, c.nearest_content_id = duplicate["score"], duplicate["nearest_content_id"]
            if duplicate["duplicate"]:
                transition(s, c, ContentStatus.REJECTED, "duplicate content"); return
            transition(s, c, ContentStatus.FACT_CHECK_PENDING); status = ContentStatus.FACT_CHECK_PENDING
        if status == ContentStatus.FACT_CHECK_PENDING:
            check = self.agent["factcheck"].run(s, c.content_id, {"content_id": c.content_id, "question": q.model_dump(mode="json")})
            if not check.passes(self.settings.fact_check_threshold):
                transition(s, c, ContentStatus.REJECTED, "; ".join(check.issues) or check.regeneration_instruction); return
            transition(s, c, ContentStatus.FACT_CHECKED); status = ContentStatus.FACT_CHECKED
        if status == ContentStatus.FACT_CHECKED:
            script = self.agent["script"].run(s, c.content_id, {
                "content_id": c.content_id, "question": q.model_dump(mode="json"),
                "episode_number": continuity.get("episode_number", 1), "continuity": continuity})
            s.add(ScriptRow(content_id=c.content_id, data=script.model_dump(mode="json"))); s.commit()
            transition(s, c, ContentStatus.SCRIPT_CREATED); status = ContentStatus.SCRIPT_CREATED
        script = Script.model_validate(s.scalar(select(ScriptRow).where(ScriptRow.content_id == c.content_id)).data)
        base = self.settings.output_dir / c.content_id
        if status == ContentStatus.SCRIPT_CREATED:
            voice = self.tts.synthesize(script.full_voiceover, base / "voice.wav")
            if not 25 <= voice.duration_seconds <= 45:
                rate = min(1.15, max(.85, voice.duration_seconds / self.settings.target_duration_seconds))
                voice = self.tts.synthesize(script.full_voiceover, base / "voice.wav", speech_rate=rate)
            if not 25 <= voice.duration_seconds <= 45:
                transition(
                    s, c, ContentStatus.FAILED,
                    f"TTS duration {voice.duration_seconds:.1f}s is outside 25-45s; script must be regenerated",
                )
                return
            # Preserve every sentence and the 13-second reveal: time-stretch complete audio, never truncate it.
            source_duration = voice.duration_seconds
            target_duration = script.estimated_duration_seconds
            if abs(source_duration - target_duration) > .15:
                fit_audio_duration(Path(voice.audio_path), source_duration, target_duration)
                timestamp_scale = target_duration / source_duration
                for stamp in voice.word_timestamps:
                    stamp["start"] *= timestamp_scale
                    stamp["end"] *= timestamp_scale
                voice.duration_seconds = target_duration
            script_row = s.scalar(select(ScriptRow).where(ScriptRow.content_id == c.content_id))
            script_row.data = script.model_dump(mode="json")
            s.commit()
            (base / "voice.json").write_text(voice.model_dump_json(indent=2), encoding="utf-8")
            transition(s, c, ContentStatus.VOICE_CREATED); status = ContentStatus.VOICE_CREATED
        if status == ContentStatus.VOICE_CREATED:
            templates = ["clean_blue", "dark_neon", "paper_learning"]
            template = templates[(c.id - 1) % 3]
            video = render_video(q, script, base / "voice.wav", base / "video.mp4", template)
            c.final_video_path = str(video)
            s.add(RenderJob(content_id=c.content_id, template=template, output_path=str(video), status="rendered"))
            s.commit(); transition(s, c, ContentStatus.RENDERED); status = ContentStatus.RENDERED
        if status == ContentStatus.RENDERED:
            transition(s, c, ContentStatus.QA_PENDING); status = ContentStatus.QA_PENDING
        if status == ContentStatus.QA_PENDING:
            qa = qa_video(Path(c.final_video_path))
            (base / "qa.json").write_text(qa.model_dump_json(indent=2), encoding="utf-8")
            if not qa.passed:
                transition(s, c, ContentStatus.FAILED, ", ".join(qa.errors)); return
            job = s.scalar(select(RenderJob).where(RenderJob.content_id == c.content_id))
            job.checksum = qa.video_checksum; job.status = "qa_passed"; s.commit()
            transition(s, c, ContentStatus.QA_PASSED); status = ContentStatus.QA_PASSED
        if status == ContentStatus.QA_PASSED:
            transition(s, c, ContentStatus.APPROVED if self.settings.auto_publish else ContentStatus.AWAITING_APPROVAL)

    def approve(self, content_id):
        with Session(self.engine) as s:
            c = get_content(s, content_id)
            transition(s, c, ContentStatus.APPROVED)

    def reject(self, content_id, reason):
        with Session(self.engine) as s:
            c = get_content(s, content_id); c.rejection_reason = reason
            transition(s, c, ContentStatus.REJECTED, reason)

    def upload(self, content_id):
        with Session(self.engine) as s:
            c = get_content(s, content_id)
            existing = s.scalar(select(YouTubeUpload).where(YouTubeUpload.content_id == content_id))
            if existing:
                return existing.youtube_video_id
            if ContentStatus(c.status) != ContentStatus.APPROVED:
                raise RuntimeError("upload requires APPROVED")
            job = s.scalar(select(RenderJob).where(RenderJob.content_id == content_id))
            duplicate_checksum = s.scalar(select(YouTubeUpload).where(YouTubeUpload.checksum == job.checksum))
            if duplicate_checksum:
                raise RuntimeError("checksum already uploaded")
            q = Question.model_validate(s.scalar(select(QuestionRow).where(QuestionRow.content_id == content_id)).data)
            link = s.scalar(select(ContentLink).where(ContentLink.content_id == content_id))
            metadata = self.agent["metadata"].run(s, content_id, {
                "content_id": content_id, "question": q.model_dump(mode="json"),
                "series_title": link.series_title if link else self.settings.series_title,
                "episode_number": link.episode_number if link else 1,
            })
            video_id = self.youtube.upload_video(Path(c.final_video_path), metadata, content_id, job.checksum)
            publish_at = publish_at_utc(self.settings)
            self.youtube.schedule_video(video_id, publish_at)
            s.add(YouTubeUpload(content_id=content_id, checksum=job.checksum, youtube_video_id=video_id,
                                publish_at=publish_at, status="scheduled"))
            c.youtube_video_id, c.publish_at = video_id, publish_at
            s.commit(); transition(s, c, ContentStatus.SCHEDULED)
            return video_id

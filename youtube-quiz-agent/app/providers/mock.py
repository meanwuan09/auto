from __future__ import annotations

import math
import shutil
import struct
import wave
from pathlib import Path
from uuid import uuid4

from app.models.schemas import (
    Answer, Choice, DailyPlan, FactCheck, Metadata, Question, Script, Segment, VoiceResult,
)
from app.providers.base import LLMProvider, StorageProvider, TTSProvider, YouTubeProvider


class MockLLMProvider(LLMProvider):
    name = "mock"
    model = "deterministic-v1"

    def structured(self, agent: str, payload: dict, schema):
        content_id = payload["content_id"]
        episode = int(payload.get("episode_number", 1))
        bank = [
            {
                "topic": "Cách dùng borrow và lend", "category": "common_mistakes",
                "question": "Bạn muốn nói “Tôi có thể mượn bút của bạn không?” bằng tiếng Anh. Câu nào đúng?",
                "choices": ["Can I borrow your pen?", "Can I lend your pen?", "Can I borrow you a pen?"],
                "explanation": "Borrow nghĩa là nhận hoặc dùng tạm thứ gì từ người khác; lend nghĩa là cho người khác mượn.",
                "example": "Could you lend me your pen? = Bạn có thể cho tôi mượn bút không?",
                "next": "Ngày mai: khi nào dùng bring, khi nào dùng take?",
            },
            {
                "topic": "Phân biệt bring và take", "category": "daily_conversation",
                "question": "Bạn đang ở văn phòng và nhờ đồng nghiệp mang tài liệu đến chỗ mình. Câu nào đúng?",
                "choices": ["Please bring the document here.", "Please take the document here.", "Please borrow the document here."],
                "explanation": "Bring diễn tả mang thứ gì về phía người nói hoặc điểm đến; take là mang ra xa người nói.",
                "example": "Take this file to Minh, but bring his reply back to me.",
                "next": "Tập sau: say và tell khác nhau ở điểm nhỏ nào?",
            },
            {
                "topic": "Phân biệt say và tell", "category": "grammar",
                "question": "Câu nào đúng khi bạn muốn nói “Cô ấy kể cho tôi một bí mật”?",
                "choices": ["She told me a secret.", "She said me a secret.", "She told a secret to I."],
                "explanation": "Tell thường đi trực tiếp với người nghe: tell someone something. Say tập trung vào lời được nói.",
                "example": "She said hello, then told me the news.",
                "next": "Tập sau: fun và funny—một từ không hề có nghĩa là vui vẻ!",
            },
        ]
        item = bank[(episode - 1) % len(bank)]
        if schema is DailyPlan:
            previous = payload.get("previous") or {}
            value = DailyPlan(
                topic=item["topic"], category=item["category"],
                difficulty=payload.get("difficulty", "beginner"),
                series_title=payload.get("series_title", "Tiếng Anh dùng được ngay"),
                episode_title=f"Tập {episode}: {item['topic']}",
                connection_to_previous=(
                    f"Nối tiếp {previous.get('topic')}: cùng luyện một cặp từ dễ nhầm."
                    if previous else "Mở đầu chuỗi các cặp từ tiếng Anh dễ nhầm."
                ),
                callback_line=(
                    f"Hôm qua mình đã phân biệt {previous.get('topic')}."
                    if previous else ""
                ),
                next_teaser=item["next"],
            )
        elif schema is Question:
            value = Question(
                content_id=content_id, topic=payload.get("topic", item["topic"]),
                category=payload.get("category", item["category"]),
                difficulty=payload.get("difficulty", "beginner"),
                question=item["question"],
                choices=[Choice(label=label, text=text) for label, text in zip("ABC", item["choices"])],
                proposed_answer=Answer(label="A", text=item["choices"][0]),
                explanation=item["explanation"], example=item["example"],
                confidence=.99,
            )
        elif schema is FactCheck:
            q = Question.model_validate(payload["question"])
            value = FactCheck(
                verdict="pass", independent_answer=q.proposed_answer,
                matches_proposed_answer=True,
                single_correct_answer=True, ambiguity_detected=False, confidence=.99,
                sources=["Oxford Learner's Dictionaries"],
            )
        elif schema is Script:
            q = Question.model_validate(payload["question"])
            continuity = payload.get("continuity") or {}
            callback = continuity.get("callback_line", "")
            teaser = continuity.get("next_teaser", "Tập sau sẽ có một cặp từ còn dễ nhầm hơn.")
            hook = f"{callback} Hôm nay: {q.topic}!" if callback else f"{q.topic}: bạn chọn đúng không?"
            value = Script(
                hook=hook,
                answer_reveal=f"Đáp án đúng là {q.proposed_answer.label}: {q.proposed_answer.text}",
                explanation_voiceover=q.explanation,
                example_voiceover=q.example,
                cta=teaser,
                full_voiceover=(
                    f"{hook} "
                    f"{q.question} A, {q.choices[0].text}. B, {q.choices[1].text}. C, {q.choices[2].text}. "
                    "Bạn có năm giây! Năm, bốn, ba, hai, một. "
                    f"Đáp án đúng là A: {q.proposed_answer.text}. {q.explanation} "
                    f"Ví dụ: {q.example} {teaser}"
                ),
                estimated_duration_seconds=35,
                segments=[
                    Segment(scene=1, start_second=0, end_second=2, voiceover=hook, main_text=q.topic.upper()),
                    Segment(scene=2, start_second=2, end_second=8, voiceover=q.question, main_text=q.question, supporting_text="A. Can I borrow your pen?\nB. Can I lend your pen?\nC. Can I borrow you a pen?"),
                    Segment(scene=3, start_second=8, end_second=13, voiceover="Bạn có năm giây!", main_text="5... 4... 3... 2... 1..."),
                    Segment(scene=4, start_second=13, end_second=18, voiceover="Đáp án đúng là A", main_text="ĐÁP ÁN: A"),
                    Segment(scene=5, start_second=18, end_second=29, voiceover=q.explanation, main_text="BORROW = mượn\nLEND = cho mượn"),
                    Segment(scene=6, start_second=29, end_second=35, voiceover=f"{q.example} {teaser}", main_text=q.example, supporting_text=teaser),
                ],
            )
        elif schema is Metadata:
            question = payload.get("question") or {}
            topic = question.get("topic", item["topic"])
            value = Metadata(
                title=f"{topic[:48]}: bạn có dùng đúng? #shorts",
                description=f"Một câu hỏi nhanh trong chuỗi {payload.get('series_title', 'Tiếng Anh dùng được ngay')}.",
                hashtags=["#shorts", "#tienganh", "#hoctienganh"],
                tags=["tiếng Anh giao tiếp", "borrow vs lend", "học nhanh"],
            )
        else:
            raise ValueError(f"unsupported mock schema {schema}")
        return schema.model_validate(value)


class MockTTSProvider(TTSProvider):
    name = "mock"

    def synthesize(self, text: str, output_path: Path, speech_rate: float = 1) -> VoiceResult:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        duration = 35.0
        sample_rate = 16000
        with wave.open(str(output_path), "wb") as wav:
            wav.setparams((1, 2, sample_rate, int(sample_rate * duration), "NONE", "not compressed"))
            chunk = bytearray()
            for i in range(int(sample_rate * duration)):
                envelope = .22 if (i // sample_rate) % 2 == 0 else .12
                sample = int(32767 * envelope * math.sin(2 * math.pi * 220 * i / sample_rate))
                chunk += struct.pack("<h", sample)
                if len(chunk) >= 65536:
                    wav.writeframesraw(chunk)
                    chunk.clear()
            wav.writeframes(chunk)
        words = text.split()
        timestamps = [{"word": w, "start": i * duration / len(words), "end": (i + 1) * duration / len(words)} for i, w in enumerate(words)]
        return VoiceResult(audio_path=output_path, duration_seconds=duration, provider=self.name, voice_id="mock-tone", speech_rate=speech_rate, word_timestamps=timestamps)


class LocalStorageProvider(StorageProvider):
    def __init__(self, root: Path):
        self.root = root

    def put(self, source: Path, key: str) -> str:
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return str(target)


class MockYouTubeProvider(YouTubeProvider):
    def __init__(self):
        self.videos = {}

    def upload_video(self, path, metadata, content_id, checksum):
        video_id = f"dry_{uuid4().hex[:10]}"
        self.videos[video_id] = {"status": "uploaded_private", "content_id": content_id, "checksum": checksum}
        return video_id

    def get_processing_status(self, video_id): return self.videos.get(video_id, {}).get("status", "unknown")
    def update_metadata(self, video_id, metadata): self.videos[video_id]["metadata"] = metadata.model_dump()
    def schedule_video(self, video_id, publish_at): self.videos[video_id].update(status="scheduled", publish_at=publish_at.isoformat())
    def get_video_statistics(self, video_id): return {"views": 0, "likes": 0, "comments": 0}

from types import SimpleNamespace

import pytest

from app.models.schemas import DailyPlan
from app.providers.gemini import GeminiLLMProvider, GeminiTTSProvider


class FakeModels:
    def __init__(self, response):
        self.response = response

    def generate_content(self, **kwargs):
        self.last_request = kwargs
        return self.response


class FakeClient:
    def __init__(self, response):
        self.models = FakeModels(response)


def test_gemini_llm_uses_structured_schema():
    parsed = {
        "topic": "Bring và take", "category": "daily_conversation",
        "difficulty": "beginner", "series_title": "Series",
        "episode_title": "Tập 2", "connection_to_previous": "Nối tập 1",
        "callback_line": "Hôm qua ta học borrow.",
        "next_teaser": "Ngày mai: say hay tell?", "hook_type": "continuity",
    }
    fake = FakeClient(SimpleNamespace(parsed=parsed, text=""))
    provider = GeminiLLMProvider("", "test-model", client=fake)
    result = provider.structured("topic_agent", {"content_id": "x"}, DailyPlan)
    assert result.topic == "Bring và take"
    assert fake.models.last_request["model"] == "test-model"


def test_gemini_tts_writes_valid_wav(tmp_path):
    pcm = b"\x00\x00" * 24000
    part = SimpleNamespace(inline_data=SimpleNamespace(data=pcm))
    response = SimpleNamespace(candidates=[SimpleNamespace(
        content=SimpleNamespace(parts=[part]))])
    provider = GeminiTTSProvider("", "tts-model", "Kore", "Đọc rõ.", client=FakeClient(response))
    result = provider.synthesize("Xin chào", tmp_path / "voice.wav")
    assert result.audio_path.exists()
    assert result.duration_seconds == pytest.approx(1.0)
    assert result.voice_id == "Kore"

import io
import wave

from app.models.schemas import DailyPlan
from app.providers.deepseek import DeepSeekLLMProvider
from app.providers.genmax import GenmaxTTSProvider


class FakeResponse:
    def __init__(self, data=None, content=b"", status=200):
        self._data, self.content, self.status_code = data, content, status

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class DeepSeekSession:
    def post(self, *args, **kwargs):
        self.request = kwargs
        return FakeResponse({"choices": [{"message": {"content": """{
          "topic": "VAR và thẻ vàng thứ hai",
          "category": "sports_rules",
          "difficulty": "beginner",
          "series_title": "Bạn là VAR",
          "episode_title": "Tập 1",
          "connection_to_previous": "",
          "callback_line": "",
          "next_teaser": "Tập sau: bóng chạm tay có luôn là penalty?",
          "hook_type": "controversy"
        }"""}}]})


def test_deepseek_structured_output():
    session = DeepSeekSession()
    provider = DeepSeekLLMProvider("", session=session)
    result = provider.structured("topic_agent", {"content_id": "x"}, DailyPlan)
    assert result.topic == "VAR và thẻ vàng thứ hai"
    assert session.request["json"]["thinking"] == {"type": "disabled"}


def wav_bytes(seconds=.2):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x00" * int(16000 * seconds))
    return stream.getvalue()


class GenmaxSession:
    def post(self, *args, **kwargs):
        self.post_request = kwargs
        return FakeResponse({"id": "task-1"}, status=202)

    def get(self, url, **kwargs):
        if "/history/" in url:
            return FakeResponse({"id": "task-1", "status": "completed",
                                 "result": {"audio_url": "https://audio.test/result"}})
        return FakeResponse(content=wav_bytes())


def test_genmax_async_tts(tmp_path):
    session = GenmaxSession()
    provider = GenmaxTTSProvider("", "https://example.test/v1", "voice-1", session=session)
    result = provider.synthesize("Xin chào Việt Nam", tmp_path / "voice.wav")
    assert result.audio_path.exists()
    assert result.duration_seconds > 0
    assert session.post_request["json"]["language_code"] == "vi"
    assert session.post_request["json"]["provider"] == "elevenlabs"

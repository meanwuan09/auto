from __future__ import annotations

import json
import wave
from pathlib import Path

from app.models.schemas import VoiceResult
from app.providers.base import LLMProvider, TTSProvider


class GeminiLLMProvider(LLMProvider):
    name = "gemini"

    def __init__(self, api_key: str, model: str, prompt_dir: Path = Path("app/prompts"), client=None):
        if not api_key and client is None:
            raise ValueError("GEMINI_API_KEY is required when llm_provider=gemini")
        self.model = model
        self.prompt_dir = prompt_dir
        if client is None:
            from google import genai
            client = genai.Client(api_key=api_key)
        self.client = client

    def structured(self, agent: str, payload: dict, schema):
        from google.genai import types
        prompt_file = self.prompt_dir / f"{agent}.txt"
        instructions = prompt_file.read_text(encoding="utf-8") if prompt_file.exists() else (
            "Thực hiện vai trò được nêu trong tên agent. Trả dữ liệu chính xác theo schema."
        )
        response = self.client.models.generate_content(
            model=self.model,
            contents=json.dumps(payload, ensure_ascii=False, default=str),
            config=types.GenerateContentConfig(
                system_instruction=instructions,
                response_mime_type="application/json",
                response_schema=schema,
                temperature=0.75 if agent in {"topic_agent", "question_agent", "script_agent"} else 0.1,
            ),
        )
        if getattr(response, "parsed", None) is not None:
            return schema.model_validate(response.parsed)
        return schema.model_validate_json(response.text)


class GeminiTTSProvider(TTSProvider):
    name = "gemini"

    def __init__(self, api_key: str, model: str, voice: str, style: str, client=None):
        if not api_key and client is None:
            raise ValueError("GEMINI_API_KEY is required when tts_provider=gemini")
        self.model, self.voice, self.style = model, voice, style
        if client is None:
            from google import genai
            client = genai.Client(api_key=api_key)
        self.client = client

    def synthesize(self, text: str, output_path: Path, speech_rate: float = 1) -> VoiceResult:
        from google.genai import types
        prompt = (
            f"{self.style} Tốc độ tương đối {speech_rate:.2f}. "
            "Đọc chính xác nguyên văn sau, không thêm hoặc bỏ từ:\n" + text
        )
        response = self.client.models.generate_content(
            model=self.model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self.voice)
                    )
                ),
            ),
        )
        parts = response.candidates[0].content.parts
        audio = next((part.inline_data.data for part in parts if part.inline_data), None)
        if not audio:
            raise RuntimeError("Gemini TTS returned no audio")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        # Gemini TTS returns raw signed 16-bit mono PCM at 24 kHz.
        with wave.open(str(output_path), "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            wav.writeframes(audio)
        with wave.open(str(output_path), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
        words = text.split()
        timestamps = [
            {"word": word, "start": i * duration / max(len(words), 1),
             "end": (i + 1) * duration / max(len(words), 1)}
            for i, word in enumerate(words)
        ]
        return VoiceResult(audio_path=output_path, duration_seconds=duration, provider=self.name,
                           voice_id=self.voice, speech_rate=speech_rate,
                           word_timestamps=timestamps)

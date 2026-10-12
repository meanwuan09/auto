from __future__ import annotations

from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml
from pydantic import BaseModel, Field, model_validator


class Settings(BaseModel):
    channel_name: str = "Học Nhanh 30 Giây"
    niche: str = "Tiếng Anh giao tiếp"
    target_audience: str = "Người Việt Nam từ 16–35 tuổi"
    default_language: str = "vi"
    default_difficulty: str = "beginner"
    target_duration_seconds: int = Field(35, ge=25, le=60)
    daily_video_limit: int = Field(1, ge=1)
    default_publish_time: str = "20:00"
    timezone: str = "Asia/Ho_Chi_Minh"
    auto_publish: bool = False
    fact_check_threshold: float = Field(0.90, ge=0, le=1)
    duplicate_threshold: float = Field(0.86, ge=0, le=1)
    max_generation_attempts: int = Field(3, ge=1, le=10)
    llm_provider: str = Field("mock", pattern="^(mock|gemini|deepseek)$")
    tts_provider: str = Field("mock", pattern="^(mock|gemini|genmax)$")
    gemini_llm_model: str = "gemini-2.5-flash"
    gemini_tts_model: str = "gemini-3.1-flash-tts-preview"
    gemini_voice: str = "Kore"
    gemini_voice_style: str = "Giọng nữ trẻ, rõ ràng, thân thiện; phát âm tiếng Việt tự nhiên."
    deepseek_api_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"
    genmax_api_base_url: str = "https://api.genmax.io/v1"
    genmax_voice_id: str = ""
    genmax_model_id: str = "eleven_v3"
    genmax_engine: str = Field("elevenlabs", pattern="^(elevenlabs|minimax|capcut)$")
    genmax_language: str = "vi"
    series_enabled: bool = True
    series_title: str = "Tiếng Anh dùng được ngay"
    series_memory_size: int = Field(5, ge=1, le=30)
    database_url: str = "sqlite:///data/yqa.db"
    output_dir: Path = Path("output")
    emergency_stop: bool = False
    kill_switch: bool = False
    pause_dates: list[date] = []
    categories: list[str] = [
        "vocabulary", "grammar", "pronunciation", "common_mistakes",
        "workplace_english", "daily_conversation",
    ]
    difficulty_weights: dict[str, float] = {
        "beginner": .60, "intermediate": .35, "advanced": .05
    }

    @model_validator(mode="after")
    def validate_all(self):
        ZoneInfo(self.timezone)
        hour, minute = map(int, self.default_publish_time.split(":"))
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError("default_publish_time must be HH:MM")
        if abs(sum(self.difficulty_weights.values()) - 1) > .001:
            raise ValueError("difficulty_weights must sum to 1")
        return self


def load_settings(path: str | Path = "config.yaml") -> Settings:
    path = Path(path)
    if not path.exists():
        path = Path("config.example.yaml")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
    return Settings.model_validate(data or {})

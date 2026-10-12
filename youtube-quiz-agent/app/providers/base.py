from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

from app.models.schemas import Metadata, VoiceResult

T = TypeVar("T", bound=BaseModel)


class LLMProvider(ABC):
    name = "abstract"
    model = "unknown"

    @abstractmethod
    def structured(self, agent: str, payload: dict, schema: type[T]) -> T: ...


class TTSProvider(ABC):
    name = "abstract"

    @abstractmethod
    def synthesize(self, text: str, output_path: Path, speech_rate: float = 1) -> VoiceResult: ...


class StorageProvider(ABC):
    @abstractmethod
    def put(self, source: Path, key: str) -> str: ...


class YouTubeProvider(ABC):
    @abstractmethod
    def upload_video(self, path: Path, metadata: Metadata, content_id: str, checksum: str) -> str: ...
    @abstractmethod
    def get_processing_status(self, video_id: str) -> str: ...
    @abstractmethod
    def update_metadata(self, video_id: str, metadata: Metadata) -> None: ...
    @abstractmethod
    def schedule_video(self, video_id: str, publish_at: datetime) -> None: ...
    @abstractmethod
    def get_video_statistics(self, video_id: str) -> dict: ...

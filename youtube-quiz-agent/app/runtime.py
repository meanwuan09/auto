from __future__ import annotations

import os

from dotenv import load_dotenv

from app.config import load_settings
from app.database import create_db
from app.providers.gemini import GeminiLLMProvider, GeminiTTSProvider
from app.providers.deepseek import DeepSeekLLMProvider
from app.providers.genmax import GenmaxTTSProvider
from app.providers.mock import MockLLMProvider, MockTTSProvider, MockYouTubeProvider
from app.workflows.pipeline import Pipeline


def build_runtime(config="config.yaml"):
    load_dotenv()
    settings = load_settings(config)
    engine = create_db(settings.database_url)
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    llm_name = os.getenv("LLM_PROVIDER", settings.llm_provider).lower()
    tts_name = os.getenv("VOICEOVER_PROVIDER", os.getenv("TTS_PROVIDER", settings.tts_provider)).lower()
    if llm_name == "gemini":
        llm = GeminiLLMProvider(gemini_key, settings.gemini_llm_model)
    elif llm_name == "deepseek":
        llm = DeepSeekLLMProvider(
            os.getenv("DEEPSEEK_API_KEY", ""),
            os.getenv("DEEPSEEK_MODEL", settings.deepseek_model),
            os.getenv("DEEPSEEK_API_BASE_URL", settings.deepseek_api_base_url),
        )
    else:
        llm = MockLLMProvider()
    if tts_name == "gemini":
        tts = GeminiTTSProvider(gemini_key, settings.gemini_tts_model, settings.gemini_voice,
                                settings.gemini_voice_style)
    elif tts_name == "genmax":
        tts = GenmaxTTSProvider(
            os.getenv("GENMAX_API_KEY", ""),
            os.getenv("GENMAX_API_BASE_URL", settings.genmax_api_base_url),
            os.getenv("GENMAX_VOICE_ID", settings.genmax_voice_id),
            os.getenv("GENMAX_MODEL_ID", settings.genmax_model_id),
            os.getenv("GENMAX_ENGINE", settings.genmax_engine),
            settings.genmax_language,
        )
    else:
        tts = MockTTSProvider()
    return settings, engine, Pipeline(settings, engine, llm, tts, MockYouTubeProvider())

from __future__ import annotations

import json
from pathlib import Path

import requests

from app.providers.base import LLMProvider


class DeepSeekLLMProvider(LLMProvider):
    """DeepSeek OpenAI-compatible structured-output adapter."""

    name = "deepseek"

    def __init__(self, api_key: str, model: str = "deepseek-v4-flash",
                 base_url: str = "https://api.deepseek.com", prompt_dir: Path = Path("app/prompts"),
                 timeout: float = 90, session=None):
        if not api_key and session is None:
            raise ValueError("DEEPSEEK_API_KEY is required when llm_provider=deepseek")
        self.api_key, self.model = api_key, model
        self.base_url = base_url.rstrip("/")
        self.prompt_dir, self.timeout = prompt_dir, timeout
        self.session = session or requests.Session()

    def structured(self, agent: str, payload: dict, schema):
        prompt_file = self.prompt_dir / f"{agent}.txt"
        instructions = prompt_file.read_text(encoding="utf-8") if prompt_file.exists() else (
            "Thực hiện đúng vai trò của agent và chỉ trả JSON hợp lệ."
        )
        json_schema = schema.model_json_schema()
        system = (
            f"{instructions}\n"
            "Chỉ trả về một JSON object, không markdown và không giải thích ngoài JSON. "
            "JSON phải tuân thủ schema sau:\n"
            f"{json.dumps(json_schema, ensure_ascii=False)}"
        )
        response = self.session.post(
            f"{self.base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)},
                ],
                "response_format": {"type": "json_object"},
                "thinking": {"type": "disabled"},
                "temperature": .75 if agent in {"topic_agent", "question_agent", "script_agent"} else .1,
                "stream": False,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = response.json()
        content = data["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = content.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        return schema.model_validate_json(content)

from __future__ import annotations

from pydantic import BaseModel, Field

from app.providers.wikimedia import CommonsVideo


class FootballIncident(BaseModel):
    filename: str
    incident_type: str = Field(pattern="^(var|penalty|offside|handball|foul|card|disallowed_goal)$")
    event_name: str
    event_date: str
    factual_summary_vi: str


class FootballControversyGate:
    """Rejects footage unless metadata proves both football and a disputed decision."""

    FOOTBALL_TERMS = (
        "association football", "football match", "soccer", "samsunspor",
        "manisa fk", "tuzlaspor", "penalty kick", "penaltı", "maçı",
    )
    CONTROVERSY_TERMS = (
        "video assistant referee", " var ", "penalty", "penaltı", "offside",
        "handball", "red card", "yellow card", "disallowed", "gol iptal",
    )

    def validate(self, asset: CommonsVideo, incident: FootballIncident) -> dict:
        text = " ".join([
            asset.title, asset.description, *asset.categories,
        ]).lower()
        football_matches = sorted({term for term in self.FOOTBALL_TERMS if term in text})
        controversy_matches = sorted({term for term in self.CONTROVERSY_TERMS if term in text})
        if not football_matches:
            raise ValueError("Rejected: source metadata does not prove association football")
        if not controversy_matches:
            raise ValueError("Rejected: source metadata does not prove a controversial decision")
        if incident.incident_type not in {
            "var", "penalty", "offside", "handball", "foul", "card", "disallowed_goal"
        }:
            raise ValueError("Rejected: unsupported incident type")
        return {
            "football_only": True,
            "controversy_only": True,
            "football_evidence": football_matches,
            "controversy_evidence": controversy_matches,
            "incident_type": incident.incident_type,
        }

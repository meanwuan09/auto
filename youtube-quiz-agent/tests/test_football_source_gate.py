import pytest

from app.providers.wikimedia import CommonsVideo
from app.sources.football import FootballControversyGate, FootballIncident


def asset(title, description="", categories=None):
    return CommonsVideo(
        title=title,
        source_page="https://commons.wikimedia.org/wiki/File:example.webm",
        download_url="https://upload.wikimedia.org/example.webm",
        mime="video/webm",
        width=1920,
        height=1080,
        duration_seconds=26,
        author="Author",
        license_name="CC BY-SA 4.0",
        license_url="https://creativecommons.org/licenses/by-sa/4.0",
        attribution="Author — CC BY-SA 4.0",
        description=description,
        categories=categories or [],
        requires_share_alike=True,
    )


def incident():
    return FootballIncident(
        filename="match.webm",
        incident_type="var",
        event_name="Samsunspor–Manisa FK",
        event_date="2022-09-05",
        factual_summary_vi="Trọng tài cho hưởng phạt đền sau khi xem VAR.",
    )


def test_gate_accepts_real_football_var_incident():
    source = asset(
        "Samsunspor-Manisa maçı VAR penaltı.webm",
        categories=[
            "Category:Samsunspor vs Manisa FK, 5 September 2022",
            "Category:Video assistant referee",
        ],
    )
    result = FootballControversyGate().validate(source, incident())
    assert result["football_only"] is True
    assert result["controversy_only"] is True


def test_gate_rejects_real_sport_clip_without_controversy():
    source = asset(
        "Footvolley.webm",
        description="Futevolei Ipanema during the 2014 Brazil Tour",
        categories=["Category:Footvolley"],
    )
    with pytest.raises(ValueError, match="association football"):
        FootballControversyGate().validate(source, incident())

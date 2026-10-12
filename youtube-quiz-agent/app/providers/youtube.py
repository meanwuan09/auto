from __future__ import annotations

from datetime import datetime
from pathlib import Path

from app.models.schemas import Metadata
from app.providers.base import YouTubeProvider


class GoogleYouTubeProvider(YouTubeProvider):
    """Official YouTube Data API adapter. OAuth is created lazily; secrets never enter logs."""

    SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube"]

    def __init__(self, client_secret: Path, token_path: Path):
        self.client_secret, self.token_path = client_secret, token_path
        self.service = self._service()

    def _service(self):
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        creds = Credentials.from_authorized_user_file(self.token_path, self.SCOPES) if self.token_path.exists() else None
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        if not creds or not creds.valid:
            if not self.client_secret.exists():
                raise FileNotFoundError(f"Missing OAuth client secret: {self.client_secret}")
            creds = InstalledAppFlow.from_client_secrets_file(self.client_secret, self.SCOPES).run_local_server(port=0)
        self.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text(creds.to_json(), encoding="utf-8")
        return build("youtube", "v3", credentials=creds)

    def upload_video(self, path: Path, metadata: Metadata, content_id: str, checksum: str) -> str:
        from googleapiclient.http import MediaFileUpload
        body = {"snippet": {"title": metadata.title, "description": metadata.description,
                            "tags": metadata.tags, "categoryId": metadata.category_id,
                            "defaultLanguage": metadata.default_language},
                "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": metadata.made_for_kids}}
        request = self.service.videos().insert(part="snippet,status", body=body,
                                                media_body=MediaFileUpload(str(path), resumable=True))
        response = None
        while response is None:
            _, response = request.next_chunk()
        return response["id"]

    def get_processing_status(self, video_id):
        data = self.service.videos().list(part="processingDetails", id=video_id).execute()
        return data["items"][0]["processingDetails"]["processingStatus"]

    def update_metadata(self, video_id, metadata):
        self.service.videos().update(part="snippet", body={"id": video_id, "snippet": {
            "title": metadata.title, "description": metadata.description, "tags": metadata.tags,
            "categoryId": metadata.category_id}}).execute()

    def schedule_video(self, video_id, publish_at: datetime):
        self.service.videos().update(part="status", body={"id": video_id, "status": {
            "privacyStatus": "private", "publishAt": publish_at.isoformat().replace("+00:00", "Z")}}).execute()

    def get_video_statistics(self, video_id):
        data = self.service.videos().list(part="statistics", id=video_id).execute()
        return data["items"][0]["statistics"]

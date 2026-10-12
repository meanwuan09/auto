# YouTube Quiz Agent

Pipeline agentic tạo YouTube Shorts “câu đố/học nhanh” cho người Việt. Bản mặc định chạy hoàn toàn local bằng provider mock, render MP4 thật và QA thật; không gọi API hoặc upload thật nếu chưa chủ động cấu hình OAuth/provider.

Hệ thống hỗ trợ Gemini cho cả structured LLM và TTS. Mỗi video thuộc một series có số tập,
liên kết tới tập trước, callback ngắn và teaser cụ thể cho tập tiếp theo. Tập mới phải thực hiện
lời hứa của teaser cũ, đồng thời vẫn giải đáp trọn vẹn và có giá trị khi xem độc lập.

## Cài đặt

Yêu cầu Python 3.11+. FFmpeg hệ thống là tùy chọn vì `imageio-ffmpeg` tự cung cấp binary.

```powershell
cd youtube-quiz-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item config.example.yaml config.yaml
```

## Bật Gemini LLM và Gemini Voice

Tạo API key trong Google AI Studio, sau đó thêm vào `.env`:

```dotenv
GEMINI_API_KEY=your_real_key
```

Đổi các giá trị trong `config.yaml`:

```yaml
llm_provider: gemini
tts_provider: gemini
gemini_llm_model: gemini-2.5-flash
gemini_tts_model: gemini-3.1-flash-tts-preview
gemini_voice: Kore
gemini_voice_style: "Giọng nữ trẻ, rõ ràng, thân thiện; phát âm tiếng Việt tự nhiên và từ tiếng Anh chuẩn."
series_enabled: true
series_title: "Tiếng Anh dùng được ngay"
series_memory_size: 5
```

Có thể chỉ bật Gemini LLM và giữ `tts_provider: mock`, hoặc ngược lại. Nếu chọn Gemini mà thiếu
`GEMINI_API_KEY`, hệ thống dừng với lỗi cấu hình rõ ràng thay vì âm thầm dùng provider khác.
Tên model và voice được cấu hình riêng vì các model TTS Gemini hiện có thể thay đổi trong giai đoạn preview.

### DeepSeek LLM và Genmax Voice

Không ghi key vào `config.yaml`. Thêm chúng vào `.env` theo mẫu `.env.example`, rồi chọn:

```dotenv
LLM_PROVIDER=deepseek
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=...

VOICEOVER_PROVIDER=genmax
GENMAX_API_BASE_URL=https://api.genmax.io/v1
GENMAX_VOICE_ID=...
GENMAX_MODEL_ID=eleven_v3
GENMAX_ENGINE=elevenlabs
GENMAX_API_KEY=...
```

DeepSeek chạy JSON mode, non-thinking để giảm chi phí cho các agent structured-output. Genmax tạo task
bất đồng bộ, được poll với timeout/backoff; audio tải về được chuyển sang WAV mono 24 kHz trước khi render.

## Chạy local

```powershell
python -m app.cli generate
python -m app.cli status CONTENT_ID
python -m app.cli preview CONTENT_ID
python -m app.cli approve CONTENT_ID
python -m app.cli upload CONTENT_ID
```

`generate` chạy Question → duplicate check → fact-check độc lập → script → mock voice → subtitle → MP4 1080×1920 → QA → `AWAITING_APPROVAL`. `upload` mặc định dùng Mock YouTube và trả ID bắt đầu bằng `dry_`; không tuyên bố video đã xuất hiện trên YouTube.

Trước Question Agent, Topic Agent đọc lịch sử series gần nhất và tạo `DailyPlan`. Dữ liệu continuity
được lưu trong bảng `content_links`; LLM không chỉ dựa vào chat history tạm thời nên scheduler có thể
khởi động lại mà vẫn nối đúng mạch. Khi TTS trả duration thật, audio hoàn chỉnh được điều chỉnh tốc độ
về timeline mục tiêu trong giới hạn an toàn; pipeline không cắt mất cuối câu hoặc làm lệch mốc reveal.

Các lệnh khác:

```powershell
python -m app.cli render CONTENT_ID
python -m app.cli reject CONTENT_ID --reason "..."
python -m app.cli retry CONTENT_ID
python -m app.cli run-daily
python -m app.cli collect-analytics
python -m app.cli daily-report
python -m app.cli list
uvicorn app.api.main:app --reload
pytest
```

## YouTube OAuth thật

1. Tạo Google Cloud project, bật YouTube Data API v3 và YouTube Analytics API.
2. Tạo OAuth Client ID loại Desktop app.
3. Tải JSON vào `secrets/client_secret.json` (đã bị Git ignore).
4. Khởi tạo `GoogleYouTubeProvider(Path("secrets/client_secret.json"), Path("secrets/token.json"))` trong composition root `app/runtime.py`.
5. Lần chạy đầu mở consent screen; token refresh được lưu ở `secrets/token.json`.

Adapter thật dùng resumable upload, khởi tạo video private và `publishAt` UTC. Trước production cần cấu hình consent screen/verification phù hợp và thay Mock LLM/TTS bằng adapter triển khai `LLMProvider`/`TTSProvider`.

## Scheduler

- Windows Task Scheduler: chạy `powershell -File <project>\scripts\run_daily.ps1` mỗi ngày.
- Linux cron: `0 9 * * * /absolute/path/scripts/run_daily.sh`.
- Server: `docker compose run --rm agent`.

Scheduler nội bộ ở `app.scheduler` dùng timezone cấu hình, lock file, `max_instances=1` và coalescing. Kill switch, emergency stop, pause dates và daily limit nằm trong `config.yaml`.

## An toàn và vận hành

State machine cùng `state_transitions` cho phép audit/resume. Upload yêu cầu QA pass và approval khi `auto_publish: false`; unique constraints chống trùng `content_id` và checksum. Không log credential. Asset render là hình tự tạo bằng Pillow; không tải nội dung Internet.

Mock TTS tạo track âm thanh kiểm thử có timestamp, không phải giọng nói tự nhiên. QA code kiểm tra container/codec/resolution/duration/audio/checksum; các kiểm tra ngữ nghĩa và layout nâng cao hiện là rule-based, cần bổ sung OCR/ASR/frame sampling trước production quy mô lớn.

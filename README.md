# Auto Affiliate - TikTok + Shopee

## RoxyBrowser cho TikTok

Luồng TikTok dùng profile RoxyBrowser khi `data/roxy-browser.json` có `"mode": "roxy"`.
Mở profile đã chọn trong RoxyBrowser trước khi chạy; công cụ đọc cổng CDP cục bộ
của profile đang mở rồi gắn Playwright vào đúng phiên. Profile hiện chọn là
`260903-130`. Chưa cần đăng nhập TikTok để kiểm tra kết nối trình duyệt.

Để tự mở profile khi chưa chạy, bật **API > API Configuration > Enabled** trong
RoxyBrowser. Ghi `workspace_id` và `profile_id` vào file cấu hình. Đặt API key
trong biến môi trường `ROXY_API_TOKEN` khi chạy LUNO và các script TikTok; hoặc
đặt `api_token` trong file cấu hình cục bộ (thư mục `data/` không được commit).
Khi thiếu profile hoặc OpenAPI không sẵn sàng, lệnh dừng và báo lỗi; không tự
chuyển sang Chrome.

Sau khi bật API và đặt token, chạy
`third_party/luno-automation/backend/.venv/Scripts/python.exe scripts/list_roxy_profiles.py`
để xem workspace ID và profile ID. Chọn profile đã đăng nhập đúng tài khoản TikTok.

Chạy `third_party/luno-automation/backend/.venv/Scripts/python.exe scripts/list_tiktok_posts.py`
để kiểm tra profile đang chọn trước khi đăng. Không chạy song song hai tác vụ trên
cùng profile.

Chạy `third_party/luno-automation/backend/.venv/Scripts/python.exe scripts/check_roxy_connection.py`
để kiểm tra kết nối RoxyBrowser mà không mở TikTok hay đọc nội dung các tab.

## Quy trình Douyin → tiếng Việt → TikTok / Shopee Video

Tab **Quy trình Reup** là luồng mới. Nó dùng các bản clone trong `third_party/`:

| Thành phần | Vai trò | Địa chỉ mặc định |
|---|---|---|
| `Douyin_TikTok_Download_API` | Phân tích link và tải video Douyin | `127.0.0.1:8080` |
| `VideoLingo` | Nhận dạng tiếng Trung, dịch và lồng tiếng Việt | `127.0.0.1:8000` |
| `luno-automation` | Đăng TikTok / Shopee Video kèm sản phẩm | `127.0.0.1:8756` |
| `pyvideotrans` | CLI lồng tiếng dự phòng, chưa nằm trong luồng tự động | - |

Các clone giữ giấy phép và README riêng. LUNO đã được chỉnh tại chỗ: nếu không thấy đúng ID sản phẩm Shopee, lượt đăng báo lỗi thay vì chọn sản phẩm đầu tiên. `pyvideotrans` mang giấy phép GPL-3.0 nên không nhúng mã của nó vào dashboard; VideoLingo cung cấp HTTP API cho luồng mặc định.

### Chuẩn bị dịch vụ

Mỗi khối lệnh dưới đây chạy trong terminal riêng, bắt đầu từ thư mục gốc dự án.

1. Bật Docker Desktop. Làm theo [hướng dẫn cài Douyin API](third_party/Douyin_TikTok_Download_API/docker/README.md) để tạo `.env`, tài khoản quản trị và API key. Thêm `DTK_DOWNLOADER_URL=http://downloader:9100` vào `.env`. Dùng cổng `8080` để tránh xung đột với VideoLingo, và bật profile `downloader`:

   ```powershell
   cd third_party/Douyin_TikTok_Download_API
   $env:DTK_BIND_PORT = '8080'
   docker compose -p dtk -f docker/compose.yml --profile downloader up -d --build
   ```

   Nếu dịch vụ cần identity/cookie Douyin, cấu hình trong console của nó. API key dùng cho ứng dụng phải có quyền `douyin:read`, `media:read`, `media:write`.

2. Cấu hình LLM/ASR/TTS trong [VideoLingo](third_party/VideoLingo/README.md), rồi chạy từ thư mục repo:

   ```powershell
   cd third_party/VideoLingo
   uv run start.py --api
   ```

   API ghi đầu ra vào `output/` và mỗi lần chỉ xử lý một video. Cấu hình TTS phải có giọng tiếng Việt; kiểm tra bản xem trước trước khi duyệt.

3. Cài backend LUNO theo [hướng dẫn của repo](third_party/luno-automation/README.vi.md), mở Chrome và đăng nhập tài khoản TikTok/Shopee của bạn trong LUNO. Sau đó chạy backend:

   ```powershell
   cd third_party/luno-automation/backend
   python server.py
   ```

   LUNO cần session tài khoản đã lưu qua giao diện Electron của repo (hoặc các endpoint tài khoản của backend). ID sản phẩm TikTok và ID sản phẩm Shopee là ID trong các trung tâm bán hàng tương ứng, không phải URL affiliate thường. Tài khoản phải đủ điều kiện affiliate để link sản phẩm được ghi nhận hoa hồng.

4. Trong terminal chạy dashboard, đặt API key và khởi động:

   ```powershell
   $env:DTK_API_KEY = 'key-cua-ban'
   cd C:\Users\thaot\Desktop\auto
   npm.cmd start
   ```

   Mở `http://127.0.0.1:3210`. Có thể đổi URL dịch vụ bằng `DTK_BASE_URL`, `VIDEOLINGO_BASE_URL`, `LUNO_BASE_URL`; các dịch vụ phải chạy trên localhost.

### Thực hiện

Đăng TikTok: tại **Tài khoản đăng TikTok**, bấm **Đăng nhập TikTok**, đăng nhập thủ công trong Chrome. Công cụ chỉ lưu phiên vào LUNO khi trang upload TikTok Studio đã sẵn sàng, không tự thao tác đăng nhập hoặc vượt xác minh. Sau khi lưu phiên, cửa sổ này đóng và dashboard hiển thị tài khoản đang dùng. Video tiếng Việt cần caption không có URL và được duyệt trước khi đăng; ID sản phẩm TikTok là tùy chọn. Nếu chỉ dùng link Shopee trong bình luận, để trống ID sản phẩm TikTok. Khi đăng, `add_music=false` để giữ bản âm thanh đã xử lý. Phiên đã lưu chưa đảm bảo luôn còn hiệu lực; lỗi TikTok được ghi vào lịch sử đăng.

1. Dán một hoặc nhiều link video Douyin (mỗi dòng một link, nhận cả nội dung chia sẻ có link), xác nhận quyền sử dụng và bấm **Tải video**. Hàng đợi tải lần lượt, bỏ qua link đã có và tiếp tục khi khởi động lại. Dashboard dùng Douyin API nếu dịch vụ sẵn sàng; nếu không, dùng Chrome headless + yt-dlp đã cài tại máy. MP4 được kiểm tra bằng ffprobe trước khi chuyển sang **Có video nguồn**. Bộ tải local chỉ nhận link video hoặc link chia sẻ, chưa quét kênh/từ khóa.
2. Bấm **Lồng tiếng**. VideoLingo tạo bản MP4 tiếng Việt; trạng thái chuyển sang **Chờ duyệt**.
3. Xem cả bản gốc lẫn bản tiếng Việt, nhập caption. ID/tên sản phẩm là tùy chọn cho TikTok, bắt buộc với luồng Shopee Video hiện tại. Bấm **Lưu thông tin**, sau đó **Duyệt video**.
4. Chọn TikTok hoặc Shopee Video, chạy **Kiểm tra trước**, **Lưu nháp**, hoặc **Đăng ngay**. Kết quả từ LUNO hiện trong lịch sử đăng của video.

### Tự tìm video Douyin

Mặc định **Tìm video Douyin** dùng chế độ **Nguồn công khai · không cần tài khoản**: đọc video trên `https://www.douyin.com/jingxuan` bằng phiên Chrome mới, không cần đăng nhập. Bấm **Quét ngay** hoặc bật **Quét mỗi giờ**. Nguồn công khai đã được kiểm tra lấy link và số liệu tương tác thật. Danh sách này gồm nhiều chủ đề, chưa bảo đảm video phù hợp sản phẩm affiliate.

Để quét từ khóa/kênh, tắt chế độ chỉ nguồn công khai. Có sẵn từ khóa tiếng Trung cho đồ bếp, gia dụng và dụng cụ tiện ích; có thể thêm từ khóa hoặc URL kênh `https://www.douyin.com/user/...`. Một số nguồn này có thể yêu cầu đăng nhập: nút **Đăng nhập Douyin** mở cửa sổ Chrome riêng, cần đóng khi xong. Cookie được lưu tại `data/douyin-discovery-profile/`; không chia sẻ thư mục này. Đăng nhập không phải điều kiện để dùng bảng video công khai.

Mỗi vòng xử lý tối đa 3 nguồn (ưu tiên nguồn lâu chưa quét), tối đa 50 video mỗi nguồn. Ứng viên được lưu theo URL chuẩn, đối chiếu video đã tải, xếp điểm theo lượng thích/chia sẻ/bình luận và độ mới. Tốc độ tăng tương tác cần hai lần đo cách nhau ít nhất 15 phút; video thiếu số liệu có điểm 0, không tự tải. Điểm là công thức ưu tiên, không đảm bảo video sẽ lên xu hướng tại Việt Nam và chưa tự khớp sản phẩm Shopee.

Bật **Tự tải từ kênh đã xác nhận quyền** để chọn tối đa 3 video mỗi vòng, điểm từ 15, dài 10–180 giây, đăng trong 30 ngày gần nhất. Chỉ kênh có xác nhận quyền sử dụng mới được tự tải; kết quả từ bảng công khai hoặc từ khóa cần xác nhận từng video khi bấm **Tải video**. Đầu ra đi vào hàng đợi tải hiện có; lồng tiếng, duyệt và đăng vẫn theo luồng trước. Khi Douyin yêu cầu đăng nhập/xác minh hoặc không trả kết quả, nguồn báo lỗi; công cụ không vượt captcha.

### Shopee Custom Link

Trong **Kiểm tra** của từng clip, lưu URL sản phẩm Shopee rồi bấm **Mở Custom Link**. Dashboard sao chép URL sản phẩm và mở trang `https://affiliate.shopee.vn/offer/custom_link` trong Chrome. Dán URL vào trang Shopee, đặt `Sub_id1=Reup`, `Sub_id2=Clip<ID>`, tạo link và dán link trả về vào ô **Link affiliate Shopee trả về** của clip. Đổi URL sản phẩm sẽ xóa link affiliate cũ để tránh gắn nhầm. Một tài khoản Affiliate có thể xử lý nhiều clip; hiện tài khoản không có quyền Open API nên bước tạo link trên trang Shopee cần thao tác trong phiên đăng nhập. Dashboard lưu liên kết theo clip, không tự chèn link vào caption hay coi link đó là thao tác gắn sản phẩm Shopee Video. Kiểm tra link trước khi công bố.

URL affiliate chỉ dùng trong bình luận. Caption chứa URL sẽ bị từ chối. Khi LUNO báo đăng thật thành công, lịch sử đăng hiển thị **Sao chép link** cho đúng lượt đăng; sau khi bình luận và kiểm tra trên nền tảng, bấm **Đã bình luận** để ghi nhận. Link được chốt lúc bắt đầu đăng nên thay sản phẩm của clip sau đó không đổi link của bài cũ. Bản nháp và lượt kiểm tra trước không có bước bình luận. LUNO không trả về link bài đăng, nên link bài TikTok phải được lưu vào lượt đăng trước khi tự bình luận (xem bên dưới); nền tảng có thể hạn chế link trong bình luận.

Để dùng đúng phiên Chrome đang đăng nhập của hồ sơ **quang** mà không đăng nhập lại, cài tiện ích nội bộ theo [hướng dẫn](extensions/shopee-custom-link/README.md). Nút **Tạo link và lưu vào clip** của tiện ích điền URL và Sub_id, bấm **Lấy link**, đọc link rút gọn trong hộp kết quả rồi lưu vào clip qua dashboard local. Sau khi cập nhật tiện ích, bấm **Tải lại** ở `chrome://extensions`.

**Tạo link tự động (Shopee Affiliate Open API):** khi tài khoản được cấp Open API (affiliate.shopee.vn → Open API), tạo `data/shopee-openapi.json` với `{"appId": "...", "secret": "..."}` (hoặc biến môi trường `SHOPEE_AFFILIATE_APP_ID`/`SHOPEE_AFFILIATE_SECRET`) rồi khởi động lại dashboard. Nút **Tạo link tự động** gọi `generateShortLink` với Sub_id `Reup`/`Clip<ID>` và lưu link vào clip. Không dùng Playwright để mở trang Custom Link: Shopee chặn trình duyệt tự động bằng captcha.

**Tự bình luận TikTok:** trong **Lịch sử đăng**, bài đang chờ bình luận có ô **Link bài TikTok**. Lưu link bài, chọn trình duyệt (mặc định theo `data/roxy-browser.json`, hoặc Chrome) rồi bấm **Tự bình luận**. Dashboard chạy `scripts/open_tiktok_comment.py`: gửi link một lần, tải lại trang để kiểm tra bình luận còn hiển thị, rồi mới ghi **Đã xác nhận bình luận**. Nếu TikTok hiện xác minh, dashboard báo và chờ tối đa 3 phút để người dùng tự giải trong cửa sổ trình duyệt. Lỗi được ghi ở lượt đăng và có thể bấm lại.

Luồng này không tự chọn sản phẩm affiliate từ nội dung clip. Người duyệt chịu trách nhiệm khớp đúng sản phẩm, quyền dùng lại video và quyền affiliate trên tài khoản đăng. Scheduler ADB cũ vẫn ở các tab khác và không tham gia luồng mới.

Chạy kiểm thử tích hợp với dịch vụ giả lập: `npm.cmd test`.

Bộ tải local dùng Python tại `third_party/luno-automation/backend/.venv/Scripts/python.exe` (cần `playwright` và Chrome), `tools/yt-dlp.exe`, `tools/ffmpeg.exe` và ffprobe trong `tools/ffmpeg/`. Cookie được tạo trong phiên riêng và xóa sau khi tải. Có thể đặt `DOUYIN_PYTHON` để chọn Python khác, `DOUYIN_DOWNLOAD_MODE=local` hoặc `api` để chọn bộ tải; mặc định là `auto`. Mỗi đợt nhận tối đa 50 link. Douyin yêu cầu đăng nhập hoặc hiện captcha thì job báo lỗi để thử lại.

### Chạy trực tiếp trên file thật

Đã có bộ chạy nhẹ tại `scripts/`, dùng Faster Whisper CPU để chép lời, Edge TTS cho giọng Việt và FFmpeg để dựng MP4. Không cần khóa LLM khi bản dịch đã được kiểm tra thủ công. Môi trường đã cài tại `data/dub-venv/`; model Whisper nhỏ được lưu trong `data/models/`.

```powershell
# Tải bằng cookie của phiên Chrome riêng; cookie tạm bị xóa sau khi tải.
third_party/luno-automation/backend/.venv/Scripts/python.exe scripts/download_douyin.py "https://www.douyin.com/video/VIDEO_ID" media/reup/1-source.mp4

# Video có phụ đề chữ in sẵn (phần lớn clip Douyin): đọc chữ bằng OCR, khoảng 2 giây xử lý cho mỗi giây video.
data/dub-venv/Scripts/python.exe -X utf8 scripts/ocr_subtitles.py media/reup/1-source.mp4 media/reup/1-ocr.json
# Video không có chữ: chép lời bằng Whisper.
data/dub-venv/Scripts/python.exe scripts/transcribe_video.py media/reup/1-source.mp4 media/reup/1-transcript.json

# Dịch bản nháp 1-reviewed-vi.draft.json rồi lưu thành 1-reviewed-vi.json.
data/dub-venv/Scripts/python.exe scripts/dub_reviewed.py media/reup/1-source.mp4 media/reup/1-reviewed-vi.json media/reup/1-vi.mp4
node scripts/attach_dubbed.js 1 media/reup/1-vi.mp4
```

`ocr_subtitles.py` lấy 4 khung mỗi giây và đọc mọi chữ Hán trên hình. Kết quả ghi vào hai file:

- `JOB-ocr.json`: từng dòng chữ kèm khung và thời gian hiện. `dub_reviewed.py` dùng file này để làm mờ đúng chỗ, đúng lúc, mép mờ mềm, và đặt phụ đề Việt vào vị trí phụ đề gốc.
- `JOB-reviewed-vi.draft.json`: mỗi phụ đề là một câu, câu tiếng Trung để ở `source`, còn `text` để trống chờ dịch. Script đoán vai từ nhãn tên lặp lại trên hình (姐姐, 弟弟…) và chọn giọng nam/nữ theo chữ trong nhãn. Tiêu đề, dòng miễn trừ hiện lâu, cùng các dòng bắt đầu bằng `#` hoặc `*` được đánh dấu `"voiced": false`.

Khi dịch: điền `text`; gộp các câu liền nhau của cùng một người nếu cần; xóa câu không muốn giữ; kiểm tra lại vai. Câu nào còn `text` trống thì `dub_reviewed.py` dừng và báo lỗi. OCR bỏ qua chữ in trên áo hoặc đồ vật (chữ to hơn 8% chiều cao khung, hoặc chữ ngắn có điểm tin cậy thấp), nên đôi khi cũng sót câu một hai chữ. Đối chiếu bản nháp với video trước khi dựng. Chạy lại với `--reuse` để gom lại dữ liệu OCR đã có mà không phải đọc lại.

Nếu `media/reup/JOB_ID-reviewed-vi.json` và môi trường Python đã có, nút lồng tiếng trong dashboard chạy bộ dựng nhẹ này. Các job chưa có bản dịch dùng VideoLingo như trước. Script tạo track WAV riêng, phụ đề SRT/ASS và báo cáo QA; không cắt giọng đọc để ép vào timeline. Khoảng lặng Edge TTS chèn ở hai đầu mỗi câu được bỏ trước khi tính tốc độ, và câu được đọc lấn sang khoảng trống trước câu nói kế tiếp. Câu cần tăng tốc quá 1,35x bị từ chối; rút gọn bản dịch, nới mốc thời gian hoặc đặt `max_speed` nếu thật cần. Demucs `htdemucs` tách vocal gốc; phần âm nền được giữ ở gain 1 rồi ghép lời đọc tiếng Việt và chuẩn hóa về -14 LUFS (mức TikTok phát). Tách nguồn có thể để lại dấu vết vocal hoặc làm thay đổi một số âm nền. Đây là giọng đọc, không phải giọng hát hoặc giọng clone.

Mặc định phụ đề tiếng Việt được in lên hình (mã hóa lại H.264 CRF 18, giữ độ phân giải). Các trường tùy chọn trong file bản dịch:

| Trường | Ý nghĩa |
|---|---|
| `voices` + `speaker` của từng câu | Giọng theo vai, ví dụ `{"chi": "vi-VN-HoaiMyNeural", "em": "vi-VN-NamMinhNeural"}`. Câu không có `speaker` dùng `voice`. Edge TTS tiếng Việt chỉ có hai giọng này. |
| `"voiced": false` ở một câu | Chỉ hiện chữ (màu vàng, phía trên), không đọc. Dùng cho chú thích/hashtag trên màn hình gốc. |
| `mask` | Tên file `JOB-ocr.json` (bản nháp tự điền). Làm mờ từng dòng chữ gốc khi nó hiện trên hình; thay cho `cover`. |
| `cover` | Không có OCR: danh sách dải cần làm mờ để che chữ gốc, tính theo tỉ lệ chiều cao khung: `[{"y": 0.54, "height": 0.19}]`. Phụ đề Việt nằm ngay trên mép dưới của dải thấp nhất. Chọn dải bằng cách xem khung hình của clip; chữ gốc nằm ngoài dải sẽ không bị che. |
| `burn_subtitles` | `false` để giữ nguyên luồng hình như trước, không in phụ đề. |
| `max_speed` | Nâng giới hạn tăng tốc (mặc định 1,35). |

Thư viện: `uv pip install --python data/dub-venv/Scripts/python.exe -r scripts/dubbing-requirements.txt` (Demucs tách giọng, RapidOCR đọc chữ). Model được tải lần đầu vào `data/models/torch/`. Dùng `--reuse-audio` khi bản dịch và giọng không đổi để dựng lại bằng các đoạn TTS đã có.

Clip #1 thực tế là clip tiếng Anh hát nhép bài Poker Face, không có lời thoại tiếng Trung giới thiệu sản phẩm. Bản chép tự động có lỗi do nhạc nền; bản dịch mẫu đã được đối chiếu bằng phụ đề trên video. Mốc cue được căn gần đúng và cần duyệt trước khi đăng.

---

Công cụ tự động: tải video (yt-dlp) → xử lý bỏ watermark (ffmpeg) → đăng lên TikTok qua giả lập (ADB) → tự động comment link affiliate Shopee.

> ⚠️ LƯU Ý: Đăng video + spam comment tự động vi phạm điều khoản TikTok. Tài khoản có thể bị hạn chế hoặc khóa. Chỉ dùng tài khoản phụ, chấp nhận rủi ro. Nên set delay ngẫu nhiên và không lạm dụng.

## Yêu cầu

- Node.js 20+ (đã có: v24)
- Giả lập Android: **LDPlayer** (khuyên dùng, hỗ trợ nhiều instance) hoặc MuMu/BlueStacks/Nox
- Cài app TikTok (`com.ss.android.ugc.aweme`) trong TỪNG instance giả lập
- Tài khoản TikTok trong mỗi instance (mỗi instance = 1 tài khoản riêng)

## Cài đặt

```bash
npm install
npm start
```

Mở trình duyệt: **http://localhost:3210** (đổi port bằng biến môi trường `PORT`)

Lần đầu chạy, bấm nút **"Cài yt-dlp"** và **"Cài ffmpeg"** trên trang web (tự tải về thư mục `tools/`).

Hằng ngày trên Windows: bấm đúp `start-auto.cmd` (hoặc lối tắt trên Desktop). File này mở RoxyBrowser, chạy LUNO (cổng 8756) và dashboard (cổng 3210) trong hai cửa sổ thu nhỏ rồi mở trang web; phần nào đang chạy thì bỏ qua. Token Roxy đặt trong `data/roxy-browser.json` (khóa `api_token`), không ghi vào file khởi động. Log nằm ở `%TEMP%\dashboard.log` và `%TEMP%\luno.log`.

## Quy trình sử dụng

1. **Mở giả lập**: LDPlayer → tạo nhiều instance (mỗi instance 1 account TikTok) → cài TikTok vào từng máy → bật máy.
2. **Quét thiết bị**: bấm "Quét thiết bị" trên trang. Tool tự dò adb.exe của giả lập và liệt kê các instance (emulator-5554, emulator-5556...).
3. **Hiệu chỉnh tọa độ** (quan trọng): bấm "Ảnh màn hình" của từng máy → click vào các nút trên ảnh (nút +, Tiếp theo, Đăng, tab Hồ sơ, ô comment...) → bấm nút step tương ứng → "Lưu tọa độ đã gán". Làm 1 lần cho mỗi độ phân giải.
4. **Thêm link affiliate Shopee**: tab "Link affiliate" → dán các link Shopee (lấy từ affiliate.shopee.vn) → Thêm. Tool chọn link ít dùng nhất để dán mỗi lần.
5. **Thêm video**: tab Video → dán URL video (TikTok/YouTube/...) → "Tải + xử lý". Tool tự tải về `media/raw/`, cắt watermark + re-encode ra `media/processed/`.
6. **Đăng**: bấm "Đăng video" trên thiết bị (đăng video sẵn sàng) — hoặc bật **Scheduler** để tự đăng theo chu kỳ + tự comment link.
7. Theo dõi tab **Log** (real-time qua Socket.IO) và cột "Đăng lần cuối" của từng máy.

## Tọa độ nút mặc định (fraction, chuẩn 1080x1920 portrait)

| Step | Vị trí |
|---|---|
| create_btn | 0.5, 0.94 (nút + tạo video) |
| gallery_tab | 0.5, 0.93 (tab Thư viện) |
| first_video | 0.17, 0.18 (video đầu trong grid) |
| next_btn | 0.85, 0.05 (nút Tiếp theo) |
| caption_box | 0.5, 0.2 (ô mô tả) |
| post_btn | 0.88, 0.05 (nút Đăng) |
| profile_tab | 0.08, 0.95 (tab Hồ sơ) |
| first_video_profile | 0.5, 0.55 (video mới nhất trên profile) |
| comment_box | 0.5, 0.93 (ô comment) |
| comment_input | 0.5, 0.97 (ô nhập comment) |
| send_btn | 0.9, 0.97 (nút gửi) |

Tọa độ lưu theo từng thiết bị (cột "Tọa độ" / tab modal). Có thể sửa trực tiếp JSON.

## Cấu trúc

```
server/
  index.js          # Express + API + Socket.IO
  db.js             # SQLite (node:sqlite)
  services/
    adb.js          # Điều khiển giả lập qua ADB (tap, input text, screencap, push)
    poster.js       # Luồng đăng video + comment tự động
    processor.js    # yt-dlp tải video + ffmpeg xử lý (cắt watermark, re-encode)
    scheduler.js    # Tự đăng theo lịch
public/             # Dashboard web
media/raw|processed # Video thô / đã xử lý
data/app.db         # SQLite
tools/              # yt-dlp.exe, ffmpeg.exe (tự cài)
```

## Cài đặt quan trọng (tab Cài đặt)

- `adb_path` / `ffmpeg_path` / `ytdlp_path`: để trống = tự dò
- `caption_template`: caption mặc định
- `tap_delay_ms` + `tap_delay_jitter_ms`: delay ngẫu nhiên giữa các thao tác (chống phát hiện)
- `post_cooldown_min`: nghỉ tối thiểu giữa 2 bài trên 1 máy
- `scheduler_max_posts_per_day`: trần bài/ngày/máy
- `watermark_remove`: 1 = cắt vùng watermark bên phải (crop_px pixel), 0 = giữ nguyên

## Lưu ý vận hành

- Lần đầu mỗi máy: bật TikTok thủ công 1 lần để cho phép quyền truy cập ảnh/video.
- Nếu adb không tự tìm thấy: đặt đường dẫn adb.exe trong Settings (LDPlayer: `C:\LDPlayer\LDPlayer9\adb.exe`).
- Link comment bị TikTok ẩn trong một số trường hợp; nên dùng link rút gọn nếu cần.
- Đừng chạy nhiều máy cùng lúc nếu tài khoản còn mới (thuật toán TikTok nhạy cảm với spam).

## Bản vá LUNO

Thư mục `third_party/` không nằm trong git. Các chỉnh sửa cho `luno-automation` (đăng qua profile RoxyBrowser theo kênh, nhãn "Nội dung do AI tạo", tự bật kiểm tra nội dung, chờ tải file lớn) nằm ở `patches/luno-automation.patch`. Sau khi clone LUNO:

```powershell
cd third_party/luno-automation
git apply ../../patches/luno-automation.patch
```

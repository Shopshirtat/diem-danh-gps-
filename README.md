# Điểm danh GPS — v2

Chấm công theo vị trí văn phòng. Frontend tĩnh trên GitHub Pages, dữ liệu lưu trong Google Sheet qua Apps Script.

---

## Triển khai — làm đúng thứ tự

### Bước 1 — Backend

1. Mở Google Sheet của bạn → **Extensions › Apps Script**.
2. Xoá sạch code cũ, dán toàn bộ `Code.gs` mới vào.
3. Sửa hai dòng ở đầu file:

   ```js
   const SETUP_PIN    = '1234';      // đổi thành PIN 4 số của bạn
   const SETUP_INVITE = 'VANPHONG';  // đổi thành mã mời phát cho nhân viên
   ```

4. Chọn hàm **`initSetup`** trong ô chọn hàm, bấm **Run**. Cấp quyền khi Google hỏi.
   Mở **Execution log**, phải thấy dòng `✓ Đã cài đặt xong.`

### Bước 2 — Deploy

**Deploy › New deployment › Type: Web app**

| Trường | Giá trị |
|---|---|
| Execute as | **Me** |
| Who has access | **Anyone** |

> `Anyone`, **không phải** `Anyone with Google account`. Chọn sai thì mọi lệnh gọi trả về trang đăng nhập và app báo lỗi kết nối.

Copy URL kết thúc bằng `/exec`.

### Bước 3 — Frontend

Mở `index.html`, tìm dòng có `PASTE_URL_MOI_VAO_DAY` (dòng 274), thay bằng URL vừa copy.

### Bước 4 — Đẩy lên GitHub

Upload đè 4 file: `index.html`, `manifest.json`, `sw.js`, `README.md`.
Chờ GitHub Pages build khoảng 1 phút.

### Bước 5 — Cài trên điện thoại

Mở link Pages bằng **Chrome** trên Android → menu ⋮ → **Cài đặt ứng dụng**.
Nếu chưa thấy: mở ⋮ › Cài đặt › Cài đặt trang web › Bộ nhớ › xoá dữ liệu, rồi tải lại.

---

## Mỗi lần sửa code sau này

**Deploy › Manage deployments › biểu tượng bút chì › Version: New version › Deploy**

Đây là bước hay bị bỏ sót nhất. Nếu bấm nhầm *New deployment*, Google sinh URL khác, URL cũ trong `index.html` thành 404 và app chết im lặng.

---

## Các hàm chạy trong Apps Script editor

| Hàm | Việc |
|---|---|
| `initSetup()` | Cài đặt lần đầu: tạo sheet, đặt PIN và mã mời |
| `resetPin()` | Đổi PIN — sửa `SETUP_PIN` rồi chạy |
| `showInvite()` | Xem mã mời hiện tại trong log |
| `revokeAllDevices()` | Thu hồi toàn bộ token, buộc mọi người đăng nhập lại |

---

## Cấu trúc Sheet

| Tab | Cột |
|---|---|
| `Config` | officeName, lat, lon, radius |
| `CheckIns` | ts, thời gian, tên, vai trò, lat, lon, độ chính xác, khoảng cách, ghi chú |
| `Devices` | token, tên, vai trò, tạo lúc, hết hạn, lần cuối, điểm danh cuối |

PIN (dạng băm) và mã mời nằm trong **ScriptProperties**, không nằm trong Sheet. Người được chia sẻ Sheet không đọc được.

---

## Thay đổi so với v1

**Lỗi làm app không cài được**

- `manifest.json` và `sw.js` trỏ tới `diem-danh-gps.html` — file không tồn tại. `cache.addAll()` reject → service worker không bao giờ activate → Chrome không hiện nút cài đặt.
- `sw.js` trả `undefined` khi offline và không có cache → trang trắng.

**Lỗ hổng bảo mật**

- `getHistory` nhận cờ `isAdmin` **từ client**. Ai gõ `?action=getHistory&payload={"isAdmin":true}` là đọc sạch dữ liệu mọi người. Nay vai trò suy ra từ token phía máy chủ.
- `saveConfig`, `logCheckin`, `setupPin` không kiểm tra danh tính. Nay mọi hành động đều cần token hợp lệ.
- PIN truyền và lưu dạng thô, không giới hạn số lần thử. Nay băm SHA-256 kèm muối, khoá 15 phút sau 5 lần sai.
- `refreshHistory()` chèn thẳng `dist` và `accuracy` vào HTML — stored XSS. Nay escape toàn bộ.
- Tên hàm callback JSONP chèn thẳng vào chuỗi JS trả về — reflected XSS. Nay chỉ chấp nhận `[A-Za-z0-9_]`.

**Lỗi logic**

- `getConfig()` trả `hasPin:false` khi chưa lưu cấu hình văn phòng, kể cả khi PIN đã có → app tự khoá quyền quản trị vĩnh viễn, kèm thông báo sai *"Lỗi kết nối server"*. Nay PIN chỉ đặt bằng `initSetup()` trong editor, không còn đường đua này.
- Khoảng cách do client tính rồi gửi lên. Nay máy chủ tự tính lại từ lat/lon, giá trị client gửi bị bỏ qua.
- Không chống bấm trùng. Nay có cooldown 5 phút mỗi người.
- `LockService` khoá cả thao tác đọc → mọi người xếp hàng. Nay chỉ khoá thao tác ghi.
- `doPost` là code chết. Nay dùng chung bộ điều phối với `doGet`.

---

## Giới hạn còn lại — đọc kỹ

**Web app không phát hiện được GPS giả.** Cờ `isFromMockProvider` chỉ đọc được từ Android native. Bất kỳ ai bật Developer Options và cài app giả GPS đều điểm danh được từ nhà. Máy chủ tính lại khoảng cách nên không sửa được từ DevTools, nhưng toạ độ giả vẫn qua.

Muốn chặn thật, cần thêm một tín hiệu vật lý tại chỗ:

- **BSSID của Wi-Fi văn phòng** — cần app native.
- **QR động đổi mã mỗi 30 giây** trên màn hình ở văn phòng — chạy được trên web, hiệu quả cao, rẻ nhất.
- **Beacon BLE** — cần app native.

Với vài người tin nhau thì mức hiện tại là đủ. Nếu dữ liệu này dùng để tính lương cho hàng chục người, QR động là bước tiếp theo nên làm.

**Mã mời không phải mật khẩu.** Nó chặn người lạ trên Internet, không chặn nhân viên chia mã cho nhau. Đổi mã định kỳ bằng nút trong tab Cài đặt.

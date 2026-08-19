/**
 * ĐIỂM DANH GPS — Backend Apps Script  (v2)
 * =========================================================================
 * KHÁC BIỆT SO VỚI v1 — đọc phần này trước khi deploy:
 *
 *  1. Không còn tin bất cứ thứ gì client gửi về danh tính.
 *     v1 nhận cờ `isAdmin` từ client => ai cũng đọc được toàn bộ dữ liệu.
 *     v2 suy ra vai trò từ token lưu phía server.
 *  2. PIN không còn lưu và truyền dạng thô. Lưu SHA-256 + muối trong
 *     ScriptProperties (không nằm trong Sheet, người xem Sheet không đọc được).
 *  3. Khoảng cách do SERVER tính lại từ lat/lon. Client gửi `dist` bị bỏ qua.
 *  4. Có mã mời (invite code) — người ngoài biết URL /exec vẫn không làm gì được.
 *  5. Chống dò PIN: khoá tạm sau 5 lần sai.
 *  6. Chống điểm danh trùng: cooldown giữa hai lần.
 *  7. Sanitize tên hàm callback của JSONP (v1 chèn thẳng => reflected XSS).
 *
 * -------------------------------------------------------------------------
 * CÀI ĐẶT LẦN ĐẦU (làm đúng thứ tự, chỉ một lần):
 *   B1. Dán toàn bộ file này vào Apps Script, thay thế code cũ.
 *   B2. Sửa hai hằng số SETUP_PIN và SETUP_INVITE ngay bên dưới.
 *   B3. Chọn hàm `initSetup` trong ô chọn hàm rồi bấm Run. Cấp quyền khi được hỏi.
 *       Xem Execution log để xác nhận.
 *   B4. Deploy > New deployment > Type: Web app
 *         Execute as: Me
 *         Who has access: Anyone            <-- BẮT BUỘC, không phải "Anyone with Google account"
 *   B5. Copy URL kết thúc bằng /exec, dán vào APPS_SCRIPT_URL trong index.html.
 *
 * LƯU Ý: mỗi lần sửa code phải Deploy > Manage deployments > bút chì >
 * Version: New version > Deploy. Nếu bấm "New deployment" sẽ ra URL MỚI và
 * URL cũ trong index.html thành 404 — đây là lỗi hay gặp nhất.
 * =========================================================================
 */

// ---- chỉ dùng cho initSetup(), chạy một lần trong editor ----
const SETUP_PIN    = '1234';      // ĐỔI: mã PIN 4 số của quản trị
const SETUP_INVITE = 'VANPHONG';  // ĐỔI: mã mời phát cho nhân viên

const CFG = {
  CONFIG_SHEET  : 'Config',
  CHECKIN_SHEET : 'CheckIns',
  DEVICE_SHEET  : 'Devices',
  ADMIN_TTL_H   : 12,    // phiên quản trị sống 12 giờ
  DEVICE_TTL_D  : 365,   // token nhân viên sống 1 năm
  COOLDOWN_SEC  : 300,   // 5 phút giữa hai lần điểm danh của cùng một người
  PIN_MAX_FAILS : 5,
  PIN_LOCK_MIN  : 15,
  ACC_WARN_M    : 100    // độ chính xác kém hơn mức này thì gắn cờ, không chặn
};

// =====================  ĐIỂM VÀO  =====================

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = p.callback;

  // v1 chèn thẳng `callback` vào chuỗi JS trả về => nhét được mã tuỳ ý.
  if (cb && !/^[A-Za-z0-9_]{1,64}$/.test(cb)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'callback không hợp lệ' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let payload = {};
  try { payload = p.payload ? JSON.parse(p.payload) : {}; } catch (err) { payload = {}; }

  const result = handle(p.action || 'ping', payload);

  if (cb) {
    return ContentService.createTextOutput(cb + '(' + JSON.stringify(result) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'JSON hỏng' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const result = handle(body.action, body.payload || {});
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Bộ điều phối dùng chung cho cả GET và POST. */
function handle(action, payload) {
  // Hành động chỉ đọc thì không cần khoá — v1 khoá cả read làm mọi request xếp hàng.
  const WRITES = { join: 1, adminLogin: 1, saveConfig: 1, checkin: 1, rotateInvite: 1, logout: 1 };
  const needLock = !!WRITES[action];
  let lock = null;

  if (needLock) {
    lock = LockService.getScriptLock();
    try { lock.waitLock(20000); }
    catch (err) { return { ok: false, error: 'Máy chủ đang bận, thử lại sau vài giây' }; }
  }

  try {
    switch (action) {
      case 'ping'        : return { ok: true, version: 2, hasPin: !!prop('pinHash') };
      case 'bootstrap'   : return apiBootstrap();
      case 'join'        : return apiJoin(payload);
      case 'adminLogin'  : return apiAdminLogin(payload);
      case 'me'          : return apiMe(payload);
      case 'getConfig'   : return apiGetConfig(payload);
      case 'saveConfig'  : return apiSaveConfig(payload);
      case 'checkin'     : return apiCheckin(payload);
      case 'history'     : return apiHistory(payload);
      case 'getInvite'   : return apiGetInvite(payload);
      case 'rotateInvite': return apiRotateInvite(payload);
      case 'logout'      : return apiLogout(payload);
      default            : return { ok: false, error: 'Hành động không tồn tại: ' + action };
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) {} }
  }
}

// =====================  TIỆN ÍCH  =====================

function props() { return PropertiesService.getScriptProperties(); }
function prop(k) { return props().getProperty(k); }
function setProp(k, v) { props().setProperty(k, String(v)); }

function sha256(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
  }
  return out;
}

function randomToken() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

/** So sánh chuỗi không phụ thuộc thời gian, tránh rò rỉ qua độ trễ. */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function norm(s) {
  return String(s == null ? '' : s).trim();
}

/** Khoảng cách haversine, mét. Bản duy nhất được tin — client tính chỉ để hiển thị. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getSheet(name) {
  let s = ss().getSheetByName(name);
  if (!s) { setupSheets(); s = ss().getSheetByName(name); }
  return s;
}

function setupSheets() {
  const book = ss();
  if (!book.getSheetByName(CFG.CONFIG_SHEET)) {
    book.insertSheet(CFG.CONFIG_SHEET).appendRow(['officeName', 'lat', 'lon', 'radius']);
  }
  if (!book.getSheetByName(CFG.CHECKIN_SHEET)) {
    book.insertSheet(CFG.CHECKIN_SHEET)
        .appendRow(['ts', 'thời gian', 'tên', 'vai trò', 'lat', 'lon', 'độ chính xác (m)', 'khoảng cách (m)', 'ghi chú']);
  }
  if (!book.getSheetByName(CFG.DEVICE_SHEET)) {
    book.insertSheet(CFG.DEVICE_SHEET)
        .appendRow(['token', 'tên', 'vai trò', 'tạo lúc', 'hết hạn', 'lần cuối', 'điểm danh cuối']);
  }
}

// =====================  TOKEN  =====================

function deviceRows() {
  const sh = getSheet(CFG.DEVICE_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return { sheet: sh, rows: [] };
  return { sheet: sh, rows: sh.getRange(2, 1, last - 1, 7).getValues() };
}

/**
 * Đổi token thành danh tính. Trả null nếu không có / hết hạn.
 * Đây là nơi DUY NHẤT quyết định vai trò. Client không có tiếng nói.
 */
function auth(token) {
  token = norm(token);
  if (!token) return null;
  const d = deviceRows();
  for (let i = 0; i < d.rows.length; i++) {
    if (safeEqual(d.rows[i][0], token)) {
      const exp = Number(d.rows[i][4]);
      if (exp && Date.now() > exp) return null;
      // cập nhật "lần cuối" — best effort, hỏng cũng không sao
      try { d.sheet.getRange(i + 2, 6).setValue(new Date()); } catch (e) {}
      return {
        row : i + 2,
        name: String(d.rows[i][1]),
        role: String(d.rows[i][2]),
        lastCheckin: Number(d.rows[i][6]) || 0
      };
    }
  }
  return null;
}

function requireAuth(payload) {
  const who = auth(payload && payload.token);
  if (!who) throw new Error('AUTH');   // frontend bắt chuỗi này để bắt đăng nhập lại
  return who;
}

function requireAdmin(payload) {
  const who = requireAuth(payload);
  if (who.role !== 'admin') throw new Error('Không đủ quyền');
  return who;
}

function issueToken(name, role) {
  const sh = getSheet(CFG.DEVICE_SHEET);
  const token = randomToken();
  const ttl = role === 'admin' ? CFG.ADMIN_TTL_H * 3600e3 : CFG.DEVICE_TTL_D * 86400e3;
  sh.appendRow([token, name, role, new Date(), Date.now() + ttl, new Date(), 0]);
  return token;
}

// =====================  API  =====================

function apiBootstrap() {
  return {
    ok: true,
    ready: !!prop('pinHash'),
    hasConfig: !!readConfig()
  };
}

function apiJoin(payload) {
  const name = norm(payload.name);
  const invite = norm(payload.invite);
  if (!name) return { ok: false, error: 'Chưa nhập tên' };
  if (name.length > 60) return { ok: false, error: 'Tên quá dài' };

  const real = prop('invite');
  if (!real) return { ok: false, error: 'Hệ thống chưa được cài đặt. Quản trị cần chạy initSetup() một lần.' };
  if (!safeEqual(invite.toUpperCase(), String(real).toUpperCase())) {
    return { ok: false, error: 'Mã mời không đúng' };
  }
  return { ok: true, token: issueToken(name, 'employee'), name: name, role: 'employee' };
}

function apiAdminLogin(payload) {
  const pin = norm(payload.pin);

  // chống dò
  const lockUntil = Number(prop('pinLockUntil') || 0);
  if (lockUntil && Date.now() < lockUntil) {
    const mins = Math.ceil((lockUntil - Date.now()) / 60000);
    return { ok: false, error: 'Sai quá nhiều lần. Thử lại sau ' + mins + ' phút.' };
  }

  const hash = prop('pinHash'), salt = prop('salt');
  if (!hash) return { ok: false, error: 'Chưa đặt mã PIN. Quản trị cần chạy initSetup() trong Apps Script.' };

  if (!safeEqual(sha256(salt + pin), hash)) {
    const fails = Number(prop('pinFails') || 0) + 1;
    setProp('pinFails', fails);
    if (fails >= CFG.PIN_MAX_FAILS) {
      setProp('pinLockUntil', Date.now() + CFG.PIN_LOCK_MIN * 60000);
      setProp('pinFails', 0);
      return { ok: false, error: 'Sai quá nhiều lần. Khoá ' + CFG.PIN_LOCK_MIN + ' phút.' };
    }
    return { ok: false, error: 'Sai mã PIN (còn ' + (CFG.PIN_MAX_FAILS - fails) + ' lần)' };
  }

  setProp('pinFails', 0);
  setProp('pinLockUntil', 0);
  return { ok: true, token: issueToken('Quản trị', 'admin'), name: 'Quản trị', role: 'admin' };
}

function apiMe(payload) {
  const who = auth(payload.token);
  if (!who) return { ok: true, valid: false };
  return { ok: true, valid: true, name: who.name, role: who.role };
}

function readConfig() {
  const sh = getSheet(CFG.CONFIG_SHEET);
  if (sh.getLastRow() < 2) return null;
  const r = sh.getRange(2, 1, 1, 4).getValues()[0];
  if (r[0] === '' || r[1] === '' || r[2] === '') return null;
  return { name: String(r[0]), lat: Number(r[1]), lon: Number(r[2]), radius: Number(r[3]) || 80 };
}

function apiGetConfig(payload) {
  requireAuth(payload);   // toạ độ văn phòng không còn công khai
  const c = readConfig();
  return { ok: true, config: c };
}

function apiSaveConfig(payload) {
  requireAdmin(payload);
  const lat = Number(payload.lat), lon = Number(payload.lon);
  const radius = Math.round(Number(payload.radius));
  if (!isFinite(lat) || lat < -90 || lat > 90)   return { ok: false, error: 'Vĩ độ không hợp lệ' };
  if (!isFinite(lon) || lon < -180 || lon > 180) return { ok: false, error: 'Kinh độ không hợp lệ' };
  if (!isFinite(radius) || radius < 20 || radius > 5000) return { ok: false, error: 'Bán kính phải từ 20 đến 5000 m' };

  const sh = getSheet(CFG.CONFIG_SHEET);
  sh.getRange(2, 1, 1, 4).setValues([[norm(payload.name) || 'Văn phòng', lat, lon, radius]]);
  return { ok: true, config: readConfig() };
}

function apiCheckin(payload) {
  const who = requireAuth(payload);
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: 'Quản trị chưa cài đặt vị trí văn phòng' };

  const lat = Number(payload.lat), lon = Number(payload.lon);
  const acc = Number(payload.accuracy);
  if (!isFinite(lat) || !isFinite(lon)) return { ok: false, error: 'Toạ độ không hợp lệ' };

  // chống bấm liên tục
  const now = Date.now();
  if (who.lastCheckin && (now - who.lastCheckin) < CFG.COOLDOWN_SEC * 1000) {
    const left = Math.ceil((CFG.COOLDOWN_SEC * 1000 - (now - who.lastCheckin)) / 60000);
    return { ok: false, error: 'Bạn vừa điểm danh xong. Thử lại sau ' + left + ' phút.' };
  }

  // SERVER tự tính. Giá trị dist client gửi lên bị bỏ qua hoàn toàn.
  const dist = haversine(lat, lon, cfg.lat, cfg.lon);
  if (dist > cfg.radius) {
    return { ok: false, error: 'Ngoài phạm vi: cách ' + Math.round(dist) + 'm, cho phép ' + cfg.radius + 'm', dist: Math.round(dist) };
  }

  const note = (isFinite(acc) && acc > CFG.ACC_WARN_M) ? 'GPS kém (±' + Math.round(acc) + 'm)' : '';

  getSheet(CFG.CHECKIN_SHEET).appendRow([
    now, new Date(now), who.name, who.role,
    lat, lon, isFinite(acc) ? Math.round(acc) : '', Math.round(dist), note
  ]);

  try { getSheet(CFG.DEVICE_SHEET).getRange(who.row, 7).setValue(now); } catch (e) {}

  return { ok: true, ts: now, dist: Math.round(dist), note: note };
}

function apiHistory(payload) {
  const who = requireAuth(payload);          // vai trò lấy từ token, KHÔNG từ payload
  const sh = getSheet(CFG.CHECKIN_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, entries: [] };

  const data = sh.getRange(2, 1, last - 1, 9).getValues();
  let entries = data.map(r => ({
    ts: Number(r[0]) || 0,
    name: String(r[2]),
    role: String(r[3]),
    accuracy: Number(r[6]) || 0,
    dist: Number(r[7]) || 0,
    note: String(r[8] || '')
  }));

  if (who.role !== 'admin') entries = entries.filter(e => e.name === who.name);
  entries.sort((a, b) => b.ts - a.ts);
  return { ok: true, entries: entries.slice(0, 200), role: who.role };
}

function apiGetInvite(payload) {
  requireAdmin(payload);
  return { ok: true, invite: prop('invite') || '' };
}

function apiRotateInvite(payload) {
  requireAdmin(payload);
  const code = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  setProp('invite', code);
  return { ok: true, invite: code };
}

function apiLogout(payload) {
  const who = auth(payload.token);
  if (who) { try { getSheet(CFG.DEVICE_SHEET).deleteRow(who.row); } catch (e) {} }
  return { ok: true };
}

// =====================  CHẠY TRONG EDITOR  =====================

/** Chạy MỘT LẦN sau khi sửa SETUP_PIN và SETUP_INVITE ở đầu file. */
function initSetup() {
  setupSheets();
  if (!/^\d{4}$/.test(SETUP_PIN)) throw new Error('SETUP_PIN phải đúng 4 chữ số');
  if (norm(SETUP_INVITE).length < 4) throw new Error('SETUP_INVITE cần ít nhất 4 ký tự');

  const salt = Utilities.getUuid();
  setProp('salt', salt);
  setProp('pinHash', sha256(salt + SETUP_PIN));
  setProp('invite', norm(SETUP_INVITE).toUpperCase());
  setProp('pinFails', 0);
  setProp('pinLockUntil', 0);

  Logger.log('✓ Đã cài đặt xong.');
  Logger.log('  Mã PIN quản trị : ' + SETUP_PIN);
  Logger.log('  Mã mời nhân viên: ' + norm(SETUP_INVITE).toUpperCase());
  Logger.log('  Bước tiếp theo   : Deploy > New deployment > Web app > Anyone');
}

/** Đổi PIN: sửa SETUP_PIN ở đầu file rồi chạy hàm này. */
function resetPin() {
  if (!/^\d{4}$/.test(SETUP_PIN)) throw new Error('SETUP_PIN phải đúng 4 chữ số');
  const salt = Utilities.getUuid();
  setProp('salt', salt);
  setProp('pinHash', sha256(salt + SETUP_PIN));
  setProp('pinFails', 0);
  setProp('pinLockUntil', 0);
  Logger.log('✓ Đã đổi PIN thành ' + SETUP_PIN);
}

/** Xem mã mời hiện tại. */
function showInvite() {
  Logger.log('Mã mời hiện tại: ' + (prop('invite') || '(chưa có)'));
}

/** Đăng xuất toàn bộ thiết bị. Dùng khi nghi ngờ lộ token. */
function revokeAllDevices() {
  const sh = getSheet(CFG.DEVICE_SHEET);
  const last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  Logger.log('✓ Đã thu hồi toàn bộ token. Mọi người phải đăng nhập lại.');
}

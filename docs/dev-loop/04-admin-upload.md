---
status: done   # committed with "Add admin video list..." (2026-10-25) ยังไม่ deploy
base: c2aea2f
---
# 04 หลังบ้าน: รายการ 14 ชุด + อัปโหลด/เปลี่ยนวีดีโอ + ดาวน์โหลด QR

## เป้าหมาย

ลูกค้าล็อกอินแล้วจัดการวีดีโอทั้ง 14 ชุดได้เองจากมือถือหรือคอมพิวเตอร์ ตามหัวข้อ "หน้า CMS `/admin`" และ "แบบ B/C → อัปโหลดวีดีโอ (แบบ C)" ใน qr-video-cms เมื่อจบ task นี้ระบบพร้อม deploy ครั้งแรก

## ข้อมูลประกอบ

- แบบ C: รับไฟล์แบบ stream ลง `STORAGE_DIR` (`/qr-storage` บน server) ห้ามเก็บไฟล์ไว้ใน memory
- ทดสอบแล้วว่า nginx ของ Plesk รับ POST 105MB ได้ (task 01) แต่ยังไม่เคยลองผ่านแอปจริง
- ขีดขนาด: monthly ≤ 20MB, ecard ≤ 100MB, `video/mp4` เท่านั้น ต้องตรวจทั้งฝั่งเบราว์เซอร์และฝั่ง server ด้วยค่าคงที่ชุดเดียวกัน (`src/videos.js`)
- ข้อความทุกอย่างเป็นภาษาไทย ลูกค้าไม่ใช่สาย tech
- dependency ที่ใช้เพิ่มได้: `busboy` (รับ multipart แบบ stream) และ `qrcode` (สร้าง QR) ทั้งสองเป็น pure JS
- `innodb_lock_wait_timeout` = 5 วินาทีทุก connection (task 03) transaction ของ upload ต้องสั้น
- งานค้างที่รวมไว้ใน task นี้: `fmtLimit` ใช้หน่วย MB แต่ค่าจริงเป็น MiB, comment ใน `test/auth.test.js:23` (20 → 100)

## Acceptance criteria

- [ ] AC1 **หน้า `/admin`** (ต้องล็อกอิน) แสดงรายการ 14 ชุดเรียงตาม `sort_order` แต่ละแถวมี:
  - ชื่อชุด
  - สถานะ "มีวีดีโอแล้ว" / "ยังไม่มีวีดีโอ"
  - ขนาดไฟล์
  - อัปเดตล่าสุดเมื่อไหร่ (แสดงเป็นเวลาไทย Asia/Bangkok) และโดยใคร
  - ปุ่ม/ลิงก์: ดูตัวอย่าง (`/v/<slug>` แท็บใหม่), คัดลอกลิงก์, ดาวน์โหลด QR (PNG และ SVG), อัปโหลด/เปลี่ยนวีดีโอ
  - หน้าใช้งานได้ดีบนมือถือ (ไม่ต้องเลื่อนแนวนอน) ยังมีลิงก์เปลี่ยนรหัสผ่านและปุ่มออกจากระบบจาก task 03
  - ข้อความภาษาไทยทั้งหมด `no-store`
- [ ] AC2 **อัปโหลดฝั่งเบราว์เซอร์:**
  - เลือกไฟล์แล้วตรวจก่อนส่งว่าเป็น `.mp4` / `video/mp4` และขนาดไม่เกินขีดของชุดนั้น ถ้าไม่ผ่านขึ้นข้อความไทย เช่น "ไฟล์ใหญ่เกิน 20 MB" โดยไม่ส่งไฟล์
  - ส่งด้วย `XMLHttpRequest` พร้อมแถบ progress เป็น % และปุ่มยกเลิก
  - ระหว่างอัปโหลดกันกดซ้ำ
  - สำเร็จแล้วอัปเดตแถวนั้นโดยไม่ต้อง reload ล้มเหลวแล้วขึ้นข้อความไทยที่เข้าใจได้ (ไฟล์ใหญ่เกิน / ไม่ใช่ MP4 / หมดเวลาล็อกอิน / ระบบขัดข้อง)
  - JS/CSS ของหน้า admin เป็นไฟล์ static ที่มี `?v=<hash>` แบบเดียวกับ player
- [ ] AC3 **อัปโหลดฝั่ง server** `POST /api/admin/videos/:slug` (ต้องล็อกอิน + ผ่าน CSRF check เดิม):
  - slug ต้องมีจริง
  - รับไฟล์เดียวด้วย `busboy` แบบ stream ลงไฟล์ชั่วคราวใน `STORAGE_DIR/tmp/` ตั้ง `limits.fileSize` ตาม kind ห้าม buffer ทั้งไฟล์
  - เกินขนาด, ไม่ใช่ `video/mp4`, ไม่ขึ้นต้นด้วย `ftyp` box, ไม่มีไฟล์, หรือมีมากกว่า 1 ไฟล์ → ลบไฟล์ชั่วคราวแล้วตอบ JSON error ที่มี `code` + ข้อความไทย (413/415/400)
  - ผ่าน → rename ไปเป็น `videos/<slug>/<epoch>.mp4` (กฎข้อ 2) แล้วอัปเดต `r2_key`, `size_bytes`, `updated_at`, `updated_by = username` ใน transaction สั้น ๆ
  - **ลบไฟล์เก่าหลัง commit สำเร็จเท่านั้น** ถ้าลบไม่ได้ให้ log ไว้ ไม่ fail request
  - ตอบ JSON ของแถวที่อัปเดตแล้ว
- [ ] AC4 **ความทนทานของ upload:**
  - client ยกเลิกหรือหลุดกลางทาง → ไม่มีไฟล์ชั่วคราวค้าง และ DB ไม่เปลี่ยน
  - อัปโหลดชุดเดียวกันพร้อมกัน 2 ครั้ง → ผลสุดท้ายถูกต้อง: DB ชี้ไฟล์ที่มีอยู่จริง ไม่มีไฟล์กำพร้าเกิน 1 ไฟล์ และไม่ลบไฟล์ที่ DB ชี้อยู่
  - ดิสก์เต็ม (`ENOSPC`) หรือเขียนไม่ได้ → JSON error ภาษาไทย ไม่ crash
  - ตอนแอปสตาร์ต ลบไฟล์ใน `STORAGE_DIR/tmp/` ที่เก่ากว่า 1 วัน
  - ไฟล์ 100MB ใช้ memory ของ process เพิ่มขึ้นไม่มาก (stream จริง)
- [ ] AC5 **ดาวน์โหลด QR** `GET /admin/qr/:slug.png` และ `.svg` (ต้องล็อกอิน):
  - URL ใน QR = `<PUBLIC_ORIGIN หรือ origin ของ request>/v/<slug>`
  - error correction Q, PNG กว้าง 2000px, SVG ขยายได้
  - `Content-Disposition: attachment` ชื่อไฟล์อ่านรู้เรื่อง เช่น `QR-01-มกราคม.png`, `QR-ecard-Lee.png` (ใช้ `filename*` UTF-8 และมี `filename` ASCII สำรอง)
  - test ถอดรหัส PNG กลับมาต้องได้ URL ตรง (ใช้ `jsqr` + `pngjs` เป็น devDependency ได้)
- [ ] AC6 **API อ่านรายการ** `GET /api/admin/videos` → JSON ของ 14 ชุด (ใช้กับหน้า admin) ไม่มีข้อมูลภายในที่ไม่จำเป็น เช่น path เต็มบนดิสก์
- [ ] AC7 **หน้า public หลังอัปโหลด:** `/v/<slug>` แสดงวีดีโอใหม่ทันที (HTML เป็น no-cache) `/media/<key ใหม่>` ได้ 200/206 key เก่าได้ 404 หลังลบ
- [ ] AC8 **งานค้าง:** แก้ `fmtLimit` / ข้อความขนาดให้หน่วยตรงกับค่าจริง และใช้ค่าคงที่ชุดเดียวกันทั้ง CLI, server และเบราว์เซอร์ (ส่งค่าไปหน้าเว็บผ่าน HTML/JSON ไม่ hardcode ซ้ำ) แก้ comment ใน `test/auth.test.js:23`
- [ ] AC9 `npm test` ผ่านทั้งหมด ครอบคลุม AC1–AC8 รวม end-to-end: login → อัปโหลด MP4 ปลอม (ขนาดเล็ก, sparse สำหรับกรณีเกินขนาด) → `/v/<slug>` แสดงวีดีโอ → เปลี่ยนไฟล์ → ไฟล์เก่าถูกลบ test ที่ใช้ DB ถือ `acquireDbSuiteLock` ไม่ commit ไฟล์วีดีโอ
- [ ] AC10 README:
  - คู่มือสั้นภาษาไทยสำหรับลูกค้า (ล็อกอิน, อัปโหลด, ขนาดที่รับได้, ดาวน์โหลด QR, เปลี่ยนรหัสผ่าน) แยกหัวข้อให้ก็อปไปส่งลูกค้าได้
  - หัวข้อ deploy ครั้งแรก: ถ้าอัปโหลดใหญ่แล้วได้ 413 จาก nginx ให้เพิ่ม `client_max_body_size` (ถ้าทำได้ให้เฉพาะ `/api/admin/videos/`)

## นอกขอบเขต

script deploy, การ deploy จริง, ลบ/เพิ่มชุด (มี 14 ชุดคงที่), แก้ชื่อชุดผ่านหน้าเว็บ

## กฎ qr-video-cms ที่เกี่ยวข้อง

- กฎข้อ 1 (QR ชี้ `/v/<slug>`), ข้อ 2 (ชื่อไฟล์มี timestamp ลบไฟล์เก่าหลัง commit), ข้อ 5 (ตรวจขนาดและชนิด 2 ชั้น), ข้อ 7 (ไม่มี secret ใน repo)
- หัวข้อ "หน้า CMS `/admin`", "แบบ B/C → อัปโหลดวีดีโอ", "สร้าง QR Code"

## Log

### รอบ 1

- Dev: ทำครบ AC1–AC10 test 283/283 สองรอบ (~145 วินาที)
  - dependency ใหม่: `busboy@1.6.0`, `qrcode@1.5.4` และ dev: `jsqr@1.4.0`, `pngjs@7.0.0` (audit 0)
  - ไฟล์ใหม่: `src/video-files.js` (CLI กับ upload ใช้ร่วมกัน), `src/upload.js`, `src/qr.js`, `public/assets/admin.{css,js}`
  - วัด memory ตอนอัป 99 MiB: RSS เพิ่ม < 70 MiB
  - helper รอ DB lock นานขึ้นจาก 120 เป็น 900 วินาที (ไม่ได้แก้ assertion ของ QA)
  - `server.requestTimeout` ยังเป็น 300 วินาทีตามค่า default ต้องทดสอบอัปโหลดบนเน็ตช้าตอน deploy
- Lead ตัดสิน: หน่วยที่ลูกค้าเห็นเป็น "MB" (20 MB / 100 MB) แต่ขีดจริงคงเป็น MiB (ผ่อนกว่าเล็กน้อย และตรงกับที่ Windows แสดง) CLI แสดง MiB ได้ → แก้ในรอบถัดไป
- QA: **FAIL** เพิ่ม `test/qa-admin-upload.test.js` 31 test ผ่าน 29 ข้อ
  - ผ่าน: upload/replace (ล็อกแถวไว้ระหว่าง commit แล้วไฟล์เก่ายังเล่นได้), 503 busy ใน ~10 วินาที, mime/ftyp, ชื่อไฟล์หลอก 10 แบบ, ตัดกลางทาง 3 จังหวะ, อัปโหลดชุดเดียวกันพร้อมกัน 4 ครั้ง (ไม่มีไฟล์กำพร้า), 6 ชุดพร้อมกัน, CSRF/auth, QR 4 ชุด, ไม่มี path รั่ว
  - black-box อัปโหลด 50 MiB ด้วย app.js จริง sha256 ตรง และ memory ไม่โตตามขนาดไฟล์
  - (QB1) **ขนาดเท่าขีดพอดีได้ 413** เพราะ busboy ยิง `limit` เมื่อ `fileSize === limit` ส่วนเบราว์เซอร์และ CLI ยอมรับ สองชั้นจึงตัดสินไม่ตรงกัน ทางแก้: `fileSize: limit + 1` แล้วให้ `checkVideoFile` ตัดสิน
- Lead: ส่งรอบ 2 แก้ QB1 + หน่วย "MB" + U1–U5
- Review: **APPROVE** ไม่มี blocking
  - ยืนยันว่า pipeline อัปโหลด (busboy limits, ล้าง tmp ทุกทาง), ลำดับ commit, การลบไฟล์เก่า, upload ซ้อนกัน, QR และ admin.js ใช้ textContent (ไม่มี XSS) ถูกต้อง
  - non-blocking:
    - (U1) COMMIT สำเร็จแต่ connection หลุด → ลบไฟล์ที่ DB ชี้อยู่ ควรเช็ก r2_key ก่อนลบ
    - (U2) rename สำรองเขียนทับได้ ใช้ copyFile EXCL แทน
    - (U3) ถ้าไม่ได้ตั้ง PUBLIC_ORIGIN QR จะใช้ Host/proto ของ request ซึ่งอาจได้ www หรือ http
    - (U4) server.requestTimeout ~30 นาที และขึ้นข้อความ "กำลังบันทึก..." เมื่อ progress ถึง 100%
    - (U5) error หลัง commit ควรตอบ JSON
    - (U6) test lock 900 วินาที รับได้

### รอบ 2

- Dev: แก้ครบ QB1, MB, U1–U5 test 323/323 สองรอบ (~175 วินาที) `qa-admin-upload` ผ่าน 31/31 โดยไม่แก้ไฟล์
  - busboy ใช้ `limit + 1` แล้วให้ `checkVideoFile` ตัดสินขนาดเป็นที่สุดท้าย
  - หน่วยที่ลูกค้าเห็นเป็น MB ส่วน CLI ใช้ MiB
  - ถ้า commit โยน error จะอ่าน r2_key ใหม่ก่อนลบไฟล์, ใช้ copyFile EXCL แทน rename
  - production ที่ไม่ได้ตั้ง PUBLIC_ORIGIN → QR ได้หน้าเตือนภาษาไทย และหน้า /admin มีแถบเตือน
  - `requestTimeout` 30 นาที และขึ้น "กำลังบันทึก..." เมื่อถึง 100%
  - API router มี JSON error handler
  - **ผ่อนเกณฑ์ test memory ของ dev เอง** จาก < 70 MiB เป็น < ขนาดไฟล์ เพราะเคยวัดได้ +70.2 MiB จาก GC ของ V8 (ไม่โตตามขนาดไฟล์) และเตือนว่า test ข้อ 6 ของ QA (< 70 MiB) อาจ flaky ด้วยสาเหตุเดียวกัน
- QA: **PASS** test 329/329 สามรอบติด (~185 วินาที)
  - ทั้ง 3 ชั้นตัดสินขนาดเท่าขีดพอดีตรงกัน (เบราว์เซอร์, server, CLI)
  - ข้อความที่ลูกค้าเห็นไม่มี MiB เลย
  - U3: QR ไม่ถูกสร้างจาก Host ปลอม และมีแถบเตือน
  - U5: API ตอบ JSON
  - U4: requestTimeout 30 นาที และขึ้น "กำลังบันทึก..."
  - QA ปรับเกณฑ์ memory ของ test ตัวเองให้เทียบกับขนาดไฟล์ (99 MiB < 99, แบบจำกัดความเร็ว < 40)
  - เพิ่ม `test/qa-admin-upload-r2.test.js` 6 test
- Review: **APPROVE** ไม่มี blocking
  - ยืนยันแล้ว: limit+1 ไม่หลุดผ่าน, U1 ถูกต้องรวมทาง deadlock retry, requestTimeout 30 นาทีรับได้หลัง nginx, fallback 200 อาจล้าสมัยแค่กรณี DB error พร้อม upload ชนกัน
  - non-blocking:
    - (V1) mysql2 แนบ `err.sql` ที่แทนค่าแล้วกับ error ถ้า `setPassword` ล้ม bcrypt hash จะลงไปใน log ขัด AC12 ของ task 03 แก้โดย log แค่ code/message
    - (V2) เกณฑ์ test memory `< ขนาดไฟล์` อ่อนไป เสนอวัด 2 ขนาดแล้ว assert ส่วนต่าง
    - (V3) ปุ่ม QR ที่มี `download` เมื่อไม่ได้ตั้ง PUBLIC_ORIGIN จะเห็น "ดาวน์โหลดล้มเหลว" (มีแถบเตือนครอบไว้แล้ว รับได้)
- Lead: ผ่านเกณฑ์แล้ว แต่ส่งรอบ 3 แก้ V1 (hash อาจหลุดลง log) และ V2 ก่อน commit การเปลี่ยนแปลงเล็ก จึงให้ Reviewer ตรวจและ Lead รัน test เองแทน QA เต็มรอบ

### รอบ 3

- Dev: แก้ V1 และ V2 test 331/331 สองรอบ
  - เพิ่ม `src/log-error.js` (`describeError`) ใช้ log บรรทัดเดียวแทน error object ทั้งก้อนใน handler กลางและ handler ของ API จึงไม่มี `sql`/hash หลุด (มี test ที่ทำให้ UPDATE password_hash ล้มจริง)
  - test memory วัด arrayBuffers หลัง gc() แล้วเทียบ 20 MiB กับ 99 MiB ได้ live peak +0.2 / +0.9 MiB
- Review: **APPROVE** ไม่มี blocking
  - ไม่มีจุดไหน log error object ของ mysql2 ทั้งก้อนแล้ว และ regex สำหรับ bcrypt ถูกต้อง
  - test memory จับการ buffer ทั้งไฟล์และการ buffer ครึ่งไฟล์ได้
  - non-blocking → ย้ายไปไว้ใน "ค้างไว้"
- Lead (2026-10-25): **รัน migration 001–003 บน DB production (MariaDB 10.11) แล้ว** ตามที่ผู้ใช้อนุมัติ ผ่านครั้งแรก รันซ้ำขึ้น "already up to date" ข้อมูล 14 ชุดครบ ตอน deploy จึงไม่ต้อง migrate อีก (รันซ้ำได้ ไม่มีผล) server ตั้ง timezone เป็น SYSTEM (+07) ซึ่งแอปบังคับ `+00:00` ทุก connection อยู่แล้ว ผู้ใช้จะสร้างบัญชีลูกค้า `wjasmin.admin` เองใน terminal

## ค้างไว้

- (Review รอบ 3 → ก่อน deploy) เพิ่ม handler `unhandledRejection` / `uncaughtException` ใน app.js ที่ log ด้วย `describeError` แล้วค่อย exit
- (Review รอบ 3 → README/checklist deploy) ห้ามตั้ง env `DEBUG` บน Plesk เพราะ express-mysql-session จะพิมพ์ error object ทั้งก้อน
- (จาก task 03, deploy) ถ้าต้องเพิ่ม `client_max_body_size` ให้จำกัดเฉพาะ location ของ upload ถ้าทำได้

---
status: done   # committed 2c995ad (2026-10-25) ยังไม่ deploy
base: dc90db96f274eac1ecf2daa77bec6f73f55fc088
---
# 02 หน้าดูวีดีโอ `/v/<slug>` + `/media/*` + คำสั่งตั้งไฟล์วีดีโอ

## เป้าหมาย

คนสแกน QR แล้วได้หน้าดูวีดีโอจากแอปจริง ใช้กับทั้ง 14 ชุด หน้าตาและการเล่นเหมือนหน้า e-card ชั่วคราวที่ลูกค้าเห็นและอนุมัติแล้ว วีดีโอเสิร์ฟจาก `STORAGE_DIR` (นอก Document Root) แบบเลื่อนได้ (Range) และมีคำสั่ง CLI สำหรับผูกไฟล์วีดีโอกับชุด เพื่อย้าย e-card Lee เข้าระบบตอน deploy (หลังบ้านสำหรับอัปโหลดเป็น task ถัดไป)

## ข้อมูลประกอบ

- **ต้นแบบหน้า** (ลูกค้าอนุมัติแล้ว): `C:\Users\werapat\AppData\Local\Temp\claude\--wsl-localhost-Ubuntu-home-lamood-fastwork-loxley-calendar-qr\5c10a88b-8a2d-4da3-8f7f-e2c7e9ed2be4\scratchpad\interim-ecard\index.html` (`__VIDEO__` = path ของวีดีโอ) หน้าที่ใช้งานอยู่จริงคือ `https://wjasmin.site/v/ecard-lee/` สเปกเต็มอยู่ใน qr-video-cms หัวข้อ "หน้า public `/v/<slug>`"
- **QR ที่ส่งลูกค้าไปแล้ว:** `https://wjasmin.site/v/ecard-lee/` (มี `/` ต่อท้าย) ต้องได้หน้าเดียวกันทั้งแบบมีและไม่มี `/`
- คอลัมน์ `r2_key` ในแบบ C เก็บ path สัมพัทธ์จาก `STORAGE_DIR` เช่น `videos/ecard-lee/1792832980.mp4` (กฎข้อ 2: ชื่อไฟล์มี timestamp)
- ขีดจำกัดขนาด: monthly ≤ 20MB, ecard ≤ 100MB, `video/mp4` เท่านั้น
- บน production `public/v/ecard-lee/` ยังเป็นหน้า static ที่ nginx เสิร์ฟเองก่อนถึงแอป การสลับมาใช้แอปเป็นงานตอน deploy ไม่ใช่งานใน task นี้

## Acceptance criteria

- [ ] AC1 `GET /v/:slug` และ `GET /v/:slug/` → 200 HTML สำหรับ slug ที่มีในตาราง `videos` ทั้งแบบมีและไม่มี `/` ต่อท้าย ไม่ redirect slug ต้องตรงรูปแบบ `^[a-z0-9-]{1,40}$` slug ที่ไม่ตรงรูปแบบหรือไม่มีในตารางได้หน้า 404 ภาษาไทย (ใช้หน้าเดิมจาก task 01)
- [ ] AC2 หน้าที่มีวีดีโอ: HTML, CSS และ JS ให้ผลเหมือนต้นแบบ
  - `<title>` = title ของชุด
  - `<video playsinline preload="auto">` ไม่มี `loop` และไม่มี controls
  - พยายามเล่นพร้อมเสียงก่อน ถ้า `play()` ถูกปฏิเสธ ให้ปิดเสียงแล้วเล่น และแสดงข้อความ "แตะหน้าจอหนึ่งครั้งเพื่อฟังเสียงบรรยาย"
  - แตะครั้งแรกที่ใดก็ได้ → เริ่มใหม่จากต้นพร้อมเสียง
  - แตะที่วีดีโอ → สลับเสียง พร้อมไอคอนลำโพง SVG ที่ขึ้นแล้วจางหาย (`role="status"` + `aria-label` ภาษาไทย)
  - เล่นจบ → แสดงปุ่ม "ดูอีกครั้ง"
  - CSS/JS ใช้ร่วมกันได้ทุก slug (ไฟล์ static ใน `public/` เช่น `/assets/player.css`, `/assets/player.js` หรือ inline ก็ได้) ไม่โหลดอะไรจากภายนอก หน้าทั้งหน้าไม่รวมวีดีโอไม่เกิน ~20KB
  - `src` ของวีดีโอคือ `/media/<r2_key>`
- [ ] AC3 หน้าที่ยังไม่มีวีดีโอ (`r2_key` เป็น NULL หรือไม่พบไฟล์บนดิสก์): 200 พื้นดำตัวทอง แสดง title และข้อความ monthly "วีดีโอเดือนนี้จะเปิดให้ชมเร็ว ๆ นี้" / ecard "e-card นี้จะเปิดให้ชมเร็ว ๆ นี้" ไม่มี `<video>`
- [ ] AC4 HTML ของ `/v/*` ตั้ง `Cache-Control: no-cache` (เปลี่ยนวีดีโอแล้วเห็นทันที) มี `<meta name="robots" content="noindex">` escape title ทุกจุด
- [ ] AC5 `GET`/`HEAD /media/<path>`:
  - เสิร์ฟเฉพาะ path ที่ตรงรูปแบบ `^videos/[a-z0-9-]{1,40}/[0-9]{9,13}\.mp4$` และไฟล์อยู่ใต้ `STORAGE_DIR` จริงหลัง resolve
  - `Content-Type: video/mp4`, `Accept-Ranges: bytes`, `Cache-Control: public, max-age=31536000, immutable`
  - `Range: bytes=0-99` → 206 + `Content-Range: bytes 0-99/<size>`
  - range เกินขนาดไฟล์ → 416
  - path ไม่ตรงรูปแบบ, traversal (`/media/../app.js`, `%2e%2e`, `%2f`), ไม่มีไฟล์ หรือเป็นโฟลเดอร์ → 404 โดยไม่บอก path จริง
  - ใช้ `res.sendFile`/`send` แบบ stream ไม่โหลดทั้งไฟล์เข้า memory
- [ ] AC6 config: แอปไม่ยอมสตาร์ต (error บอกชื่อตัวแปร) ถ้า `STORAGE_DIR` หลัง resolve อยู่ใต้ `public/` หรือเท่ากับ `public/` หรือ app root เอง (Review task 01 ข้อ R6)
- [ ] AC7 `npm run video:set -- <slug> <path-สัมพัทธ์ใน-STORAGE_DIR>` (CLI ใช้แค่ `DB_*` + `STORAGE_DIR` ไม่โหลดไฟล์ env เอง):
  - ตรวจว่า slug มีจริง, path ตรงรูปแบบใน AC5, ไฟล์มีอยู่, ขึ้นต้นด้วย box `ftyp` (เป็น MP4) และขนาดไม่เกินขีดของ kind
  - อัปเดต `r2_key`, `size_bytes`, `updated_at`, `updated_by` (ค่า `cli`)
  - ไม่ลบไฟล์เก่า แต่พิมพ์ path ของไฟล์เก่าให้รู้
  - ผิดเงื่อนไขข้อใดให้ exit 1 พร้อมข้อความภาษาไทยหรืออังกฤษที่บอกสาเหตุ ไม่แตะ DB
  - มี `video:set:dev` ที่ใช้ `.env.dev` เหมือน `migrate:dev`
- [ ] AC8 (Review task 01 ค้างไว้) listener `error` ใน `app.js` สั่ง exit เฉพาะตอนที่ `!server.listening` หลัง listen สำเร็จแล้วให้แค่ log และเพิ่ม test ที่โหลด `app.js` ด้วย `require()` ใต้ Passenger ปลอม (กันกรณีมี top-level await)
- [ ] AC9 `npm test` ผ่านทั้งหมด ครอบคลุม AC1–AC8 test ที่ต้องใช้ไฟล์วีดีโอสร้าง MP4 ปลอมเล็ก ๆ (มี `ftyp`) ใน `STORAGE_DIR` ชั่วคราว ไม่ commit ไฟล์วีดีโอ
- [ ] AC10 README: วิธีใช้ `video:set` และขั้นตอนย้าย e-card Lee ตอน deploy ครั้งแรก (อัปไฟล์ผ่าน FTP ไปที่ `/qr-storage/videos/ecard-lee/<epoch>.mp4` → รัน `npm run video:set -- ecard-lee videos/ecard-lee/<epoch>.mp4` ใน Plesk → ลบ `public/v/ecard-lee/`)

## นอกขอบเขต

login, หลังบ้าน, upload ผ่านเว็บ, QR, script deploy และการ deploy จริง

## กฎ qr-video-cms ที่เกี่ยวข้อง

- กฎข้อ 1: QR ชี้ไปที่ `/v/<slug>` slug เปลี่ยนไม่ได้
- กฎข้อ 2: ชื่อไฟล์มี timestamp
- กฎข้อ 3: `/media/*` ต้องรองรับ Range (206 + Content-Range) ตั้ง Cache-Control immutable
- กฎข้อ 5: ตรวจขนาดและชนิดไฟล์ (ใน task นี้ตรวจผ่าน CLI)
- หน้า public: สเปกเต็มตามหัวข้อ "หน้า public `/v/<slug>`"

## Log

### รอบ 1

- Dev: ทำครบ AC1–AC10 test 132/132 (ของเดิม 50 ยังผ่านครบ) ไม่เพิ่ม dependency ไฟล์ใหม่ `src/videos.js`, `src/video-routes.js`, `src/video-set.js`, `public/assets/player.{css,js}` หน้าเว็บรวมราว 5.4KB ทำเกิน AC 1 ข้อ: `video:set` บังคับให้ path อยู่ในโฟลเดอร์ของ slug ที่ระบุ (Lead รับไว้ เพราะกันผูกไฟล์ผิดชุด) test ที่ใช้ DB ถือ `GET_LOCK` กันรันชนกัน
- QA: (รอผล)
- Review: **APPROVE** ไม่มี blocking logic ของ player ตรงกับต้นแบบทุกบรรทัด ลำดับการตรวจของ `/media` ถูกต้อง มี non-blocking 6 ข้อ: (N1) mysql2 ไม่ได้ตั้ง `timezone` แต่เขียน `UTC_TIMESTAMP()` ทำให้อ่านกลับแล้วเวลาอาจคลาด 7 ชม. (N2) cache ของ player.js/css (N3) response 416 ติด Cache-Control immutable (N4) ขีดขนาดเป็น MiB ต้องใช้ค่าคงที่ชุดเดียวกับหน้าอัปโหลด (N5) production ไม่ควรยอมให้ STORAGE_DIR อยู่ใต้ app root เพราะ mirror `--delete` จะลบวีดีโอ (N6) TOCTOU ของ CLI รับได้
- QA: **PASS** ผ่าน AC1–AC10 จากการรันจริง:
  - ลองเจาะ `/media` 34 path ได้ 404 ทั้งหมด วีดีโอ 100MB ส่งแบบ stream (memory ของ server เพิ่มแค่ ~35MB)
  - player ตรงกับต้นแบบ หน้ารวม 5.4KB (2.2KB เมื่อ gzip) `/v/ecard-lee?fbclid=...` (ลิงก์ที่ LINE/FB เติมให้) ยังได้หน้าเดิม
  - เพิ่ม `test/qa-video.test.js` (5 pass + 5 todo)
  - บั๊กเล็ก 4 ข้อ: (Q1) `/v/%2e%2e` แบบดิบได้ 301 จาก express.static แทน 404 (Q2) response 416 ติด Cache-Control immutable ตรงกับ N3 (Q3) ตัวตรวจ STORAGE_DIR ถูกหลบได้ด้วย symlink (Q4) ข้อความ "20.0MB เกิน 20.0MB" อ่านแล้วงง
  - ทดสอบไม่ได้: มือถือจริง, Plesk nginx
- Lead: แก้ hash ของ base ในไฟล์นี้ (เดิมผมเติม hash เต็มผิดเอง)
- Lead: ผ่านเกณฑ์แล้ว แต่ส่งรอบ 2 แก้ N1, N2, N3/Q2, N5, Q1, Q3, Q4 เพราะแก้ง่ายและกันปัญหาบน production ข้ามไว้: N4 (จดไว้ในค้างไว้ให้ task upload) และ N6

### รอบ 2

- Dev: แก้ครบ 7 ข้อ ได้แก่ `timezone: 'Z'`, `?v=<sha256>` ของ player assets, 416 ไม่มี immutable/video/mp4, production ห้ามมี STORAGE_DIR ใต้ app root, `redirect: false`, ตัวตรวจ STORAGE_DIR ตาม realpath และข้อความขนาดไฟล์เป็น byte test 156/156 (todo 0) test todo 5 ข้อของ QA กลายเป็น test ปกติแล้วโดยไม่แก้ assertion
- QA: **PASS** test 156/156 สองรอบ บั๊ก Q1–Q4 หายครบ และยืนยัน N1/N2/N3/N5 แล้ว:
  - `updated_at` อ่านกลับเป็น UTC ตรงทุก TZ ที่ลอง (Bangkok, UTC, New York)
  - `?v=` ตรงกับ sha256 ของไฟล์
  - ลองตัวตรวจ STORAGE_DIR 12 กรณีรวม symlink แล้วถูกต้องทั้ง production และ dev
  - test ของ QA เอาแค่ flag todo ออก assertion เหมือนเดิม
- Review: **APPROVE** ไม่มี blocking `realpathLoose` ไม่ throw ตอนสตาร์ตบน Plesk การลบ header ของ 416 ไม่กระทบ 200/206 มี non-blocking 4 ข้อ ย้ายไปไว้ใน "ค้างไว้"
- Lead: รัน `npm test` เองได้ 156/156 สแกนแล้วไม่มีค่าลับหรือไฟล์วีดีโอ → **ผ่านเกณฑ์ รอผู้ใช้อนุมัติ commit**

## ค้างไว้

- (Review รอบ 2, ก่อนสร้างตาราง `admin_users` ใน task login) ตั้ง `SET time_zone = '+00:00'` ทุก connection (event `connection` ของ pool + connection ของ migrate) ให้ `NOW()` / `CURRENT_TIMESTAMP` เป็น UTC ตรงกับ `timezone: 'Z'`
- (Review รอบ 2) ถ้าไม่มีไฟล์ `public/assets/player.*` `createApp` จะ throw แล้วแอปล้มทั้งตัว ควรให้ทำงานต่อแบบลดระดับ (log + URL ไม่มี `?v=`)
- (Review รอบ 2) `fmtLimit` ใช้หน่วย "MB" แต่จริง ๆ คือ MiB ทำพร้อม N4 ใน task upload
- (Review รอบ 2) `test/config.test.js:225` ย้ายการลบโฟลเดอร์ tmp ไปไว้ใน `finally`
- **Checklist deploy ครั้งแรก (เพิ่ม):** ยืนยันว่าหน้า error ของ Passenger ตอนแอปสตาร์ตไม่ขึ้น**ไม่แสดง env vars** (มี `DB_PASSWORD`) เมื่อ Application Mode = production

- (N4 → task upload) ขีดขนาดเป็น MiB หน้าอัปโหลดต้อง import ค่าคงที่จาก `src/videos.js` ชุดเดียวกันทั้งฝั่งเบราว์เซอร์และ server
- ยังไม่รู้ว่า "Run Node.js commands" ของ Plesk ส่ง argument หลัง `--` ให้ script ได้ไหม ต้องเช็กตอน deploy

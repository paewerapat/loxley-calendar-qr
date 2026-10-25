---
status: done   # committed with "Add password login..." (2026-10-25) ยังไม่ deploy
base: 2c995ad
---
# 03 Login ด้วยรหัสผ่าน + session + เปลี่ยนรหัสผ่าน

## เป้าหมาย

ล็อกอินเข้าหลังบ้านด้วย username + รหัสผ่าน ตามหัวข้อ "Login ด้วยรหัสผ่าน" ใน qr-video-cms ปกป้องทุก route `/admin*` และ `/api/admin/*` เป็นฐานให้ task 04 (รายการ 14 ชุด + อัปโหลด) และ deploy ครั้งแรกพร้อมกัน

## ข้อมูลประกอบ

- ผู้ใช้มี 2 คน (ลูกค้า + เรา) ไม่มีหน้าสมัครสมาชิก
- production เป็น https ผ่าน nginx ของ Plesk → Passenger (`trust proxy` = 1 อยู่แล้ว) ไม่มี SSH ทุกคำสั่งรันผ่าน "Run Node.js commands" ซึ่งตั้ง env รายคำสั่งไม่ได้ และ argument อาจถูกเก็บใน history ของ panel
- ใช้ dependency เพิ่มได้ 3 ตัว: `express-session`, `express-mysql-session`, `bcryptjs` (ทั้งหมดเป็น pure JS)
- งานค้างจาก task 02 ที่รวมไว้ใน task นี้ด้วย: session time_zone, ทำงานต่อแบบลดระดับเมื่อไม่มีไฟล์ assets, ลบโฟลเดอร์ tmp ใน test

## Acceptance criteria

- [ ] AC1 **UTC ทุก connection:** ทุก connection (pool และ migrate) รัน `SET time_zone = '+00:00'` ให้ `NOW()` / `CURRENT_TIMESTAMP` / DEFAULT เป็น UTC ตรงกับ `timezone: 'Z'` มี test ที่ยืนยันกับ DB จริง
- [ ] AC2 **Migration ใหม่** (idempotent, ใช้ได้ทั้ง MariaDB 10.11 และ MySQL 8.4, `utf8mb4_unicode_ci`):
  - `admin_users (id, username UNIQUE, password_hash, created_at, last_login_at NULL, password_changed_at)`
  - ตาราง throttle สำหรับนับครั้งที่ใส่รหัสผิด (คีย์ = IP + username ตัวพิมพ์เล็ก)
  - ตาราง sessions ตาม schema ที่ `express-mysql-session` ต้องการ (`createDatabaseTable: false` ให้ migration เป็นคนสร้าง)
- [ ] AC3 **Config:**
  - `SESSION_SECRET` บังคับ ยาว ≥ 32 ตัวอักษร
  - `COOKIE_SECURE` (`true`/`false` ค่าเริ่มต้น `true` เมื่อ `NODE_ENV=production`)
  - error บอกชื่อตัวแปร ไม่พิมพ์ค่า
  - CLI (migrate, video:set, admin:*) ไม่ต้องใช้ `SESSION_SECRET`
- [ ] AC4 **Session:**
  - `express-session` + `express-mysql-session` บน pool เดิม
  - cookie ชื่อ `lx.sid` เป็น `httpOnly`, `sameSite=lax`, `secure` ตาม `COOKIE_SECURE`, `path=/`
  - หมดอายุเมื่อไม่ใช้งาน 8 ชั่วโมง (`rolling`)
  - ไม่สร้าง session ให้คนที่ไม่ได้ล็อกอิน (`saveUninitialized: false`)
  - restart แอปแล้ว session ยังอยู่
- [ ] AC5 **หน้า login** `GET /admin/login`:
  - ฟอร์มภาษาไทย พื้นดำตัวทอง `no-store` + `noindex`
  - ถ้าล็อกอินอยู่แล้ว redirect ไป `/admin`
  - `POST /admin/login`:
    - สำเร็จ → `session.regenerate` บันทึก user id + เวลา แล้วอัปเดต `last_login_at` และ redirect ไป `/admin`
    - ผิด → 401 พร้อมข้อความเดียวกันทุกกรณี "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" (username ไม่มี, รหัสผิด, ช่องว่าง)
    - username ไม่มีจริงก็ต้องใช้เวลาใกล้กับกรณีรหัสผิด (เทียบกับ dummy hash)
  - username ไม่สนตัวพิมพ์เล็กใหญ่ ตัดช่องว่างหน้าหลัง
- [ ] AC6 **กันเดารหัส:**
  - ผิด 5 ครั้งภายใน 15 นาที ต่อ IP + username → ล็อก 15 นาที
  - ระหว่างล็อก ใส่รหัสถูกก็เข้าไม่ได้ ได้ 429 + ข้อความ "ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่" (ใช้กับทุก username ไม่บอกว่ามีจริงไหม)
  - ล็อกอินสำเร็จแล้วล้างตัวนับของคีย์นั้น
  - เก็บใน DB จึงอยู่รอดหลัง restart และใช้ได้เมื่อ Passenger รันหลาย process
  - log `[auth] login failed ip=<req.ip>` (ไม่ log รหัสผ่าน) เพื่อยืนยันบน production ว่า `trust proxy` ได้ IP จริง
- [ ] AC7 **ป้องกัน route:**
  - ทุก `/admin*` ยกเว้น `/admin/login` → ไม่มี session redirect 302 ไป `/admin/login`
  - ทุก `/api/admin/*` → ไม่มี session ตอบ 401 JSON `{"error":"unauthorized"}`
  - session ของ user ที่ถูกลบ หรือออกก่อน `password_changed_at` → ถือว่าไม่ได้ล็อกอิน
  - `GET /admin` (ล็อกอินแล้ว): หน้า placeholder ภาษาไทย แสดง username, ลิงก์เปลี่ยนรหัสผ่าน และปุ่มออกจากระบบ (รายการ 14 ชุดเป็น task 04) `no-store`
- [ ] AC8 **CSRF:**
  - ทุก POST/PUT/PATCH/DELETE ใต้ `/admin` และ `/api/admin` ต้องมี `Origin` ตรงกับ host ของ request (`req.protocol` + `req.get('host')` หลัง trust proxy)
  - ถ้าไม่มี `Origin` ให้ดู `Referer` ถ้าไม่มีทั้งคู่หรือไม่ตรง → 403
  - รวม `POST /admin/login` ด้วย
- [ ] AC9 **ออกจากระบบ** `POST /admin/logout` → ทำลาย session, ล้าง cookie แล้ว redirect ไป `/admin/login` หลังออกแล้ว cookie เดิมใช้ไม่ได้
- [ ] AC10 **เปลี่ยนรหัสผ่าน** `GET/POST /admin/password`:
  - กรอกรหัสเดิม + รหัสใหม่ + ยืนยัน
  - รหัสใหม่ยาว ≥ 10 ตัว, ต่างจากรหัสเดิม, ช่องยืนยันตรงกัน
  - ข้อความผิดพลาดเป็นภาษาไทย
  - สำเร็จ → อัปเดต hash + `password_changed_at` แล้ว regenerate session ปัจจุบันให้ยังใช้งานต่อได้ session อื่นของ user เดียวกันหลุดตาม AC7
  - รหัสเดิมผิดนับเข้า throttle ด้วย
- [ ] AC11 **CLI ผู้ใช้** (ใช้แค่ `DB_*` ไม่รับรหัสผ่านทาง argument หรือ env):
  - `npm run admin:create -- <username>` สร้าง user พร้อมรหัสสุ่มที่แข็งแรง (≥ 16 ตัว จาก `crypto`) พิมพ์รหัสออกครั้งเดียว ถ้า username ซ้ำ exit 1
  - `npm run admin:reset-password -- <username>` สุ่มรหัสใหม่ พิมพ์ครั้งเดียว และอัปเดต `password_changed_at` (session เก่าหลุดหมด)
  - `npm run admin:list` แสดง username, created_at, last_login_at (ไม่แสดง hash)
  - มีตัว `:dev` ของทั้ง 3 คำสั่งที่ใช้ `.env.dev`
  - username ต้องตรงรูปแบบ `^[a-z0-9._-]{3,32}$`
- [ ] AC12 **hash:** `bcryptjs` cost 12 ไม่ log รหัสผ่านหรือ hash ที่ไหนเลย
- [ ] AC13 **งานค้างจาก task 02:**
  - ถ้าไม่มี `public/assets/player.*` แอปยังสตาร์ตได้ แค่ log `[assets] missing ...` (ไม่พิมพ์ path เต็ม) แล้วใช้ URL ไม่มี `?v=`
  - `test/config.test.js` ลบโฟลเดอร์ tmp ใน `finally`
- [ ] AC14 `npm test` ผ่านทั้งหมด ครอบคลุม AC1–AC13 รวม end-to-end login → `/admin` → logout ด้วย DB จริงและ cookie จริง test ที่ใช้ DB ถือ `acquireDbSuiteLock`
- [ ] AC15 README:
  - env ใหม่ (`SESSION_SECRET`, `COOKIE_SECURE`) วิธีสร้าง secret
  - วิธีสร้าง user ตอน deploy (`admin:create` ใน Plesk) และวิธี reset รหัสผ่านเมื่อลูกค้าลืม

## นอกขอบเขต

รายการ 14 ชุดในหลังบ้าน, อัปโหลด, QR, deploy (task 04 และขั้น deploy)

## กฎ qr-video-cms ที่เกี่ยวข้อง

- หัวข้อ "Login ด้วยรหัสผ่าน" ทั้งหมด
- กฎข้อ 7: ไม่เก็บ secret ใน repo
- แบบ B/C: ไม่มี native module (`bcryptjs` ไม่ใช่ `bcrypt`)

## Log

### รอบ 1

- Dev: ทำครบ AC1–AC15 test 206/206 dependency ใหม่: `express-session@1.19.0`, `express-mysql-session@3.0.3`, `bcryptjs@3.0.3` (ไม่มี native/install script)
  - เพิ่ม `overrides` ให้ express-mysql-session ใช้ `mysql2@3.24.6` ตัวเดียวกับแอป เพราะรุ่นที่ library ล็อกไว้ (3.10.2) มีช่องโหว่ระดับ high ผลคือ `npm audit` 0
  - แก้ test ของ QA 2 ไฟล์โดยเติมแค่ `SESSION_SECRET` ใน env
  - ทำเกิน AC 2 จุด: reset-password ล้าง throttle และลบแถว throttle ที่เก่ากว่า 1 วัน
  - ผิดครั้งที่ 5 ได้ 429 ทันที
  - ยังไม่ได้จำกัดความยาวรหัสผ่านสูงสุด (bcrypt ใช้แค่ 72 byte แรก)
- QA (ตัวเดิม): **ยังตรวจไม่ครบ** ทำงานหยุดกลางทาง ยืนยันได้แค่ `npm test` 206/206, dependency และ audit ไม่มีปัญหา และไฟล์ของ QA เพิ่มแค่ SESSION_SECRET ยังไม่ยืนยันบั๊ก แต่ชี้ความเสี่ยงไว้ 2 จุด:
  - (Q1) ส่ง login ผิดพร้อมกันหลาย request อาจได้เดารหัสเกิน 5 ครั้ง เพราะตรวจล็อกก่อน bcrypt แต่บันทึกการผิดหลัง bcrypt
  - (Q2) บน production ไม่ได้ตั้ง COOKIE_SECURE แล้ว cookie จะเป็น Secure ถ้า nginx ไม่ส่ง `X-Forwarded-Proto` มา express-session จะไม่ส่ง cookie เลย ผลคือ login ไม่ติด
- Lead: เปิด QA ตัวใหม่ให้ตรวจที่เหลือ
- QA (ตัวใหม่): **FAIL** ทดสอบแบบ black-box ครบแล้ว AC1–5, 7–13 และ 15 ผ่าน (CSRF ลอง 4 route × 12 รูปแบบ ได้ 403 ทั้งหมด) บั๊กที่เจอ:
  - (Q1, กลาง, ยืนยันแล้ว) ยิงพร้อมกัน 20 ครั้งได้เดารหัส 19 ครั้ง ถ้ารหัสถูกอยู่ในชุดที่ยิงพร้อมกันก็**เข้าได้** และตัวนับถูกล้าง `/admin/password` เป็นเหมือนกัน
  - (Q2, กลาง) ยิง login 30 ครั้งพร้อมกันด้วย username สุ่ม ทำให้หน้า `/v/m01` ค้าง ~12 วินาที (bcrypt ทำงานบน main thread)
  - (Q3, เล็ก) รหัสผิดกับรหัสถูกมาพร้อมกันแล้วได้ 500 `ER_LOCK_DEADLOCK`
  - (Q4, กลาง, ความเสี่ยงตอน deploy) ถ้าไม่มี `X-Forwarded-Proto` ทุก POST ได้ 403 และไม่มี Set-Cookie แปลว่า login บน production จะพังทั้งหมด ถ้า Plesk ไม่ส่ง header นี้มา
  - (Q5, เล็ก) รหัสผ่านใช้แค่ 72 byte แรก ส่วนที่เกินถูกตัดทิ้ง
  - เพิ่ม `test/qa-login-race.test.js` ตอนนี้ fail 2/2 โดยตั้งใจ จะผ่านเมื่อแก้ Q1 และ Q3 แล้ว
- Review: **APPROVE** ไม่มี blocking ยืนยันว่า flow login, regenerate, CSRF (เทียบ Origin กับ Host ถูกต้อง), schema ของ session store, การใช้ overrides และ SET time_zone ใช้ได้ non-blocking 10 ข้อ เรียงตามความสำคัญ:
  - (R1) ถ้า Plesk ไม่ส่ง `X-Forwarded-Proto` ทุก POST จะได้ 403 และ cookie Secure จะไม่ถูกส่ง ผลคือ login ไม่ได้ทั้งระบบ เสนอให้เพิ่ม log proto/secure, เพิ่ม `PUBLIC_ORIGIN` เป็นทางสำรอง และใส่ใน checklist deploy (ตรงกับ Q2)
  - (R2) ถ้าด่านหน้าไม่เติม IP จริงต่อท้าย `X-Forwarded-For` จะปลอม IP หลบการล็อกได้ เสนอให้นับต่อ username อย่างเดียวด้วย และทดสอบตอน deploy
  - (R3) ตรวจล็อกแล้วค่อยบันทึกการผิดหลัง bcrypt ยิงพร้อมกันจึงข้ามเพดาน 5 ครั้งได้ (ตรงกับ Q1) เสนอให้บันทึกก่อนแล้วค่อยล้างเมื่อรหัสถูก
  - (R4) bcryptjs บน main thread ถูกใช้ทำ DoS ได้ เสนอให้จำกัดต่อ IP และจำกัดจำนวนที่รันพร้อมกัน
  - (R5) DELETE เก็บกวาดล้มแล้วได้ 500
  - (R6) แถวถูกลบระหว่าง INSERT IGNORE กับ SELECT FOR UPDATE ทำให้ `row` เป็น undefined
  - (R7) รหัสผ่านเกิน 72 byte ถูกตัดเงียบ ๆ
  - (R8) dummy hash สร้างตอนใช้ครั้งแรก ทำให้ request แรกช้ากว่าปกติ
  - (R9) `SET time_zone` ล้มแล้ว connection ยังถูกใช้ต่อ
  - (R10) ไม่ได้ตั้ง `NODE_ENV` แล้ว `COOKIE_SECURE` เป็น false (fail open)
- Lead: QA FAIL → รอบ 2 แก้ Q1–Q5 + R1–R10 (หลายข้อซ้ำกัน)

### รอบ 2

- Dev: แก้ครบ 9 ข้อ test 230/230 สองรอบ (~68 วินาที) `qa-login-race` ผ่าน 2/2 โดยไม่แก้ไฟล์ test สิ่งที่เปลี่ยน:
  - throttle จองสิทธิ์แบบ atomic ก่อน bcrypt, เพดานต่อ username 20 ครั้ง/15 นาที, retry เมื่อเจอ deadlock (สุดท้ายได้ 429 ไม่ใช่ 500), ย้ายการเก็บกวาดไปไว้ใน timer
  - จำกัด 10 ครั้ง/นาที/IP และ bcrypt ทำงานพร้อมกันได้ 2 งานต่อ process (เกินได้ 429 ทันที) ยิง login 30 ครั้งแล้ว `/v/m01` ยังตอบ < 2.5 วินาที
  - เพิ่ม `PUBLIC_ORIGIN` ถ้าเป็น https และไม่มี XFP แอปจะตั้ง `req.protocol` เป็น https เฉพาะ router ของ admin
  - log `proto/secure`, จำกัดรหัสผ่าน 72 byte, ฟอร์มยาวเกินได้ข้อความไทย, dummy hash คำนวณตอน mount, destroy connection ที่ SET time_zone ล้ม, `COOKIE_SECURE` เป็น true ยกเว้น development
  - **ผลข้างเคียง:** หลังตั้ง PUBLIC_ORIGIN แล้ว ฟอร์มที่ส่งจาก `www.wjasmin.site` จะได้ 403 ต้องตั้ง Plesk ให้ redirect www ไปโดเมนหลัก
- QA: **ยังตรวจไม่ครบ** สคริปต์ทดสอบถูกระบบความปลอดภัยของเครื่องมือหยุดกลางทาง ยืนยันได้แค่ `qa-login-race` ผ่าน 2/2 โดยไม่ได้แก้ไฟล์ จุดที่ต้องเช็กต่อ:
  - (Q2-1) race test ผ่านอาจเป็นเพราะตัวจำกัดใน memory (10/นาที/IP, semaphore 2) ตอบ 429 ก่อนถึงตัวจองใน DB ต้องพิสูจน์ "ไม่เกิน 5 ครั้งต่อ key" โดยปิดตัวจำกัดชั้นนอกก่อน
  - (Q2-2) เพดานต่อ username ทำให้ผู้โจมตีที่มี ~4 IP ล็อกเจ้าของบัญชีได้ (trade-off)
  - (Q2-3) semaphore 2 อาจทำให้ admin ตัวจริงได้ "busy" ระหว่างโดนโจมตี
  - (Q2-4) login ที่ฟอร์มใหญ่เกินได้ 401 ไม่ใช่ 400 (รับได้)
- Lead: ตัดสิน Q2-2 ว่ารับได้ เพราะผู้ใช้หลังบ้านมีแค่ 2 คน และกู้คืนได้ด้วย `admin:reset-password` ซึ่งปลดล็อกให้ด้วย การกันเดารหัสสำคัญกว่า ส่วน Q2-3 และ Q2-4 ก็รับได้ จะให้ QA ตัวใหม่ยืนยันผลโดยเขียนเป็น node:test ใน `test/` ไม่ใช้สคริปต์ยิงแยก
- Review: **APPROVE** ไม่มี blocking ยืนยันว่าแต่ละหน้าต่างตรวจรหัสได้ไม่เกิน 5 ครั้งต่อ key ลำดับการล็อก (ODKU + FOR UPDATE) ใช้ได้ทั้ง MariaDB และ MySQL การตั้ง PUBLIC_ORIGIN ปลอดภัย (login ผ่าน http โดนปฏิเสธเสมอ) non-blocking 5 ข้อ: (RR1) เพดาน username 20 ล็อกลูกค้าออกง่ายเกินไป เสนอ ~100 (RR2) README ยังไม่มีขั้นทดสอบปลอม XFF (RR3) `innodb_lock_wait_timeout` 50 วินาที × retry ทำให้ login อาจค้างนาน (RR4) ถ้าสร้าง dummy hash ล้ม promise ที่ reject จะถูกเก็บถาวร (RR5) login ที่ฟอร์มใหญ่เกินควรได้ 400
- Lead: เปลี่ยนการตัดสิน Q2-2 ตาม RR1 (เพดาน 100 สมดุลกว่า) ส่งรอบ 3 แก้ RR1–RR5 แล้วให้ QA ตัวใหม่ยืนยันด้วย node:test ที่ปิดตัวจำกัดใน memory

### รอบ 3

- Dev: แก้ครบ RR1–RR5 test 235/235 สองรอบ (~72 วินาที) `qa-login-race` ยังผ่านโดยไม่แก้ไฟล์ สิ่งที่เปลี่ยน:
  - เพดาน username เป็น 100 (ตั้งค่าได้)
  - ทุก connection ตั้ง `innodb_lock_wait_timeout = 5` และ retry จบภายใน 15 วินาที วัดจริงได้ 429 busy ใน ~10 วินาที
  - dummy hash ที่ล้มเหลวจะถูกคำนวณใหม่
  - login ที่ฟอร์มใหญ่เกินได้ 400 และไม่นับเข้า throttle
  - README เพิ่มขั้นตรวจ XFF ปลอมและ www redirect
  - **ข้อควรรู้สำหรับ task 04:** lock wait 5 วินาทีมีผลกับทุก query
- QA (ตัวใหม่, เขียนเป็น node:test): **PASS** เพิ่ม `test/qa-login-r3.test.js` 13 test (ปิดตัวจำกัดใน memory แล้วนับ bcrypt ด้วย spy)
  - ยิงผิดพร้อมกัน 20 ครั้ง bcrypt ทำงานแค่ 5 ครั้ง, ผิด 19 + รหัสถูกพร้อมกันได้ 429 ทั้ง 3 รอบ, `/admin/password` จำกัด ≤5 เหมือนกัน
  - ค่าเริ่มต้น 100: 4 IP × 10 ไม่ล็อก username, ลดเพดานเหลือ 10 แล้วล็อกได้ถูกต้อง
  - ลิมิตต่อ IP แสดงหน้า busy ภาษาไทยและไม่นับเข้า throttle
  - PUBLIC_ORIGIN ได้ cookie Secure และ session ใช้ได้, origin ผิด/www/http/null ได้ 403
  - 72 byte และฟอร์มใหญ่เกินได้ข้อความไทย ไม่มี 500 ใน >200 request และไม่มีรหัสผ่านใน log
  - บั๊กเล็ก: เพดาน username ล้นได้ 1 ครั้ง (11/10) เมื่อหลาย IP ยิงพร้อมกัน เพราะ SUM ไม่ล็อกแถว ผลกระทบต่ำ (ล้นได้ไม่เกินจำนวน bcrypt ที่ทำพร้อมกัน เทียบกับเพดาน 100)
  - comment ใน `test/auth.test.js:23` ยังเขียนว่า 20
- Review: **APPROVE** ไม่มี blocking และไม่มีอะไรถอยหลัง
  - `innodb_lock_wait_timeout` คุมเฉพาะ row lock ส่วน migration แบบ DDL ใช้ `lock_wait_timeout` จึงไม่โดน 5 วินาที
  - retry ไม่ busy-loop เคสแย่สุดจบใน ~10 วินาที
  - non-blocking 2 ข้อ ย้ายไปไว้ใน "ค้างไว้"
- Lead: รัน `npm test` เองได้ 248/248 (~99 วินาที), `npm audit` 0 และสแกนแล้วไม่มีค่าลับหรือไฟล์วีดีโอ → **ผ่านเกณฑ์ รอผู้ใช้อนุมัติ commit** รับบั๊กเพดาน username ล้นเล็กน้อยไว้ตามที่เป็น

## ค้างไว้

- (QA รอบ 3) แก้ comment `test/auth.test.js:23` ("20 per username" → 100) ตอนทำ task ถัดไป

- (Review รอบ 3 → task 04) ถ้ามี migration ที่ ALTER ตารางที่หน้า public ใช้ ให้ connection ของ migrate ตั้ง `SET SESSION lock_wait_timeout = 10` ก่อน จะได้ล้มเร็วแทนที่จะทำให้เว็บค้าง
- (Review รอบ 3 → task 04 / deploy) ถ้าต้องเพิ่ม `client_max_body_size 110m` ใน nginx ของ Plesk ให้จำกัดเฉพาะ location ของ upload ถ้าทำได้

- **Checklist deploy (จาก task 03):**
  - Plesk env: `SESSION_SECRET` (สุ่มใหม่ 64 hex ห้ามใช้ค่าเดียวกับ dev) และ `PUBLIC_ORIGIN=https://wjasmin.site`
  - Plesk → Hosting Settings → Preferred domain = `wjasmin.site` (redirect www → โดเมนหลัก) ไม่งั้นฟอร์มหลังบ้านที่เปิดจาก www จะได้ 403
  - รัน `npm run migrate` แล้ว `npm run admin:create -- <username>` ทั้งของลูกค้าและของเรา
  - login จริงบน production แล้วดู log `[auth] login ok ip=… proto=… secure=…` ว่า ip เป็น IP จริง จากนั้นยิง `X-Forwarded-For: 203.0.113.9` ปลอมดู ต้องไม่ขึ้นใน log

- (จาก task 02) ขีดขนาดเป็น MiB / `fmtLimit` ใช้หน่วย MB → ทำใน task 04 (upload)

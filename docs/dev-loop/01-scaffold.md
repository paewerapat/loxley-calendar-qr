---
status: in-progress
base: c57fe112a34396c5bd61c5de59f829255b1ec394
---
# 01 วางโครงแอป Express + MariaDB + seed 14 ชุด

## เป้าหมาย

โครงแอป Node.js ที่รันบน Plesk (Passenger) ได้ มีการเชื่อม DB, ระบบ migration, ตาราง `videos` พร้อมข้อมูล 14 ชุด และ test ชุดแรก เป็นฐานให้ task ต่อไป (หน้า `/v/<slug>`, `/media`, login, upload)

## ข้อมูลประกอบ

- Plesk: Application Root `/httpdocs`, Document Root `/httpdocs/public`, Startup File `app.js`, Node 24 ทั้ง server และเครื่อง dev (nvm 24.20.0)
- DB production: MariaDB 10.11 / เครื่อง dev: MySQL 8.4 ใน WSL (`loxley_dev`, `loxley_test`) **SQL ต้องรันได้ทั้งสองตัว**
- ไฟล์ env:
  - `.env.dev` → `npm run dev`
  - `.env.test` → `npm test`
  - `.env.local` = ค่าลับ production (FTP + DB production) **แอปและ test ห้ามอ่านไฟล์นี้** ใช้เฉพาะ script deploy ในอนาคต
  - production ใช้ Custom environment variables ของ Plesk
- ทดสอบ upload limit แล้ว (2026-10-24): POST 105MB ไปที่ `https://wjasmin.site/` nginx รับครบ (ได้ 500 เพราะยังไม่มีแอป ไม่ใช่ 413) ยืนยันกับแอปจริงใน task upload

## Acceptance criteria

- [ ] AC1 `package.json`: `"type": "module"`, `"engines": { "node": ">=24.20 <25" }`, scripts `start` (`node app.js`), `dev` (`node --env-file=.env.dev --watch app.js`), `test` (`node --env-file=.env.test --test`), `migrate` (`node scripts/migrate.js`) dependency runtime มีแค่ที่จำเป็นและเป็น pure JS (`express`, `mysql2`)
- [ ] AC2 `app.js` ใช้ `process.env.PORT` และ export app (หรือ factory) ให้ test สตาร์ตบนพอร์ตสุ่มได้ เรียก `listen` ที่เดียว ตั้ง `trust proxy` เป็น 1
- [ ] AC3 config อ่านจาก `process.env` ที่เดียว (`src/config.js`) ขาดตัวแปรจำเป็นแล้ว error ชัดเจนตอนสตาร์ต (บอกชื่อตัวแปร ไม่พิมพ์ค่า) `STORAGE_DIR` สัมพัทธ์ resolve เทียบกับโฟลเดอร์ของ `app.js` ไม่ใช่ cwd
- [ ] AC4 `npm run migrate` สร้างตาราง `schema_migrations` และ `videos` (ตาม Data model ใน qr-video-cms ปรับ type ให้เป็น MySQL/MariaDB, `utf8mb4` + `utf8mb4_unicode_ci` ระบุชัด) รันซ้ำได้โดยไม่ error และไม่สร้างข้อมูลซ้ำ migration เป็นไฟล์ `.sql` เรียงเลข บันทึกว่ารันไปแล้วใน `schema_migrations`
- [ ] AC5 seed 14 แถว: `m01`–`m12` (title `มกราคม 2570` … `ธันวาคม 2570`, kind `monthly`, sort_order 1–12) และ `ecard-lee`, `ecard-loxley` (kind `ecard`, sort_order 13–14, title `e-card ปีใหม่ Lee` / `e-card ปีใหม่ LOXLEY`) `r2_key`/ไฟล์เป็น NULL ใช้ `INSERT IGNORE` (หรือเทียบเท่า) ไม่ทับข้อมูลที่ลูกค้าแก้แล้ว
- [ ] AC6 `GET /healthz` → 200 `{"ok":true,"db":true}` เมื่อต่อ DB ได้ และ 503 `{"ok":false,"db":false}` เมื่อต่อไม่ได้ ไม่รั่ว error/รายละเอียด DB ใน response
- [ ] AC7 เสิร์ฟไฟล์ static จาก `public/` เท่านั้น มีไฟล์ placeholder ใน `public/` อย่างน้อย 1 ไฟล์ (เช่น `robots.txt` แบบ `Disallow: /admin`) `GET /app.js`, `/package.json`, `/src/config.js`, `/.env.local` → 404
- [ ] AC8 path ที่ไม่มี → 404 หน้า HTML ภาษาไทยพื้นดำตัวทอง error ที่ไม่คาดคิด → 500 หน้า HTML ภาษาไทย ไม่โชว์ stack trace เมื่อ `NODE_ENV=production`
- [ ] AC9 `npm test` ผ่านทั้งหมดบน `loxley_test` ครอบคลุม AC3–AC8 test ล้างตารางเองก่อนรัน ไม่ขึ้นกับลำดับ
- [ ] AC10 `README.md` อธิบายสั้น ๆ (ภาษาไทยได้): วิธีตั้ง DB ในเครื่อง, `npm run dev`, `npm test`, `npm run migrate`, ค่า env ที่ต้องตั้งใน Plesk (ชื่อตัวแปรเท่านั้น)

## นอกขอบเขต

หน้า `/v/<slug>`, route `/media/*`, login/session/admin_users, upload, QR, script deploy — เป็น task ถัดไป

## กฎ qr-video-cms ที่เกี่ยวข้อง

- กฎข้อ 7: ไม่เก็บ secret ใน repo (repo เป็น public)
- แบบ B/C: `process.env.PORT`, หลีกเลี่ยง native module, migration idempotent
- Plesk: Document Root `/httpdocs/public`, ไม่มี SSH (migration รันผ่าน "Run Node.js commands")

## Log

### รอบ 1

- Dev: ทำครบทุก AC dependency มีแค่ `express@5` กับ `mysql2` test ผ่าน 32/43 อีก 11 ข้อที่ต้องใช้ DB ล้มด้วย `ER_ACCESS_DENIED_ERROR` เพราะผู้ใช้ยังไม่ได้สร้าง DB user ในเครื่อง (ไม่ใช่บั๊กในโค้ด) ยังไม่ส่ง QA/Review รอให้ DB พร้อมก่อน
- Lead: เปลี่ยน slug ใน AC5 จาก `ecard-partner` เป็น `ecard-lee` ตามที่ผู้ใช้ยืนยันแล้ว (ส่งให้ Dev แก้ในรอบ 2)
- Lead: ผู้ใช้เปลี่ยน Node บน server กลับเป็น 24 → AC1 engines เป็น `>=24.20 <25` และต้องติดตั้ง/รันด้วย npm ของ nvm Node 24 (ส่งให้ Dev แก้ในรอบ 2)

### รอบ 2

- Dev: เปลี่ยน engines เป็น `>=24.20 <25` สร้าง lock ใหม่ด้วย Node 24.20 / npm 11.19 และเปลี่ยน seed เป็น `ecard-lee` (13) / `ecard-loxley` (14) `npm test` บน loxley_test ผ่าน 43/43 (รันซ้ำก็ผ่าน) `migrate:dev` บน DB ว่าง: ครั้งแรกสร้าง 2 migration ครั้งที่สองขึ้น "already up to date"
- QA: **PASS** ผ่าน AC1–AC10 จากการรันจริง เพิ่ม `test/qa-cwd.test.js` รวมเป็น 45/45 ลองเจาะ path traversal แบบ encoded กว่า 10 แบบแล้วได้ 404 ทั้งหมด finding เล็ก 2 ข้อ: (1) ไม่ได้ตั้ง `NODE_ENV` แล้วแอปถือเป็น development ทำให้หน้า 500 โชว์รายละเอียด error (fail open, `src/config.js:59`) (2) test seed ใน `db.test.js` รันเดี่ยวไม่ผ่าน เพราะพึ่ง test ก่อนหน้าในการ migrate ทดสอบไม่ได้: MariaDB 10.11 กับ Passenger จริง
- Review: **APPROVE** ไม่มี blocking มี non-blocking 7 ข้อ
- Lead: ผ่านเกณฑ์ไปขั้น commit ได้แล้ว แต่เลือกแก้ non-blocking ที่ถูกและลดความเสี่ยงบน production ในรอบ 3 ก่อน:
  - (R1) callback ของ `listen` ใน app.js อ้าง `server` ที่ได้จาก `app.listen()` ซึ่งบน Passenger อาจเป็น `undefined` แล้วแอปล้มตอนสตาร์ต
  - (R3 + QA1) ไม่ได้ตั้ง `NODE_ENV` แล้วแสดงรายละเอียด error (fail open)
  - (R4) README แถว PORT เขียนขัดกับโค้ด
  - (QA2) test seed รันเดี่ยวไม่ผ่าน ขัด AC9 ข้อ "ไม่ขึ้นกับลำดับ"
- Lead ตัด R2 (หน้า `/v/ecard-lee/` ได้ 404 ถ้าวิ่งไปถึง Node): เช็กกับ production แล้ว ตอนนี้ Node เปิดอยู่แต่ไม่มี app.js คำขอที่ไปถึง Node ได้ 500 แต่ `/v/ecard-lee/` ได้ 200 แปลว่า nginx ของ Plesk เสิร์ฟไฟล์ static เองก่อนส่งต่อให้ Node ใส่ไว้ใน checklist deploy ครั้งแรกแทน
- Lead เลื่อน R5 (Run Node.js commands ส่ง env ไหม ไปเช็กตอน deploy), R6 (ตรวจว่า STORAGE_DIR อยู่นอก public ไปทำใน task /media) และ R7 (`req.ip` บน production ไปทำใน task login)

### รอบ 3

- Dev: แก้ครบ 4 ข้อ สร้าง server เองด้วย `http.createServer` และใต้ Passenger listen `'passenger'` โดยไม่เรียก `address()` ไม่ได้ตั้ง `NODE_ENV` แล้วไม่แสดงรายละเอียด error แก้ README แถว PORT ทำให้ db test รันแยกทีละข้อได้ เพิ่ม `test/startup.test.js` (จำลอง Passenger) รวม test 50/50 รัน seed แยกเดี่ยวก็ผ่าน
- QA: **PASS** test ครบ 50/50 บั๊กเดิมทั้ง 2 ข้อหายแล้ว ไม่ได้ตั้ง `NODE_ENV` แล้วหน้า 500 ไม่มีรายละเอียด และ db test รันเดี่ยวทั้ง 11 ข้อผ่าน รวมกรณีที่ DB มีข้อมูลค้าง เอา `app.js` ของรอบ 2 มารันกับ `startup.test.js` แล้ว fail 3/3 และพังด้วย `TypeError ... 'address'` แปลว่า test จำลอง Passenger จับปัญหาเดิมได้จริง ข้อจำกัด: ตรวจได้แค่ช่วงสตาร์ต ยังต้องยืนยันกับ Passenger จริง
- Review: **APPROVE** ไม่มี blocking สร้าง server เองด้วย `http.createServer` แล้วยังโดน hook ของ Passenger ที่ระดับ prototype ตรวจ `globalThis.PhusionPassenger` ตามที่เอกสาร Passenger แนะนำ **ไม่ควร**ผ่อน fallback เรื่อง PORT (ถ้าเดาผิดจะได้ unix socket ที่ไม่มีใครเข้าถึง หาสาเหตุยาก) มี non-blocking 2 ข้อ ย้ายไปไว้ใน "ค้างไว้"
- Lead: รัน `npm test` เองได้ 50/50 ผ่าน และสแกนไฟล์ที่จะ commit แล้วไม่มีค่าลับ → **ผ่านเกณฑ์ รอผู้ใช้อนุมัติ commit**

## ค้างไว้

- (Review รอบ 3) listener `error` ใน app.js สั่ง exit ทันทีทุกกรณี: พิจารณาให้ exit เฉพาะตอนที่ `!server.listening`
- (Review รอบ 3) เพิ่ม test ที่โหลด app.js ด้วย `require()` ใต้ Passenger ปลอม กันกรณีมีคนใส่ top-level await แล้วแอปพังเฉพาะบน Plesk
- Checklist deploy ครั้งแรก: ดูใน Logs ของ Plesk ว่าขึ้น "listening under Passenger" ถ้าเจอ "Missing ... PORT" ให้ทบทวนวิธีตรวจ Passenger

- ~~slug e-card บริษัทที่ 2~~ → ยืนยันแล้ว: e-card ชุดแรกคือ **`ecard-lee`** (บริษัท Lee) อีกชุดคือ `ecard-loxley`
- **มีหน้าชั่วคราวบน production แล้ว** (2026-10-24): `/httpdocs/public/v/ecard-lee/index.html` + `ecard-lee-<epoch>.mp4` เป็นไฟล์ static ที่ nginx เสิร์ฟเอง และ QR ที่ส่งลูกค้าไปแล้วชี้ไปที่ `https://wjasmin.site/v/ecard-lee/` (**มี `/` ต่อท้าย**)
  - deploy แอปครั้งแรกห้ามลบ `public/v/` จนกว่า route `/v/:slug` จะใช้งานได้ และต้องย้ายวีดีโอนี้เข้า `STORAGE_DIR` + DB ก่อน
  - route `/v/:slug` ต้องรับ URL ที่มี `/` ต่อท้ายด้วย
- **Checklist deploy ครั้งแรก** (จาก review รอบ 2):
  - หลัง Restart App เปิด `https://wjasmin.site/v/ecard-lee/` แล้วกด play/seek ได้ และ `/healthz` ได้ 200
  - ยืนยันว่าแท็บ "Run Node.js commands" ได้ Custom environment variables (`npm run migrate` ต้องไม่ขึ้น Missing env) แล้วจดผลลง skill deploy-plesk
- งานที่เลื่อนไป task อื่น: ตรวจว่า `STORAGE_DIR` ไม่อยู่ใต้ `public/` (task /media), log `req.ip` บน production ครั้งหนึ่งเพื่อยืนยันว่า `trust proxy` ได้ IP จริงของคนใช้ (task login)

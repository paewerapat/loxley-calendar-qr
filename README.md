# loxley-calendar-qr

สแกน QR บนปฏิทิน LOXLEY แล้วเปิดดูวีดีโอบนมือถือ (`https://wjasmin.site/v/<slug>`) พร้อมหลังบ้านให้ลูกค้าอัปโหลดวีดีโอเอง

Stack: Node.js 24 (ES modules) + Express + MariaDB (`mysql2`) ไฟล์วีดีโอเก็บบนดิสก์ของ hosting Plesk ใช้เฉพาะ package ที่เป็น pure JS เพราะ server ไม่มี SSH และ build native module ไม่ได้

## โครงสร้าง

| path | หน้าที่ |
| --- | --- |
| `app.js` | ไฟล์เข้าแอป (Plesk Startup File) เรียก `listen` ที่นี่ที่เดียว |
| `src/config.js` | อ่าน env ที่เดียว ขาดตัวแปรจะหยุดพร้อมบอกชื่อตัวแปร |
| `src/app.js` | `createApp({ config, pool })` ใช้ทั้งในแอปจริงและใน test |
| `migrations/NNN_*.sql` | migration เรียงตามเลข บันทึกที่รันแล้วใน `schema_migrations` |
| `src/video-routes.js` | หน้า `/v/<slug>` (QR ชี้มาที่นี่) และไฟล์วีดีโอ `/media/videos/<slug>/<epoch>.mp4` (รองรับ Range) |
| `scripts/migrate.js` | `npm run migrate` |
| `scripts/video-set.js` | `npm run video:set` ผูกไฟล์วีดีโอใน `STORAGE_DIR` กับชุด |
| `public/` | ไฟล์ static (Plesk Document Root) ห้ามวางไฟล์อื่นในนี้ `public/assets/player.*` คือ CSS/JS ของหน้าดูวีดีโอ |

## ตั้ง DB ในเครื่อง (MySQL 8.4 / MariaDB)

```sql
CREATE DATABASE loxley_dev  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE loxley_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'loxley'@'127.0.0.1' IDENTIFIED BY '<รหัสผ่านของคุณ>';
GRANT ALL PRIVILEGES ON loxley_dev.*  TO 'loxley'@'127.0.0.1';
GRANT ALL PRIVILEGES ON loxley_test.* TO 'loxley'@'127.0.0.1';
```

สร้างไฟล์ `.env.dev` และ `.env.test` (ไม่ถูก commit) ใส่ตัวแปรตามหัวข้อ "ตัวแปร env" โดย `DB_NAME` เป็น `loxley_dev` / `loxley_test` ตามลำดับ test จะไม่ยอมรันถ้า `DB_NAME` ไม่ลงท้ายด้วย `_test`

> `.env.local` เก็บค่าลับของ production แอป test และ migration ไม่อ่านไฟล์นี้ ห้ามชี้ `.env.dev` / `.env.test` ไปที่ DB production

## คำสั่ง

ใช้ Node 24 (เครื่อง dev ใช้ nvm: `nvm use 24`) ให้ตรงกับ server และ `engines` ใน `package.json`

```bash
npm install
npm run migrate:dev   # migrate DB ใน .env.dev (= node --env-file=.env.dev scripts/migrate.js)
npm run dev           # รันแอปด้วย .env.dev และ restart เองเมื่อแก้ไฟล์
npm test              # test ทั้งหมดกับ DB ใน .env.test (ล้างตารางเองก่อนรัน)
npm run migrate       # migrate ด้วย env ที่มีอยู่แล้ว (ใช้บน Plesk)
```

migration รันซ้ำได้เสมอ ไม่สร้างข้อมูลซ้ำ และไม่ทับข้อมูลที่ลูกค้าแก้แล้ว ครั้งแรกจะสร้างตาราง `videos` พร้อม 14 ชุด (`m01`–`m12`, `ecard-lee`, `ecard-loxley`)

## ผูกไฟล์วีดีโอกับชุด (`video:set`)

ใช้จนกว่าหลังบ้านสำหรับอัปโหลดจะเสร็จ วางไฟล์ไว้ใน `STORAGE_DIR` ก่อน (ชื่อไฟล์เป็นเลข epoch ตามกฎ "ชื่อไฟล์มี timestamp") แล้วรัน

```bash
npm run video:set -- <slug> videos/<slug>/<epoch>.mp4      # ใช้ env ที่มีอยู่ (บน Plesk)
npm run video:set:dev -- <slug> videos/<slug>/<epoch>.mp4  # ในเครื่อง ใช้ .env.dev
```

- path สัมพัทธ์กับ `STORAGE_DIR` และต้องอยู่ในโฟลเดอร์ของชุดนั้น เช่น `videos/ecard-lee/1792832980.mp4`
- ตรวจก่อนแก้ DB: slug มีในตาราง, path ถูกรูปแบบ, ไฟล์มีอยู่จริง, เป็น MP4 (มี box `ftyp`), ขนาดไม่เกิน 20MB (monthly) / 100MB (ecard) ผิดข้อไหนจะ exit 1 พร้อมบอกสาเหตุ และไม่แก้ DB
- สำเร็จแล้วอัปเดต `r2_key`, `size_bytes`, `updated_at` (UTC), `updated_by = cli` ไฟล์เก่าไม่ถูกลบ คำสั่งจะพิมพ์ path ของไฟล์เก่าให้ ลบเองผ่าน FTP เมื่อแน่ใจแล้ว

### ย้าย e-card Lee เข้าแอป (deploy ครั้งแรก)

ตอนนี้ `https://wjasmin.site/v/ecard-lee/` เป็นหน้า static ใน `/httpdocs/public/v/ecard-lee/` ที่ nginx เสิร์ฟเองก่อนถึงแอป และ QR ที่ส่งลูกค้าแล้วชี้ไปที่ URL นี้ (มี `/` ต่อท้าย)

1. deploy แอปโดย**ไม่ลบ** `public/v/` (mirror ต้อง exclude `public/v/`) แล้วกด NPM install, รัน `npm run migrate`, กด Restart App
2. อัปไฟล์วีดีโอผ่าน FTP ไปที่ `/qr-storage/videos/ecard-lee/<epoch>.mp4` (นอก `/httpdocs` สร้างโฟลเดอร์ถ้ายังไม่มี `<epoch>` คือเวลาเป็นวินาที เช่น `date +%s`)
3. ใน Plesk → Node.js → **Run Node.js commands** รัน `npm run video:set -- ecard-lee videos/ecard-lee/<epoch>.mp4`
4. ตรวจว่าแอปเสิร์ฟได้: `https://wjasmin.site/media/videos/ecard-lee/<epoch>.mp4` เล่นได้ (nginx ยังเสิร์ฟ `/v/ecard-lee/` จากไฟล์ static อยู่)
5. ลบโฟลเดอร์ `/httpdocs/public/v/ecard-lee/` ผ่าน FTP แล้วเปิด `https://wjasmin.site/v/ecard-lee/` และ `https://wjasmin.site/v/ecard-lee` ต้องได้หน้าจากแอป (เล่นวีดีโอได้ ไม่ redirect) ทดสอบสแกน QR จริงอีกครั้ง

ตรวจสถานะ: `GET /healthz` → `200 {"ok":true,"db":true}` หรือ `503 {"ok":false,"db":false}` ถ้าต่อ DB ไม่ได้

## ตัวแปร env

ตั้งใน Plesk → Websites & Domains → wjasmin.site → Node.js → **Custom environment variables** (ใส่ชื่อตามนี้ ค่าจริงห้ามเขียนลง repo)

| ชื่อ | จำเป็น | หมายเหตุ |
| --- | --- | --- |
| `DB_HOST` | ใช่ | |
| `DB_PORT` | ไม่ | ค่าเริ่มต้น 3306 |
| `DB_NAME` | ใช่ | |
| `DB_USERNAME` | ใช่ | |
| `DB_PASSWORD` | ใช่ | |
| `STORAGE_DIR` | ใช่ | production = `../qr-storage` (path สัมพัทธ์คิดจากโฟลเดอร์ของ `app.js` คือ `/httpdocs`) ห้ามอยู่ใน `public/` หรือเท่ากับ app root และเมื่อ `NODE_ENV=production` ต้องอยู่นอก app root (deploy ที่ mirror แบบ `--delete` ทับ `/httpdocs` จะลบวีดีโอได้) ตรวจตาม path จริงหลังตาม symlink ถ้าผิดแอปจะไม่ยอมสตาร์ต ในเครื่อง (dev/test) ใช้ `./storage` ได้ |
| `NODE_ENV` | ไม่ | Plesk ตั้งให้จาก Application Mode = `production` แสดง stack trace เฉพาะเมื่อตั้งเป็น `development` ตรง ๆ (ไม่ตั้ง = ไม่แสดง) |
| `PORT` | ไม่ต้องตั้งบน Plesk | บน Plesk Passenger จัดการการ listen เอง แอปจะไม่ใช้ `PORT` ส่วนในเครื่องมาจาก `.env.dev` (รัน `node app.js` นอก Passenger ต้องมี `PORT`) |

ค่าที่อ่านจาก env จะตัดช่องว่างและ `\r` (CRLF) ออกให้

## ตั้งค่า Plesk (สรุป)

- Application Root `/httpdocs`, Document Root `/httpdocs/public`, Application Startup File `app.js`, Application Mode `production`
- หลังอัป `package.json` ใหม่ กด **NPM install** แล้วรัน `npm run migrate` ในแท็บ **Run Node.js commands** จากนั้นกด **Restart App**
- ขั้นตอน deploy เต็มอยู่ใน `.claude/skills/deploy-plesk/SKILL.md`

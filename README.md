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
| `scripts/migrate.js` | `npm run migrate` |
| `public/` | ไฟล์ static (Plesk Document Root) ห้ามวางไฟล์อื่นในนี้ |

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
| `STORAGE_DIR` | ใช่ | production = `../qr-storage` (path สัมพัทธ์คิดจากโฟลเดอร์ของ `app.js` คือ `/httpdocs`) |
| `NODE_ENV` | ไม่ | Plesk ตั้งให้จาก Application Mode = `production` แสดง stack trace เฉพาะเมื่อตั้งเป็น `development` ตรง ๆ (ไม่ตั้ง = ไม่แสดง) |
| `PORT` | ไม่ต้องตั้งบน Plesk | บน Plesk Passenger จัดการการ listen เอง แอปจะไม่ใช้ `PORT` ส่วนในเครื่องมาจาก `.env.dev` (รัน `node app.js` นอก Passenger ต้องมี `PORT`) |

ค่าที่อ่านจาก env จะตัดช่องว่างและ `\r` (CRLF) ออกให้

## ตั้งค่า Plesk (สรุป)

- Application Root `/httpdocs`, Document Root `/httpdocs/public`, Application Startup File `app.js`, Application Mode `production`
- หลังอัป `package.json` ใหม่ กด **NPM install** แล้วรัน `npm run migrate` ในแท็บ **Run Node.js commands** จากนั้นกด **Restart App**
- ขั้นตอน deploy เต็มอยู่ใน `.claude/skills/deploy-plesk/SKILL.md`

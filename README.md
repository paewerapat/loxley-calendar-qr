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
| `src/admin-routes.js` | หลังบ้าน `/admin*`, `/api/admin/*`: login, session (เก็บใน DB), กันเดารหัส, ตรวจ Origin, เปลี่ยนรหัสผ่าน, รายการ 14 ชุด, ดาวน์โหลด QR |
| `src/upload.js` | `POST /api/admin/videos/<slug>` รับไฟล์แบบ stream ลง `STORAGE_DIR/tmp/` แล้วย้ายเป็น `videos/<slug>/<epoch-ms>.mp4` |
| `src/video-files.js` | ตรวจไฟล์ (ขนาดตามชุด + MP4) และบันทึก DB ใช้ร่วมกันระหว่างหน้าอัปโหลดกับ `video:set` |
| `scripts/admin.js` | `npm run admin:create` / `admin:reset-password` / `admin:list` |
| `public/` | ไฟล์ static (Plesk Document Root) ห้ามวางไฟล์อื่นในนี้ `public/assets/player.*` คือ CSS/JS ของหน้าดูวีดีโอ `public/assets/admin.*` ของหน้าหลังบ้าน |

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

ปกติลูกค้าอัปโหลดเองที่หน้าหลังบ้าน คำสั่งนี้ใช้เมื่อเราวางไฟล์เองผ่าน FTP (เช่นย้าย e-card Lee ตอน deploy ครั้งแรก) วางไฟล์ไว้ใน `STORAGE_DIR` ก่อน (ชื่อไฟล์เป็นเลข epoch ตามกฎ "ชื่อไฟล์มี timestamp") แล้วรัน

```bash
npm run video:set -- <slug> videos/<slug>/<epoch>.mp4      # ใช้ env ที่มีอยู่ (บน Plesk)
npm run video:set:dev -- <slug> videos/<slug>/<epoch>.mp4  # ในเครื่อง ใช้ .env.dev
```

- path สัมพัทธ์กับ `STORAGE_DIR` และต้องอยู่ในโฟลเดอร์ของชุดนั้น เช่น `videos/ecard-lee/1792832980.mp4`
- ตรวจก่อนแก้ DB (ชุดเดียวกับหน้าอัปโหลด): slug มีในตาราง, path ถูกรูปแบบ, ไฟล์มีอยู่จริง, เป็น MP4 (มี box `ftyp`), ขนาดไม่เกิน 20 MiB (monthly) / 100 MiB (ecard) (1 MiB = 1,048,576 ไบต์) ผิดข้อไหนจะ exit 1 พร้อมบอกสาเหตุ และไม่แก้ DB
- สำเร็จแล้วอัปเดต `r2_key`, `size_bytes`, `updated_at` (UTC), `updated_by = cli` ไฟล์เก่าไม่ถูกลบ คำสั่งจะพิมพ์ path ของไฟล์เก่าให้ ลบเองผ่าน FTP เมื่อแน่ใจแล้ว

### ย้าย e-card Lee เข้าแอป (deploy ครั้งแรก)

ตอนนี้ `https://wjasmin.site/v/ecard-lee/` เป็นหน้า static ใน `/httpdocs/public/v/ecard-lee/` ที่ nginx เสิร์ฟเองก่อนถึงแอป และ QR ที่ส่งลูกค้าแล้วชี้ไปที่ URL นี้ (มี `/` ต่อท้าย)

1. deploy แอปโดย**ไม่ลบ** `public/v/` (mirror ต้อง exclude `public/v/`) แล้วกด NPM install, รัน `npm run migrate`, กด Restart App
2. อัปไฟล์วีดีโอผ่าน FTP ไปที่ `/qr-storage/videos/ecard-lee/<epoch>.mp4` (นอก `/httpdocs` สร้างโฟลเดอร์ถ้ายังไม่มี `<epoch>` คือเวลาเป็นวินาที เช่น `date +%s`)
3. ใน Plesk → Node.js → **Run Node.js commands** รัน `npm run video:set -- ecard-lee videos/ecard-lee/<epoch>.mp4`
4. ตรวจว่าแอปเสิร์ฟได้: `https://wjasmin.site/media/videos/ecard-lee/<epoch>.mp4` เล่นได้ (nginx ยังเสิร์ฟ `/v/ecard-lee/` จากไฟล์ static อยู่)
5. ลบโฟลเดอร์ `/httpdocs/public/v/ecard-lee/` ผ่าน FTP แล้วเปิด `https://wjasmin.site/v/ecard-lee/` และ `https://wjasmin.site/v/ecard-lee` ต้องได้หน้าจากแอป (เล่นวีดีโอได้ ไม่ redirect) ทดสอบสแกน QR จริงอีกครั้ง

ตรวจสถานะ: `GET /healthz` → `200 {"ok":true,"db":true}` หรือ `503 {"ok":false,"db":false}` ถ้าต่อ DB ไม่ได้

### อัปโหลดผ่านหน้าหลังบ้าน (deploy ครั้งแรก)

- ไฟล์ที่อัปโหลดถูกเขียนลง `STORAGE_DIR/tmp/` ก่อน (`/qr-storage/tmp/` บน server) แล้วย้ายเป็น `videos/<slug>/<epoch-ms>.mp4` ไฟล์เก่าของชุดนั้นถูกลบหลังบันทึก DB สำเร็จ ไฟล์ชั่วคราวที่ค้างเกิน 1 วันถูกลบตอนแอปสตาร์ต
- หลัง deploy ให้ลองอัปโหลด e-card ขนาดใกล้ 100 MiB จริงหนึ่งครั้ง ถ้าได้ข้อความ "ไฟล์ใหญ่เกิน ..." ทั้งที่ไฟล์ไม่เกิน หรือ log ของ nginx มี **413 Request Entity Too Large** แปลว่า nginx จำกัดขนาด request ต่ำกว่าที่ต้องการ ให้เพิ่มใน Plesk → Apache & nginx Settings → **Additional nginx directives**:
  ```nginx
  client_max_body_size 110m;
  ```
  - ถ้าทำได้ควรจำกัดเฉพาะ `/api/admin/videos/` แต่ใน Plesk ช่องนี้อยู่ระดับ server และ `location` ที่เขียนเองต้องมีคำสั่งส่งต่อไปแอป (Passenger/proxy) แบบเดียวกับที่ Plesk สร้างให้ ไม่งั้น request จะไม่ถึงแอป จึงแนะนำแบบทั้งเว็บ ซึ่งปลอดภัยเพราะแอปจำกัดขนาดตามชุดเองอยู่แล้ว (20 / 100 MiB) และ request อื่นทั้งหมดเล็กมาก
  - ถ้าเลือกลองแบบ `location ^~ /api/admin/videos/ { client_max_body_size 110m; ... }` ต้องทดสอบอัปโหลดจริงทันที ถ้าได้ 404/502 ให้ลบออกแล้วใช้แบบทั้งเว็บ
- ข้อจำกัดเวลา: ถ้าอัปโหลดไฟล์ใหญ่ผ่านเน็ตช้าแล้วหลุดกลางทาง ให้ตรวจ timeout ของ proxy (`proxy_read_timeout`, `client_body_timeout`) ใน Plesk

## คู่มือสำหรับลูกค้า (คัดลอกส่งลูกค้าได้ทั้งหัวข้อ)

> **การเปลี่ยนวีดีโอในปฏิทิน LOXLEY**
>
> **1. เข้าสู่ระบบ**
> เปิด `https://wjasmin.site/admin` บนมือถือหรือคอมพิวเตอร์ ใส่ชื่อผู้ใช้และรหัสผ่านที่ได้รับ ถ้าใส่รหัสผิด 5 ครั้งระบบจะล็อก 15 นาที ถ้าลืมรหัสผ่านให้ติดต่อผู้ดูแล
>
> **2. รายการวีดีโอ**
> หน้าแรกแสดงวีดีโอทั้ง 14 ชุด (มกราคม–ธันวาคม และ e-card 2 ชุด) แต่ละชุดบอกว่า "มีวีดีโอแล้ว" หรือ "ยังไม่มีวีดีโอ" ขนาดไฟล์ และเวลาที่อัปเดตล่าสุด (เวลาไทย)
>
> **3. อัปโหลดหรือเปลี่ยนวีดีโอ**
> กดปุ่ม "อัปโหลดวีดีโอ" หรือ "เปลี่ยนวีดีโอ" ของชุดที่ต้องการ แล้วเลือกไฟล์ จะเห็นแถบความคืบหน้าเป็น % ระหว่างอัปโหลดอย่าปิดหน้าเว็บ กด "ยกเลิก" ได้ถ้าเลือกไฟล์ผิด เสร็จแล้วจะขึ้น "อัปโหลดเรียบร้อยแล้ว" วีดีโอใหม่แสดงทันที QR Code เดิมที่พิมพ์ไปแล้วยังใช้ได้ ไม่ต้องพิมพ์ใหม่
>
> **4. ไฟล์ที่รับได้**
> - ไฟล์วีดีโอ **MP4** (.mp4) เท่านั้น
> - วีดีโอรายเดือน ไม่เกิน **20 MB**
> - e-card ไม่เกิน **100 MB**
> - ถ้าไฟล์ใหญ่เกิน ระบบจะแจ้งก่อนส่ง ให้บีบอัดไฟล์หรือติดต่อผู้ดูแล
>
> **5. ดูตัวอย่าง คัดลอกลิงก์ และดาวน์โหลด QR**
> - "ดูตัวอย่าง" เปิดหน้าที่คนสแกน QR จะเห็น
> - "คัดลอกลิงก์" คัดลอกลิงก์ของชุดนั้นไปวางในแชทหรืออีเมล
> - "QR (PNG)" สำหรับใช้ทั่วไปและงานพิมพ์ (ภาพกว้าง 2000 พิกเซล) "QR (SVG)" สำหรับโรงพิมพ์ (ขยายได้ไม่แตก) ชื่อไฟล์บอกชุด เช่น `QR-01-มกราคม.png`
>
> **6. เปลี่ยนรหัสผ่าน และออกจากระบบ**
> กด "เปลี่ยนรหัสผ่าน" ที่ด้านบน ใส่รหัสเดิม รหัสใหม่ (อย่างน้อย 10 ตัวอักษร) และยืนยันรหัสใหม่ เมื่อใช้เสร็จบนเครื่องที่ใช้ร่วมกับคนอื่นให้กด "ออกจากระบบ" ทุกครั้ง ถ้าไม่ได้ใช้งาน 8 ชั่วโมงระบบจะออกจากระบบให้เอง

## หลังบ้าน: ผู้ใช้และรหัสผ่าน

เข้าที่ `https://wjasmin.site/admin` (ล็อกอินด้วย username + รหัสผ่าน ไม่มีหน้าสมัครสมาชิก) ไม่ได้ใช้งาน 8 ชั่วโมงจะหลุดจากระบบ

การกันเดารหัส (ทั้งหน้า login และรหัสเดิมในหน้าเปลี่ยนรหัส):

- ผิด 5 ครั้งใน 15 นาที ต่อ IP + username → ล็อก 15 นาที (จองสิทธิ์ใน DB ก่อนตรวจรหัส ส่งพร้อมกันหลาย request ก็ตรวจได้ไม่เกิน 5 รหัส)
- ผิดรวม 100 ครั้งใน 15 นาที ต่อ username ไม่ว่าจาก IP ไหน → ล็อก username นั้น (กันการปลอม IP; ปรับได้ที่ `usernameFailures` ใน `DEFAULT_AUTH_LIMITS`) ผู้โจมตีต้องใช้ราว 20 IP ถึงจะล็อกลูกค้าได้ และการเดารหัสยาว ≥ 10 ตัวใน 100 ครั้งเป็นไปไม่ได้จริง
- ต่อ process: ส่งฟอร์มรหัสผ่านได้ 10 ครั้ง/นาที/IP และตรวจรหัส (bcrypt) พร้อมกันได้ 2 งาน เกินจากนี้ได้ข้อความ "มีการเข้าสู่ระบบถี่เกินไป กรุณารอสักครู่แล้วลองใหม่" หน้า QR สาธารณะจึงไม่ช้าตามเมื่อมีคนยิง login รัว ๆ
- รหัสผ่านยาวได้ไม่เกิน 72 ไบต์ (ข้อจำกัดของ bcrypt ประมาณ 24 ตัวอักษรไทย)

คำสั่งจัดการผู้ใช้ ใช้แค่ `DB_*` บน Plesk รันที่ Node.js → **Run Node.js commands** (ในเครื่องใช้ตัว `:dev` เช่น `npm run admin:create:dev -- <username>`)

```bash
npm run admin:create -- <username>           # สร้างผู้ใช้ พิมพ์รหัสผ่านสุ่ม (20 ตัว) ออกมาครั้งเดียว
npm run admin:reset-password -- <username>   # สุ่มรหัสใหม่ พิมพ์ครั้งเดียว session เดิมของผู้ใช้นั้นหลุดหมด และล้างการล็อก
npm run admin:list                           # username, created_at, last_login_at (เวลา UTC)
```

- username: `a-z 0-9 . _ -` ยาว 3–32 ตัว (พิมพ์ใหญ่จะถูกแปลงเป็นตัวเล็ก)
- **ห้ามใส่รหัสผ่านใน command** (คำสั่งไม่รับ และ panel เก็บประวัติคำสั่งไว้) รหัสผ่านสุ่มด้วย `crypto` แล้วแสดงในผลลัพธ์ครั้งเดียว คัดลอกไปเก็บทันที
- เก็บรหัสเป็น hash `bcryptjs` cost 12 ไม่มีการ log รหัสผ่านหรือ hash

**ตอน deploy ครั้งแรก:** หลัง `npm run migrate` ให้รัน `npm run admin:create -- <username ของลูกค้า>` และ `npm run admin:create -- <username ของเรา>` ส่งรหัสของลูกค้าให้ลูกค้าทางช่องทางส่วนตัว แล้วแนะนำให้เปลี่ยนรหัสเองที่ `/admin/password`

**ลูกค้าลืมรหัสผ่าน (หรือถูกล็อก):** รัน `npm run admin:reset-password -- <username>` แล้วส่งรหัสใหม่ให้ลูกค้า ลูกค้าล็อกอินแล้วเปลี่ยนเป็นรหัสของตัวเองที่ `/admin/password` (รหัสใหม่ยาวอย่างน้อย 10 ตัว)

ทุกครั้งที่มีการล็อกอินจะมี log ใน Logs ของโดเมน เช่น `[auth] login ok ip=1.2.3.4 proto=https secure=true` หรือ `[auth] login failed ip=… proto=… secure=…` (ไม่มีรหัสผ่านใน log)

### แก้ปัญหาหลังบ้าน

#### กดเข้าสู่ระบบแล้วได้ 403 / ล็อกอินแล้วเด้งกลับหน้า login (cookie ไม่ติด)

- ตรวจว่าตั้ง `PUBLIC_ORIGIN=https://wjasmin.site` ใน Plesk แล้ว (ตรงกับ URL ที่เปิดจริง ทั้ง scheme และ host ถ้าเปิดผ่าน `www.` ต้องใช้ค่านั้นหรือ redirect `www` ไปโดเมนหลัก)
- ดู log `[auth] login … proto=… secure=…`: ถ้า `proto=http secure=false` แปลว่า nginx ไม่ได้ส่ง `X-Forwarded-Proto: https` มา ถ้าตั้ง `PUBLIC_ORIGIN` เป็น https แล้ว แอปจะถือว่าเป็น https ให้เองเมื่อ header นี้ไม่มี (ถ้า nginx ส่ง `http` มาตรง ๆ แอปจะเชื่อตาม ต้องแก้ที่ nginx)
- ถ้าเปิดผ่าน `http://` โดยตรง cookie แบบ Secure จะไม่ถูกเก็บ ต้องเปิดผ่าน https เท่านั้น (Plesk redirect http → https ไว้แล้ว)

#### `ip=` เป็น 127.0.0.1 ทุกครั้ง หรือเป็นค่าที่ผู้ใช้ปลอมได้

- แอปเชื่อ proxy 1 ชั้น (`trust proxy` = 1) คือใช้ IP ตัวสุดท้ายใน `X-Forwarded-For` ที่ nginx เติมให้
- ถ้าเป็น 127.0.0.1 ทุกครั้ง: nginx ไม่ได้ส่ง `X-Forwarded-For` การล็อกต่อ IP จะนับรวมทุกคนเป็น IP เดียว (ลูกค้าอาจโดนล็อกเพราะคนอื่น) ต้องแก้การตั้งค่า proxy ก่อนใช้งาน
- ถ้าเห็น IP แปลก ๆ ที่เปลี่ยนไปเรื่อย ๆ จากคนเดียวกัน: มี proxy มากกว่า 1 ชั้นหรือ header ถูกปลอม ตัวจำกัดต่อ username (100 ครั้ง/15 นาที) ยังกันการเดารหัสไว้ได้ แต่ควรตรวจการตั้งค่า proxy

#### ลูกค้าโดนล็อกซ้ำ ๆ ("ลองผิดหลายครั้งเกินไป")

- รัน `npm run admin:reset-password -- <username>` (ล้างการล็อกของ username นั้นด้วย) แล้วส่งรหัสใหม่ให้ลูกค้า
- ดู log `[auth] login failed ip=…` ใน Logs ของโดเมนว่ามาจาก IP ไหน ถ้าไม่ใช่ IP ของลูกค้า แปลว่ามีคนพยายามเดารหัส username นี้อยู่

### ตรวจหลัง deploy (หลังบ้าน)

1. **IP ปลอมผ่าน `X-Forwarded-For` ต้องไม่ถูกเชื่อ:**
   ```bash
   curl -X POST -H 'Origin: https://wjasmin.site' -H 'X-Forwarded-For: 203.0.113.9' \
     -d 'username=x&password=y' https://wjasmin.site/admin/login
   ```
   แล้วดู Logs ของโดเมน: บรรทัด `[auth] login failed ip=…` ต้อง**ไม่ใช่** `ip=203.0.113.9` (ต้องเป็น IP จริงของเครื่องที่รัน curl) และต้องเห็น `proto=https secure=true`
   ถ้าเห็น `ip=203.0.113.9` แปลว่ามี proxy มากกว่า 1 ชั้นหรือ nginx ส่ง header ของผู้ใช้ต่อมาตรง ๆ ต้องแก้ก่อนเปิดใช้งาน
2. **www ต้อง redirect ไปโดเมนหลักก่อนแสดงฟอร์ม:** เปิด `https://www.wjasmin.site/admin/login` ต้องถูก redirect ไป `https://wjasmin.site/admin/login` (ตรวจด้วย `curl -sI https://www.wjasmin.site/admin/login` ต้องได้ 301/302 และ `Location: https://wjasmin.site/...`) ไม่งั้นฟอร์มที่ส่งจาก www จะได้ 403 เพราะไม่ตรงกับ `PUBLIC_ORIGIN`
3. ล็อกอินด้วยผู้ใช้จริงแล้วออกจากระบบได้ และ log แสดง `[auth] login ok ip=<IP จริง> proto=https secure=true`

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
| `SESSION_SECRET` | ใช่ (เฉพาะแอป) | ใช้เซ็น cookie ของ session ยาวอย่างน้อย 32 ตัวอักษร สร้างด้วย `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (ได้ 64 ตัว hex) ใช้ค่าแยกกันระหว่างเครื่อง dev กับ production ถ้าเปลี่ยนค่า ทุกคนจะหลุดจากระบบ คำสั่ง CLI (`migrate`, `video:set`, `admin:*`) ไม่ต้องใช้ |
| `COOKIE_SECURE` | ไม่ | `true` / `false` ถ้าไม่ตั้ง: `true` เสมอ ยกเว้น `NODE_ENV=development` ในเครื่องที่เปิดผ่าน `http://localhost` ต้องเป็น `false` ไม่งั้นเบราว์เซอร์จะไม่เก็บ cookie (`.env.dev` / `.env.test` ตั้งไว้แล้ว) |
| `PUBLIC_ORIGIN` | ต้องตั้งบน Plesk | `https://wjasmin.site` ถ้าตั้ง: การตรวจ CSRF เทียบ `Origin`/`Referer` กับค่านี้ตรง ๆ (scheme + host + port) แทนการเชื่อ header จาก proxy และถ้าเป็น https แอปจะออก cookie แบบ Secure ได้แม้ nginx ไม่ส่ง `X-Forwarded-Proto` ใช้เป็นที่อยู่ใน QR Code และลิงก์ที่คัดลอกด้วย ถ้า `NODE_ENV=production` แต่ไม่ได้ตั้ง ปุ่มดาวน์โหลด QR จะแจ้งให้ตั้งค่าแทน (กัน QR ที่ชี้ไปโดเมนผิด) และหน้า `/admin` จะขึ้นคำเตือน ในเครื่องไม่ต้องตั้ง |
| `PORT` | ไม่ต้องตั้งบน Plesk | บน Plesk Passenger จัดการการ listen เอง แอปจะไม่ใช้ `PORT` ส่วนในเครื่องมาจาก `.env.dev` (รัน `node app.js` นอก Passenger ต้องมี `PORT`) |

ค่าที่อ่านจาก env จะตัดช่องว่างและ `\r` (CRLF) ออกให้

## ตั้งค่า Plesk (สรุป)

- Application Root `/httpdocs`, Document Root `/httpdocs/public`, Application Startup File `app.js`, Application Mode `production`
- หลังอัป `package.json` ใหม่ กด **NPM install** แล้วรัน `npm run migrate` ในแท็บ **Run Node.js commands** จากนั้นกด **Restart App**
- ขั้นตอน deploy เต็มอยู่ใน `.claude/skills/deploy-plesk/SKILL.md`

---
name: qr-video-cms
description: สร้างและดูแลระบบหน้าเว็บดูวีดีโอ + QR Code + CMS ให้ลูกค้าอัปโหลดวีดีโอเอง (ปฏิทิน 12 เดือน + e-card) ได้ทั้งบน Cloudflare (Pages/R2/D1/Access) และบน hosting ของเราเอง (FTP + Node.js) พร้อม Login with Google หรือรหัสผ่าน ใช้เมื่อทำงานโปรเจกต์ QR วีดีโอปฏิทิน LOXLEY หรืองานแบบเดียวกัน ทั้งตั้งระบบใหม่ deploy เพิ่มชุดวีดีโอ ทำ QR หรือแก้ปัญหาการเล่นวีดีโอ
---

# QR Video CMS

ระบบให้คนสแกน QR แล้วเปิดดูวีดีโอบนมือถือ ลูกค้าล็อกอิน (Google หรือรหัสผ่าน) เพื่ออัปโหลด/เปลี่ยนวีดีโอเองได้ โดย QR ไม่ต้องพิมพ์ใหม่

## บริบทงาน (โปรเจกต์ปัจจุบัน)

- ลูกค้า: ปฏิทิน LOXLEY (ลูกค้าประจำ จ้างผ่าน Fastwork)
- จำนวนชุด: 14 ชุด = วีดีโอรายเดือน 12 ชุด + e-card ปีใหม่ 2 ชุด: `ecard-lee` (บริษัท Lee, ส่ง QR ให้ลูกค้าแล้ว 2026-10-24) และ `ecard-loxley`
- **QR ที่ส่งลูกค้าไปแล้ว** (ห้ามเปลี่ยน URL): `https://wjasmin.site/v/ecard-lee/` (มี `/` ต่อท้าย route `/v/:slug` ต้องรับทั้งแบบมีและไม่มี `/`) ตอนนี้ยังเป็นหน้า static ชั่วคราวใน `public/v/ecard-lee/` (ดู docs/dev-loop/01-scaffold.md หัวข้อ "ค้างไว้") ต้องย้ายเข้าแอปก่อนลบ
- วีดีโอรายเดือน: เสียงบรรยายไทย + ซับอังกฤษฝังในไฟล์ ไม่มีหน้าเลือกภาษา
- ขนาดไฟล์: รายเดือน ≤ 20MB, e-card ≤ 100MB
- ฝากไฟล์ 1 ปีนับจากวันส่งมอบ ต่ออายุปีละ 500 บาท
- ห้ามใช้ Netlify ฟรีกับไฟล์วีดีโอ (แบนด์วิดท์ 100GB/เดือนหมดเร็ว)
- **Login หลังบ้าน: username + รหัสผ่าน** (ผู้ใช้เลือกแล้ว ไม่ใช้ Google) ส่วนที่พูดถึง Google OAuth / Cloudflare Access ในไฟล์นี้ใช้กับงานอื่น
- **โปรเจกต์นี้ใช้แบบ C:** หน้าเว็บ + CMS + ไฟล์วีดีโอ อยู่บน hosting Plesk ของเราทั้งหมด (Node.js + MySQL + ดิสก์) ไม่ใช้ R2/Cloudflare ส่วนที่พูดถึง R2/D1/Access ในไฟล์นี้ใช้กับงานอื่นที่เลือกแบบ A/B เท่านั้น

ถ้าเริ่มโปรเจกต์ใหม่ที่ไม่ใช่ลูกค้านี้ ให้ถามจำนวนชุด ขนาดไฟล์ ระยะเวลาฝากไฟล์ และอีเมลผู้ดูแลก่อนเริ่ม

## สถาปัตยกรรม

```
มือถือสแกน QR ──► https://<domain>/v/<slug>     (หน้า public)
                      │ อ่าน metadata จาก D1
                      ▼
                 <video src="/media/<r2_key>">   (Function สตรีมจาก R2 รองรับ Range)

ลูกค้า ──► https://<domain>/admin   ──[Cloudflare Access: Login with Google]──► หน้า CMS
             │ 1. ขอ presigned PUT URL จาก /api/admin/upload-url
             │ 2. PUT ไฟล์ตรงเข้า R2 จากเบราว์เซอร์
             │ 3. เรียก /api/admin/commit → อัปเดต D1 + ลบไฟล์เก่า
```

- **Cloudflare Pages** + Pages Functions (หรือ Workers + static assets): หน้าเว็บและ API
- **R2**: เก็บวีดีโอ/ภาพปก (ฟรี 10GB, ไม่มีค่า egress)
- **D1**: เก็บ metadata ของแต่ละชุด
- **Cloudflare Access (Zero Trust free ≤ 50 users)**: ครอบ `/admin*` และ `/api/admin/*` ด้วย Google login ไม่ต้องเขียนระบบ auth เอง

Stack ฝั่งหน้าเว็บ: ใช้อะไรก็ได้ที่ build เป็น static ได้ (React/Vite หรือ Next.js static export) เน้นเบา หน้า public ไม่ควรเกินไม่กี่สิบ KB ก่อนโหลดวีดีโอ

## เลือกที่ deploy (ถามหรือเช็กก่อนเริ่มทุกครั้ง)

มี 3 แบบ เลือกตามสิ่งที่ hosting ของเรารองรับ:

| แบบ | หน้าเว็บ + CMS | ไฟล์วีดีโอ | Login | ใช้เมื่อ |
|---|---|---|---|---|
| **A. Cloudflare ทั้งหมด** | Pages + Functions | R2 | Cloudflare Access | ค่าเริ่มต้น ฟรีทั้งระบบ ไม่ห่วงแบนด์วิดท์ |
| **B. Hybrid (แนะนำเมื่อใช้ hosting ของเรา)** | Node.js บน hosting ของเรา | R2 | Google OAuth ในแอป (หรือ Access ถ้า DNS ผ่าน Cloudflare) | อยากรวมงานไว้ใน hosting ที่จ่ายอยู่แล้ว แต่ไม่ให้วีดีโอกินแบนด์วิดท์ hosting |
| **C. Hosting ทั้งหมด** | Node.js บน hosting ของเรา | ดิสก์ของ hosting | Google OAuth ในแอป | hosting แบนด์วิดท์ไม่จำกัดจริงและยืนยันแล้วว่าไม่มี fair use จำกัดไฟล์วีดีโอ |

**ผู้ใช้เลือกแบบ C สำหรับโปรเจกต์ LOXLEY แล้ว** สำหรับงานใหม่ให้ถามก่อน ถ้าใช้แบบ C ต้องเช็ก 2 อย่างตั้งแต่ต้น: (1) อัปโหลดไฟล์ 100MB ผ่าน nginx ของ Plesk ได้ไหม (2) เงื่อนไขแบนด์วิดท์/fair use ของ hosting ถ้าข้อ 1 ไม่ผ่านให้ทำ chunked upload

## ข้อมูล hosting ของเรา (Plesk + Node.js)

> ค่าลับทั้งหมด (IP, FTP, DB) อยู่ใน `.env.local` ซึ่งไม่ถูก commit ห้ามคัดลอกค่าลงไฟล์ใน repo เพราะ repo นี้เป็น **public** ข้อที่ยังเป็น `____` ให้ถามผู้ใช้ ห้ามเดา

- Control panel: **Plesk** (ดูหัวข้อ "Plesk" ด้านล่าง)
- Node.js บน server: **24.x** (เลือกใน Plesk 2026-10-24) ในเครื่อง dev ใช้ nvm Node 24.20.0 (เป็น default อยู่แล้ว) ตั้ง `"engines": { "node": ">=24.20 <25" }` ใน `package.json`
- **การรัน node/npm ในเครื่อง dev จาก session บน Windows**: `wsl.exe -d Ubuntu -e bash -lc 'export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh && nvm use --silent 24 && cd ~/fastwork/loxley-calendar-qr && npm test'` ต้อง source nvm เอง ถ้าไม่ทำ `npm` จะไปเรียก npm ของ Windows (`UNC paths are not supported`) และ `node` จะเป็น Node 22 ของระบบ
- FTP: `FTP_HOST`, `FTP_ACCOUNT_NAME`, `FTP_PASSWORD` ใน `.env.local` ใช้ **FTPS** ได้ (ทดสอบแล้ว 2026-10-24) root ของ FTP คือโฟลเดอร์ subscription (`httpdocs/`, `logs/`, `error_docs/`)
- **ไม่มี SSH**: `npm ci` และ migration ต้องรันผ่านปุ่ม NPM install / แท็บ "Run Node.js commands" ในหน้า Node.js ของ Plesk ส่วน restart ทำได้โดยอัป `tmp/restart.txt` ผ่าน FTP หรือกด Restart App ขั้นตอนเต็มอยู่ใน skill `deploy-plesk`
- ฐานข้อมูล: **MariaDB 10.11** (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`) ต่อจากเครื่อง dev ได้ (ทดสอบแล้วเมื่อ 2026-10-23 ตอนนั้นยังไม่มีตาราง) DB นี้คือ **production** ตอน dev/test ให้สร้าง DB แยกใน Plesk (เช่น `<DB_NAME>_dev`) แล้ว override `DB_NAME`
- ขนาด upload สูงสุดต่อ request: ยังไม่ยืนยัน (คาดว่าราว 100MB) **ต้องทดสอบอัปโหลด 100MB ผ่าน nginx ของ Plesk จริงก่อนออกแบบหน้าอัปโหลด**
- ขนาดดิสก์ / แบนด์วิดท์: `____`
- Hosting: **shared hosting ของ Hostatom** (IP ใช้ร่วมกับลูกค้าอื่น) เข้าด้วย IP เปล่าจะได้หน้า default ของเครื่อง ไม่ใช่แอปเรา จึง**ต้องเข้าผ่านโดเมนเสมอ**
- Domain: **`wjasmin.site`** (จดที่ Hostinger, 2026-10-24) URL ของ QR คือ `https://wjasmin.site/v/<slug>` ห้ามเปลี่ยนหลังพิมพ์ QR
- DNS: อยู่ที่ Hostinger (nameserver `*.dns-parking.com`) มี `A @ → IP ของ hosting` และ `CNAME www → wjasmin.site` ถ้าย้าย hosting ให้แก้ A record ที่ Hostinger ที่เดียว ไม่ใช้ Cloudflare
- SSL: Let's Encrypt ใน Plesk (ครอบ `wjasmin.site` + `www`) และเปิด redirect http → https ใน Plesk แล้ว
- ต้องต่ออายุโดเมนให้ครอบคลุมช่วงที่ QR ใช้งาน (เปิด auto-renew ที่ Hostinger) และแจ้งลูกค้าในเอกสารส่งมอบว่าถ้าโดเมนหมดอายุ QR จะใช้ไม่ได้

### Login ด้วยรหัสผ่าน (แทน Google OAuth ในหัวข้อ "แบบ B/C")

- ตาราง `admin_users (id, username UNIQUE, password_hash, created_at, last_login_at)` ผู้ใช้มี 2 คน คือลูกค้าและเรา ไม่มีหน้าสมัครสมาชิก สร้างผู้ใช้ด้วย `npm run admin:create` (รันผ่าน "Run Node.js commands" ใน Plesk)
- hash ด้วย `bcryptjs` (pure JS) cost 12 ห้ามใช้ `bcrypt` ที่เป็น native
- session เก็บใน MariaDB (`express-session` + `express-mysql-session`) restart แอปแล้วไม่หลุด สร้าง session ใหม่ (`regenerate`) ทุกครั้งที่ login สำเร็จ หมดอายุหลังไม่ใช้งาน 8 ชั่วโมง
- cookie `httpOnly`, `sameSite=lax` ส่วน `secure` ผูกกับ env `COOKIE_SECURE` (production = `true` เพราะเป็น https, ตอน dev บน http://localhost = `false`) ตั้ง `app.set('trust proxy', 1)` เพราะ nginx ของ Plesk เป็นตัวรับ https แล้วส่งต่อให้แอปเป็น http
- กัน brute force: ผิด 5 ครั้งใน 15 นาทีต่อ IP+username ให้ล็อก 15 นาที ข้อความผิดพลาดใช้แบบเดียวกันทุกกรณี "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" ไม่บอกว่า username มีอยู่จริงไหม
- request ที่แก้ข้อมูล (POST/PUT/DELETE) ต้องตรวจ header `Origin` ให้ตรงกับ host ของเรา
- มีหน้าเปลี่ยนรหัสผ่านในหลังบ้าน (ต้องกรอกรหัสเดิม) และปุ่มออกจากระบบ
- `updated_by` ในตาราง videos เก็บ username

## แบบ B/C: แอป Node.js บน hosting

**โครงแอป:** Express (หรือ Next.js `output: 'standalone'` ถ้า hosting รองรับ) ไฟล์เข้า `app.js`/`server.js` ที่ panel ชี้ไป ใช้ `process.env.PORT` เสมอ ห้าม hardcode พอร์ต

**ฐานข้อมูล:** ใช้ MySQL/MariaDB ที่ hosting ให้มา (ตาราง `videos` เหมือนด้านล่าง เปลี่ยน type ให้ตรง) หลีกเลี่ยง `better-sqlite3` และ native module อื่น เพราะ hosting แชร์มัก build native addon ไม่ผ่าน ถ้าจำเป็นต้องใช้ไฟล์ ให้ใช้ JSON file + เขียนแบบ atomic (เขียนไฟล์ชั่วคราวแล้ว rename)

**Login with Google (ในแอป):** (ต้องมีโดเมน + https ถ้าไม่มี ใช้ "Login ด้วยรหัสผ่าน" ด้านบน ซึ่งโปรเจกต์ LOXLEY ใช้อยู่)
- สร้าง OAuth Client ใน Google Cloud Console (ฟรี) ตั้ง redirect URI = `https://<domain>/auth/google/callback`
- ใช้ `openid-client` หรือ `passport-google-oauth20` ขอ scope `openid email` เท่านั้น
- ตรวจ `email_verified === true` และอีเมลต้องอยู่ใน `ADMIN_EMAILS` (env, คั่นด้วย comma) ไม่งั้นปฏิเสธ
- Session: cookie `httpOnly`, `secure`, `sameSite=lax` เก็บ secret ใน env ทุก route `/admin*` และ `/api/admin/*` ต้องผ่าน middleware ตรวจ session
- ตั้ง OAuth consent screen เป็น External + ใส่อีเมลลูกค้าใน test users หรือ publish (scope แค่ email ไม่ต้อง verify กับ Google)
- ถ้า DNS อยู่ที่ Cloudflare และเปิด proxy ส้ม ใช้ Cloudflare Access แทนได้ (ตรวจ `Cf-Access-Jwt-Assertion` ตามกฎข้อ 6)

**อัปโหลดวีดีโอ:**
- แบบ B: เหมือนกฎข้อ 4 แอป Node แค่ออก presigned URL (`@aws-sdk/s3-request-presigner` หรือ `aws4fetch`) แล้วเบราว์เซอร์ PUT ตรงเข้า R2 ไฟล์ไม่ผ่าน hosting เลย จึงไม่ติดขีดจำกัด upload ของ hosting
- แบบ C: รับไฟล์ด้วย `busboy`/`multer` แบบ stream ลงดิสก์ (ห้ามเก็บใน memory) ตั้ง `limits.fileSize` ตาม kind เขียนไปไฟล์ชั่วคราวก่อนแล้วค่อย rename เมื่อครบ เช็กขีดจำกัด upload ของ proxy หน้าบ้านด้วย (LiteSpeed/nginx/Apache มักตั้งไว้ต่ำกว่า 100MB) ถ้าเพิ่มไม่ได้ ต้องทำ chunked upload หรือเปลี่ยนไปแบบ B
- แบบ C เก็บไฟล์นอก public folder แล้วเสิร์ฟผ่าน route `/media/*` ที่ใช้ `res.sendFile` หรือ `express.static` (รองรับ Range อัตโนมัติ) ตั้ง `Cache-Control` แบบ immutable เพราะชื่อไฟล์มี timestamp

**Deploy ผ่าน FTP:**
- Build ในเครื่องก่อน (`npm run build`) อัปเฉพาะไฟล์ที่ต้องใช้: `dist/`/`build/`, `package.json`, `package-lock.json`, ไฟล์เข้าแอป
- **ห้ามอัป `node_modules` ผ่าน FTP** (ช้ามากและ native module อาจไม่ตรงระบบ) ให้รัน `npm ci --omit=dev` ผ่าน panel หรือ SSH แทน
- ใช้ `lftp` mirror อัปเฉพาะไฟล์ที่เปลี่ยน:
  ```bash
  lftp -u "$FTP_USER","$FTP_PASS" "$FTP_HOST" -e "set ftp:ssl-allow yes; \
    mirror -R --only-newer --delete --exclude-glob node_modules/ --exclude-glob .env* \
    ./deploy/ /<app-root>/; quit"
  ```
  ระวัง `--delete` จะลบไฟล์ปลายทางที่ไม่มีในเครื่อง **ห้ามชี้ mirror ไปที่โฟลเดอร์เก็บวีดีโอของแบบ C** ไม่งั้นวีดีโอลูกค้าหายหมด
- ไฟล์ `.env` (secret ทั้งหมด) วางบน server ครั้งเดียวด้วยมือ นอก public folder และไม่อยู่ใน mirror
- Restart แอปหลัง deploy: กด Restart ใน panel หรือ (Passenger) `touch tmp/restart.txt`
- ถ้าผู้ใช้อยากให้ deploy อัตโนมัติ ใช้ GitHub Actions + FTP deploy action โดยเก็บ credential ใน repository secrets
- ก่อนรันคำสั่ง deploy ทุกครั้ง ให้แสดงว่าจะอัปอะไร ไปที่ไหน และถามยืนยันก่อน

## Plesk (hosting ของเรา)

ใช้ส่วนขยาย **Node.js** ของ Plesk (รันผ่าน Phusion Passenger) ตั้งค่าที่ Websites & Domains → โดเมน → Node.js:

- **Node.js Version:** เลือก LTS ล่าสุดที่มีให้ แล้วใช้ version เดียวกันในเครื่องตอน build
- **Application Root:** `/httpdocs`
- **Document Root:** `/httpdocs/public` เก็บไฟล์ static (Plesk บังคับให้อยู่ใต้ Application Root และโฟลเดอร์ต้องมีอยู่ก่อนถึงจะเลือกได้) **ห้ามตั้งให้เท่ากับ Application Root** เพราะ nginx จะเสิร์ฟไฟล์ใน Document Root ตรง ๆ ทำให้ `app.js`, `package.json` และโค้ดทั้งหมดเปิดผ่าน URL ได้
- **ที่เก็บวีดีโอ (แบบ C):** `/qr-storage/videos/` อยู่นอก `/httpdocs` ตั้ง env `STORAGE_DIR=../qr-storage` (แอป resolve เทียบกับ Application Root ไม่ hardcode path เต็ม เพราะ path ของ vhost อาจเปลี่ยนตามชื่อโดเมน) deploy ที่ mirror ทับ `/httpdocs` จึงไม่มีทางลบวีดีโอ
- **Application Startup File:** `app.js` (หรือชื่อไฟล์เข้าแอปจริง)
- **Application Mode:** `production`
- **Custom environment variables:** ใส่ secret ทั้งหมดที่นี่ (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAILS`, `R2_*`, ข้อมูล DB) แทนการวางไฟล์ `.env`
- กด **NPM install** ในหน้า Node.js หลังอัป `package.json` ใหม่ แล้วกด **Restart App** หลัง deploy ทุกครั้ง (หรือ `touch tmp/restart.txt` ใน Application Root)
- Passenger จะส่ง `PORT` มาให้เอง ใช้ `process.env.PORT` และอย่าเรียก `listen` ซ้ำหลายที่

**ทางเลือก deploy ใน Plesk:**
- **FTP** ตามหัวข้อ "Deploy ผ่าน FTP" ด้านบน (ใช้ FTPS ถ้า Plesk รองรับ)
- **Git ใน Plesk** (ถ้าเปิดใช้ได้): เชื่อม repo แล้วตั้ง deploy ไปที่ Application Root มี "Additional deployment actions" ให้รัน `npm ci --omit=dev && touch tmp/restart.txt` ได้ สะอาดกว่า FTP ถ้ามีให้ใช้ ให้แนะนำตัวนี้ก่อน

**ข้อควรระวังเฉพาะ Plesk:**
- Plesk มักมี nginx เป็น proxy หน้า Apache/Passenger ถ้าใช้แบบ C แล้วอัปโหลดไฟล์ใหญ่ไม่ผ่าน (413) ต้องเพิ่ม `client_max_body_size 110m;` ใน Apache & nginx Settings → Additional nginx directives ถ้าบัญชีเราไม่มีสิทธิ์แก้ ให้ไปใช้แบบ B
- ตั้ง SSL (Let's Encrypt ในเมนู SSL/TLS Certificates) ก่อนตั้ง Google OAuth เพราะ redirect URI ต้องเป็น https
- ฐานข้อมูล: สร้าง MySQL/MariaDB จากเมนู Databases ของ Plesk
- ดู error ของแอปได้ที่ Logs ของโดเมน ถ้าแอปไม่ขึ้นหลัง deploy ให้เช็กตรงนี้ก่อน

## Data model (D1)

```sql
CREATE TABLE videos (
  slug        TEXT PRIMARY KEY,   -- 'm01'..'m12', 'ecard-loxley', 'ecard-<company>'
  title       TEXT NOT NULL,      -- ชื่อที่แสดงบนหน้า เช่น 'มกราคม 2570'
  kind        TEXT NOT NULL CHECK (kind IN ('monthly','ecard')),
  sort_order  INTEGER NOT NULL,
  r2_key      TEXT,               -- 'videos/m01/1730000000.mp4' (NULL = ยังไม่อัปโหลด)
  poster_key  TEXT,
  size_bytes  INTEGER,
  updated_at  TEXT,
  updated_by  TEXT                -- อีเมลจาก Access JWT (โปรเจกต์ LOXLEY: username ที่ login)
);
```

Seed 14 แถวไว้ตั้งแต่แรก แม้ยังไม่มีไฟล์ จะได้สร้าง QR ได้ก่อนลูกค้าส่งไฟล์

## กฎสำคัญ (ห้ามพลาด)

> แบบ C: กฎข้อ 1, 2, 5, 7 ใช้ตามเดิม (ข้อ 2 ใช้กับชื่อไฟล์บนดิสก์ `$STORAGE_DIR/videos/<slug>/<epoch>.mp4`) ข้อ 3 ทำผ่าน `res.sendFile`/`express.static` ข้อ 4 แทนด้วยการรับไฟล์แบบ stream ตามหัวข้อ "แบบ B/C" และข้อ 6 แทนด้วยการตรวจ session (Google OAuth หรือ login รหัสผ่าน)

1. **QR ชี้ไปที่ `/v/<slug>` เสมอ ห้ามชี้ไปที่ไฟล์วีดีโอตรง ๆ** เพื่อให้เปลี่ยนวีดีโอได้โดย QR เดิมยังใช้ได้ slug ห้ามเปลี่ยนหลังพิมพ์ QR แล้ว
2. **ตั้งชื่อไฟล์ใน R2 แบบมี timestamp** (`videos/<slug>/<epoch>.mp4`) ไม่เขียนทับชื่อเดิม กันปัญหา cache ค้างเป็นวีดีโอเก่า ลบไฟล์เก่าหลัง commit สำเร็จเท่านั้น
3. **`/media/*` ต้องรองรับ HTTP Range** (ส่ง 206 + `Content-Range`, `Accept-Ranges: bytes`) ไม่งั้น iPhone/Safari เล่นวีดีโอไม่ได้หรือ seek ไม่ได้ ใช้ `env.BUCKET.get(key, { range })` และตั้ง `Cache-Control: public, max-age=31536000, immutable`
4. **อัปโหลดตรงเข้า R2 ด้วย presigned URL** ห้ามส่งไฟล์ผ่าน Function เพราะ request body ของ Worker มีขีดจำกัด และ e-card ใหญ่ถึง 100MB ใช้ `aws4fetch` เซ็น URL กับ R2 S3 API (เก็บ Access Key/Secret เป็น secret ของ Pages) ตั้ง CORS ของ bucket ให้รับ `PUT` จาก domain ของเรา
5. **ตรวจขนาดและชนิดไฟล์ 2 ชั้น**: ฝั่งเบราว์เซอร์ก่อนอัป และฝั่ง server ตอน commit (`HEAD` object ใน R2) monthly ≤ 20MB, ecard ≤ 100MB, `video/mp4` เท่านั้น เกินให้แจ้งข้อความภาษาไทยที่ลูกค้าเข้าใจ
6. **ทุก endpoint ใต้ `/api/admin/*` ต้องตรวจ `Cf-Access-Jwt-Assertion`** กับ JWKS ของทีม (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) และ AUD ของ Access app อย่าเชื่อแค่ว่า Access ครอบ path ไว้แล้ว ใช้อีเมลจาก JWT บันทึกลง `updated_by`
7. **ไม่เก็บ secret ใน repo** ใช้ `wrangler secret put` / ตั้งใน dashboard

## หน้า public `/v/<slug>`

- **ตามเดโม่ที่ลูกค้าเห็นแล้ว:** พื้นดำเต็มจอ วีดีโอแนวนอนกว้างเต็มจอ (เว้นขอบเล็กน้อย) อยู่กึ่งกลางแนวตั้ง ใต้วีดีโอมีข้อความสีทองตัวเล็ก "แตะหน้าจอหนึ่งครั้งเพื่อฟังเสียงบรรยาย"
- `<video playsinline preload="auto" poster="...">` ไม่แสดง controls ของเบราว์เซอร์ ไม่ใช้ `loop`
- **เล่นพร้อมเสียงก่อน แล้วถอยเมื่อถูกบล็อก** (ผู้ใช้เลือกแล้ว 2026-10-24):
  1. ตอนโหลดหน้า เรียก `play()` แบบเปิดเสียง ถ้าสำเร็จ (คอมพิวเตอร์ หรือ browser ที่อนุญาต) ให้เล่นต่อและไม่ต้องแสดงข้อความแนะนำ
  2. ถ้าโดน `NotAllowedError` (มือถือส่วนใหญ่) ให้ตั้ง `muted = true` แล้ว `play()` ใหม่ และแสดงข้อความ "แตะหน้าจอหนึ่งครั้งเพื่อฟังเสียงบรรยาย"
  3. แตะครั้งแรกที่ใดก็ได้ (listener บน `document`) → `currentTime = 0`, `muted = false`, `play()` (**เริ่มใหม่จากต้นพร้อมเสียง**) แล้วซ่อนข้อความแนะนำ
  4. ถ้า autoplay แบบปิดเสียงก็ไม่ทำงาน (โหมดประหยัดแบตเตอรี่, in-app browser บางตัว) การแตะครั้งแรกต้องเริ่มเล่นพร้อมเสียงได้ทันที
- **ไม่มีปุ่มเปิด/ปิดเสียงค้างบนจอ** (ลูกค้าขอเอาออก 2026-10-24) ให้**แตะที่วีดีโอ**เพื่อสลับ `muted` (ไม่ restart) แล้วแสดงไอคอนลำโพง SVG สีทองบนวงกลมดำโปร่งกลางวีดีโอ (มีคลื่นเสียง = เปิด, มีกากบาท = ปิด) ขึ้นทันทีแล้วค่อย ๆ จางหายใน ~0.6 วินาที (`role="status"` + `aria-label` ภาษาไทย) ใช้ตัวต้นแบบได้จากหน้าชั่วคราว `public/v/ecard-lee/index.html` บน server
- **เล่นจบ** (`ended`) → แสดงปุ่ม "ดูอีกครั้ง" กลางวีดีโอ กดแล้ว `currentTime = 0` + `play()` พร้อมเสียงตามสถานะปุ่มเสียงปัจจุบัน
- แสดงชื่อเดือน/ชื่อ e-card ใน `<title>` โทนสีพื้นดำ ตัวหนังสือทอง ฟอนต์ไทยอ่านง่าย
- ถ้ายังไม่มีไฟล์: แสดงข้อความ "วีดีโอเดือนนี้จะเปิดให้ชมเร็ว ๆ นี้" แทนหน้าเปล่า
- ทดสอบใน LINE in-app browser และ Facebook in-app browser ด้วย คนส่วนใหญ่สแกนแล้วเปิดผ่านแอปเหล่านี้

## หน้า CMS `/admin`

- รายการ 14 ชุดเรียงตาม `sort_order` แต่ละแถว: ชื่อ, สถานะ (มีไฟล์/ยังไม่มี), ขนาด, อัปเดตล่าสุดโดยใคร, ปุ่มดูตัวอย่าง, ปุ่มอัปโหลด/เปลี่ยนไฟล์
- แถบ progress ตอนอัปโหลด (ใช้ `XMLHttpRequest` เพราะ fetch ไม่มี upload progress)
- ปุ่มเปิด/คัดลอกลิงก์ `/v/<slug>` และดาวน์โหลด QR ของชุดนั้น
- ข้อความทั้งหมดเป็นภาษาไทย ลูกค้าไม่ใช่สาย tech

## ตั้งค่า Cloudflare Access (ครั้งเดียว)

1. Zero Trust → เลือกแผน Free
2. Settings → Authentication → Login methods → เพิ่ม Google
3. Access → Applications → Add → Self-hosted: ใส่ hostname + path `/admin` และ `/api/admin`
4. Policy: Allow → Emails = อีเมลลูกค้า + อีเมลของเรา (ไม่ใช้ทั้งโดเมน gmail.com)
5. จด Team domain และ Application AUD ไปใส่เป็น env ของ Pages
6. ตรวจว่า Access ครอบ hostname ที่ใช้งานจริงได้ ถ้าใช้ `*.pages.dev` แล้วมีปัญหา ให้ผูก custom domain ก่อน

## ไฟล์ชุดแรก (ถ้าลูกค้าส่งไฟล์มาให้เราอัปเอง)

บีบอัดก่อนอัปเมื่อไฟล์เกินขนาดหรือเป็น codec ที่มือถือเล่นไม่ได้:

```bash
ffmpeg -i input.mov -c:v libx264 -profile:v high -crf 26 -preset slow \
  -vf "scale='min(1080,iw)':-2" -c:a aac -b:a 128k -movflags +faststart output.mp4
```

- ต้องมี `-movflags +faststart` เสมอ วีดีโอจะเริ่มเล่นได้ก่อนโหลดครบ
- ถ้ายังเกิน 20MB ให้เพิ่ม `-crf` ทีละ 2 แล้วเปิดดูว่าซับยังอ่านออก
- อย่าบีบจนตัวหนังสือซับแตก ลูกค้าดูซับเป็นหลัก

## สร้าง QR Code

```bash
npx qrcode -t svg -e Q -o qr/m01.svg "https://<domain>/v/m01"
npx qrcode -t png -e Q -w 2000 -o qr/m01.png "https://<domain>/v/m01"
```

- Error correction ระดับ Q, PNG กว้าง 2000px สำหรับงานพิมพ์ ส่ง SVG คู่ด้วย
- ตั้งชื่อไฟล์ให้ลูกค้าอ่านรู้เรื่อง เช่น `QR-01-มกราคม.png`, `QR-ecard-LOXLEY.png`
- **ทดสอบสแกนทุกอัน** ด้วยมือถือจริงทั้ง iOS และ Android ก่อนส่ง ทั้งจากจอและจากกระดาษที่ปริ้นท์ขนาดจริง

## Checklist ก่อนส่งมอบ

- [ ] ครบ 14 slug ใน D1 และหน้า `/v/<slug>` เปิดได้ทุกหน้า (รวมสถานะยังไม่มีไฟล์)
- [ ] เล่นวีดีโอได้บน iPhone Safari, Android Chrome, LINE in-app browser
- [ ] Seek/เลื่อนวีดีโอได้ (ยืนยันว่า Range ทำงาน)
- [ ] (แบบ B/C) restart แอปแล้วยังทำงาน, `.env` ไม่ถูกเข้าถึงผ่าน URL, deploy รอบใหม่ไม่ลบวีดีโอเดิม
- [ ] เข้า `/admin` ด้วยอีเมลที่ไม่ได้รับอนุญาต (หรือรหัสผ่านผิด) → ถูกบล็อก
- [ ] เรียก `/api/admin/*` ตรง ๆ โดยไม่มี JWT/session → 401/403
- [ ] (login รหัสผ่าน) ใส่รหัสผิด 5 ครั้ง → ถูกล็อก 15 นาที, restart แอปแล้ว session ยังอยู่, เปลี่ยนรหัสผ่านได้
- [ ] `https://wjasmin.site` และ `https://www.wjasmin.site` ใช้ cert ที่ถูกต้อง, http redirect ไป https, โดเมนเปิด auto-renew และแจ้งลูกค้าแล้วว่า QR ขึ้นกับโดเมนนี้
- [ ] หน้า `/v/<slug>` บนมือถือ: เล่นเองแบบปิดเสียง แตะครั้งเดียวเริ่มใหม่พร้อมเสียง แตะวีดีโอแล้วสลับเสียงพร้อมไอคอนที่จางหาย เล่นจบแล้วมีปุ่ม "ดูอีกครั้ง" ทดสอบทั้ง iPhone และ Android (ทั้ง browser ปกติและ LINE) ส่วนบนคอมพิวเตอร์เล่นพร้อมเสียงได้เลย
- [ ] อัปโหลดไฟล์เกินขนาด → ขึ้นข้อความเตือนภาษาไทย ไม่ค้าง
- [ ] เปลี่ยนวีดีโอแล้ว QR เดิมเปิดได้วีดีโอใหม่ ไฟล์เก่าถูกลบจาก R2
- [ ] QR 14 อันสแกนผ่านทั้งหมด
- [ ] เช็กพื้นที่ที่ใช้ (R2 หรือดิสก์ hosting) ประมาณ 440MB สำหรับงานนี้ และโฟลเดอร์วีดีโออยู่นอก Document Root
- [ ] (แบบ C) อัปโหลด e-card 100MB ผ่านจริงบน Plesk ไม่เจอ 413 และมี backup โฟลเดอร์วีดีโอ (Plesk Backup Manager หรือดาวน์โหลดเก็บ)
- [ ] บันทึกวันส่งมอบ และวันครบกำหนดฝากไฟล์ 1 ปี เพื่อแจ้งต่ออายุล่วงหน้า 30 วัน
- [ ] ส่งคู่มือสั้น ๆ ภาษาไทยให้ลูกค้า: วิธีล็อกอิน วิธีอัปโหลด ขนาดไฟล์ที่รับได้

---
name: deploy-plesk
description: Deploy แอป LOXLEY Calendar QR ขึ้น hosting Plesk ผ่าน FTP (ไม่มี SSH) พร้อมขั้นยืนยันกับผู้ใช้ npm install / migrate / restart และ smoke test ใช้เมื่อผู้ใช้สั่ง deploy หรือขั้น Deploy ของ /dev-loop
disable-model-invocation: true
---

# Deploy ขึ้น Plesk (FTP, ไม่มี SSH)

ค่าทั้งหมดอ่านจาก `.env.local` (`FTP_HOST`, `FTP_ACCOUNT_NAME`, `FTP_PASSWORD`) ห้ามพิมพ์ค่าลับออกมาในข้อความหรือ log ไฟล์อาจมี CRLF ให้ตัด `\r` ก่อน source:

```bash
set -a; . <(tr -d '\r' < .env.local | grep -E '^[A-Za-z_][A-Za-z0-9_]*='); set +a
```

## โครงบน server

```
/httpdocs/          ← Application Root (deploy ทับได้)
  app.js, package.json, package-lock.json, src/, migrations/
  public/           ← Document Root
  tmp/restart.txt   ← แตะเพื่อ restart Passenger
/qr-storage/videos/ ← STORAGE_DIR วีดีโอลูกค้า อยู่นอก /httpdocs เพื่อให้ deploy ไม่มีทางลบ
```

FTP ใช้ FTPS ได้ (`curl --ssl-reqd` / `set ftp:ssl-force true` ใน lftp) และ root ของ FTP คือโฟลเดอร์ของ subscription (มี `httpdocs/`, `logs/`)

ตั้งค่าครั้งแรกในหน้า Node.js ของ Plesk (ผู้ใช้ทำเอง): Application Root `/httpdocs`, Document Root `/httpdocs/public` (โฟลเดอร์ต้องมีอยู่ก่อนถึงจะเลือกได้), Startup File `app.js`, Mode `production`, Custom environment variables ใส่ค่าลับทั้งหมด รวม `STORAGE_DIR=../qr-storage` (แอป resolve เทียบกับ Application Root) **ห้ามให้ Document Root = Application Root** เพราะ nginx จะเสิร์ฟ `app.js`, `package.json` และโค้ดทั้งหมดเป็นไฟล์ static

## ขั้นตอน

1. **เช็กก่อน**: working tree สะอาด, `npm test` ผ่าน, รู้ว่า deploy commit ไหน (`git rev-parse --short HEAD`)
2. **Stage**: ล้างแล้วสร้าง `.deploy/` จาก `git archive HEAD` (ไม่เอาไฟล์ที่ไม่ได้ commit) ใส่เฉพาะไฟล์ที่ server ต้องใช้ ห้ามมี `node_modules/`, `.env*`, `test/`, `.claude/`, `docs/` เขียน `.deploy/REVISION` เป็น sha
3. **บอกผู้ใช้แล้วรอยืนยัน**: commit ที่จะ deploy, รายการไฟล์ที่จะอัป/ลบ (dry run), ปลายทาง `/httpdocs/`, `package.json` เปลี่ยนไหม (ถ้าเปลี่ยนต้องกด NPM install), มี migration ใหม่ไหม
4. **อัป**: ใช้ `lftp` mirror ถ้ามี ไม่งั้นใช้ `npm run deploy` (script ที่ใช้ `basic-ftp` ต้องสร้างใน task แรกที่ deploy) ปลายทางต้องเป็น `/httpdocs/` เท่านั้น
   ```bash
   lftp -u "$FTP_ACCOUNT_NAME","$FTP_PASSWORD" "$FTP_HOST" -e "set ftp:ssl-force true; set ssl:verify-certificate no; \
     mirror -R --only-newer --delete --exclude-glob node_modules/ --exclude-glob .env* --exclude-glob tmp/ \
     ./.deploy/ /httpdocs/; quit"
   ```
   (`node_modules/` และ `tmp/` บน server ถูก exclude ไว้ `--delete` จึงไม่ลบ dependency ที่ Plesk ติดตั้งให้)
   **ห้ามชี้ไปที่ `/qr-storage/` หรือ `/` เด็ดขาด** `--delete` จะลบวีดีโอลูกค้า
5. **Dependencies / migration** (ไม่มี SSH ผู้ใช้ต้องกดเอง บอกให้ชัด):
   - `package.json` เปลี่ยน → Plesk → Node.js → **NPM install**
   - มี migration → แท็บ **Run Node.js commands** → `run migrate`
6. **Restart**: อัปไฟล์ว่าง `tmp/restart.txt` ทับผ่าน FTP หรือให้ผู้ใช้กด **Restart App**
7. **Smoke test**: เรียก agent `qa-tester` โหมด `production` ถ้า `FAIL` ให้บอกผู้ใช้ทันที และเสนอ rollback ด้วยการ deploy commit ก่อนหน้า (ทำขั้นตอนเดิมด้วย sha นั้น)
8. **จด**: commit ที่ deploy และเวลา ลงใน task file

## ก่อน deploy ที่เสี่ยง

ถ้ามี migration ที่แก้หรือลบ column หรือแก้โค้ดที่จัดการไฟล์วีดีโอ ให้ผู้ใช้ backup ก่อน: export DB จาก Plesk → Databases และดาวน์โหลด `/qr-storage/` (หรือใช้ Plesk Backup Manager)

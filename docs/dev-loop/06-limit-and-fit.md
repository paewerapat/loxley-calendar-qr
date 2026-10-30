---
status: done   # committed with "Raise monthly limit to 40 MB..." (2026-10-30)
base: d97b457
---
# 06 เพิ่มขีดวีดีโอรายเดือนเป็น 40 MB + วีดีโอพอดีจอทุกแนว

## เป้าหมาย

1. ผู้ใช้ขอเพิ่มขีดของวีดีโอรายเดือนจาก 20 MB เป็น **40 MB** (e-card ยัง 100 MB เท่าเดิม)
2. หน้า `/v/<slug>` ต้องเห็นวีดีโอ**ครบทั้งภาพโดยไม่ต้องเลื่อน** ทุกกรณี ตอนนี้วีดีโอกว้างเต็มจอและ `height: auto` ถ้าหมุนมือถือเป็นแนวนอน (เช่น 844×390) ขอบล่างจะล้นจอ วีดีโอแนวตั้งที่เปิดบนคอมก็ล้นเหมือนกัน

## Acceptance criteria

- [ ] AC1 **ขีด monthly = 40 MiB (41,943,040 bytes)** ที่ค่าคงที่ตัวเดียวใน `src/videos.js` และให้ทุกชั้นใช้ค่านี้: server (busboy + `checkVideoFile`), Content-Length precheck, เบราว์เซอร์ (data attribute), CLI `video:set` ส่วน ecard ยัง 100 MiB
  - ขอบเขต: 41,943,040 bytes ผ่าน +1 ไม่ผ่าน ทั้ง 3 ชั้น
- [ ] AC2 **ข้อความที่ลูกค้าเห็นเป็น "40 MB"** ทุกจุด: หน้า admin (ข้อความแนะนำด้านบน และ "รับไฟล์" บนการ์ด), API `limitLabel`, ข้อความ error `too_large`, คู่มือลูกค้าใน README และหัวข้ออื่นใน README ที่พูดถึงขีดรายเดือน (ส่วนของ operator ใช้ MiB ได้) ห้ามมี "20 MB" ของรายเดือนเหลืออยู่ใน `src/`, `public/`, `README.md`
- [ ] AC3 **player พอดีจอ** (`public/assets/player.css` เท่านั้น ไม่แก้ `player.js` หรือ markup ยกเว้นจำเป็นจริง):
  - วีดีโอทุกสัดส่วน (16:9, 4:3, 1:1, 9:16) แสดงครบทั้งภาพโดยไม่มี scroll ทั้งแนวตั้งและแนวนอน ที่ viewport 390×844, 844×390, 1280×720, 1920×1080 และ 360×640
  - ข้อความแนะนำ "แตะหน้าจอ…" ยังอยู่ใต้วีดีโอและอยู่ในจอ (เช่น `max-height` ของวีดีโอ = `100dvh` ลบพื้นที่ของ hint + ระยะขอบ มี fallback เป็น `100vh` และใช้ `object-fit: contain` หรือ shrink-wrap ที่ `.stage`)
  - ไอคอนลำโพงและปุ่ม "ดูอีกครั้ง" ยังอยู่กึ่งกลางของ**ตัววีดีโอ**ไม่ใช่กึ่งกลางกล่องที่กว้างกว่า แตะที่วีดีโอยังสลับเสียงได้
  - วีดีโอ 16:9 บนมือถือแนวตั้งยังกว้างเต็มจอ (ลบขอบ 16px) เหมือนเดิม ไม่เล็กลง
  - `?v=` ของ player.css เปลี่ยนตามเนื้อไฟล์ (มีกลไกเดิมอยู่แล้ว)
- [ ] AC4 **Test:**
  - `npm test` ผ่านทั้งหมด
  - test ที่ตรวจ 20 MiB / "20 MB" ของรายเดือน รวมไฟล์ `test/qa-*.test.js` ให้แก้เป็น 40 MiB / "40 MB" ได้ เพราะ requirement เปลี่ยน แต่ห้ามลดสิ่งที่ตรวจ ต้องยังมี test ขอบเขตพอดีขีด และ +1 สำหรับทั้ง monthly และ ecard ให้รายงานทุกจุดที่แก้ในไฟล์ QA
  - เพิ่ม test ที่ตรวจ CSS ของ player (static) ว่ามีการจำกัดความสูงตาม viewport และ `object-fit` / shrink-wrap
- [ ] AC5 **ภาพหน้าจอ** ของ `/v/<slug>` ที่มีวีดีโอจริง (copy `e-card/e-card lee.mp4` เข้า STORAGE_DIR ของ loxley_dev แล้วใช้ `video:set:dev`) ที่ 390×844, 844×390, 1280×720 ด้วยวิธีเดิม (`shot.mjs` + Chrome headless ของ Windows) บันทึกลง `C:\Users\werapat\AppData\Local\Temp\claude\--wsl-localhost-Ubuntu-home-lamood-fastwork-loxley-calendar-qr\5c10a88b-8a2d-4da3-8f7f-e2c7e9ed2be4\scratchpad\ui\` (ชื่อ `player-*.png`) ภาพต้องไม่มี scrollbar และเห็นขอบวีดีโอครบ จากนั้นคืนสภาพ loxley_dev

## นอกขอบเขต

ขีด e-card, การทำงานของ player, หลังบ้านส่วนอื่น, deploy

## Log

### รอบ 1

- Dev: ทำครบ AC1–AC5 test 374/374
  - `SIZE_LIMITS.monthly` เป็น 40 MiB ทุกชั้นใช้ค่านี้อยู่แล้ว
  - player.css: `max-height: calc(100dvh - var(--chrome))`, `object-fit: contain` และ body ตั้ง `overflow: hidden`
  - วัด 4 สัดส่วน × 5 viewport ผ่าน 20/20 ภาพอยู่ใน `scratchpad/ui/player-*.png`
  - แก้ assertion ในไฟล์ QA 9 จุด เปลี่ยนแค่ 20 → 40 เพราะ requirement เปลี่ยน ขอบเขตพอดีขีดและ +1 ยังครอบทั้ง 3 ชั้นจาก `SIZE_LIMITS`
- Lead: ดูภาพแนวนอนและแนวตั้งแล้ว ถูกต้อง รัน test เองได้ 374/374 ไม่มี "20 MB" เหลือ เป็นการแก้เล็กที่มี test ครอบ จึงไม่เปิดรอบ QA/Review เต็ม → commit

## ค้างไว้

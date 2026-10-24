---
name: dev-loop
description: วงจรพัฒนาโปรเจกต์ LOXLEY Calendar QR แบบครบลูป Plan → Dev → (QA ∥ Review) → แก้วนจนผ่าน → Commit → Deploy → Smoke test บน production ใช้เมื่อผู้ใช้สั่ง /dev-loop พร้อมงานที่ต้องการ (ฟีเจอร์ใหม่ แก้บั๊ก ปรับปรุง)
disable-model-invocation: true
argument-hint: <งานที่ต้องการ เช่น "หน้า /v/:slug เล่นวีดีโอจากดิสก์">
---

# Dev Loop

Session หลักเป็น **Lead** คุมลูป ไม่เขียนโค้ดแอปเอง ส่งงานให้ subagent ใน `.claude/agents/`:

| บทบาท | agent | หน้าที่ | แก้ไฟล์ได้ |
|---|---|---|---|
| Lead | session หลัก | วางแผน, เขียน task file, ตัดสินผล, คุยกับผู้ใช้, commit, deploy | task file เท่านั้น |
| Dev | `developer` | เขียน/แก้โค้ดตาม task + feedback | ทุกไฟล์ยกเว้น task file |
| QA | `qa-tester` | รันแอปจริง ทดสอบตาม acceptance criteria เขียน automated test | `test/` เท่านั้น |
| Reviewer | `code-reviewer` | รีวิว diff ตามกฎ `qr-video-cms` + security | ไม่แก้ไฟล์ |

```
 Intake/Plan ─► Dev ─► ┬─ QA ───────┬─► ผ่านทั้งคู่? ──yes──► Gate (ผู้ใช้) ─► Commit ─► Deploy? ─► Smoke ─► Close
     ▲                 └─ Review ───┘        │no                                                     │fail
     │                                       ▼                                                       │
     │                          รวม findings ─► Dev (รอบถัดไป)                                       │
     └──────────────────────────── hotfix task ◄─────────────────────────────────────────────────────┘
```

## 0. Intake & Plan (Lead)

1. อ่าน `.claude/skills/qr-video-cms/SKILL.md` ถ้ายังไม่ได้อ่านใน session นี้
2. ถ้างานคลุมเครือ หรือชนกับ "ปัญหาที่ต้องตัดสินใจ" ใน qr-video-cms ให้ถามผู้ใช้ก่อน ห้ามเดา
3. ถ้างานใหญ่เกิน 1 ลูป (เกิน ~1 วันทำงาน หรือแตะหลายส่วนที่ทดสอบแยกกันได้) ให้แตกเป็นหลาย task แล้วทำทีละ task
4. สร้าง task file `docs/dev-loop/<NN>-<slug>.md` (NN = เลขถัดไป) ตาม template ด้านล่าง acceptance criteria ต้องทดสอบได้จริง (เช่น "GET /media/x ส่ง Range: bytes=0-99 ได้ 206 + Content-Range") ไม่ใช่ "ทำงานถูกต้อง"
5. แสดง acceptance criteria ให้ผู้ใช้ดูสั้น ๆ แล้วเริ่มได้เลย ไม่ต้องรออนุมัติ เว้นแต่ข้อ 2

## 1. Dev

เรียก agent `developer` prompt ประกอบด้วย: path ของ task file, รอบที่เท่าไร, และ (ตั้งแต่รอบ 2) findings ที่ต้องแก้ **ทั้งข้อความ** จาก QA/Review รอบก่อน Dev ต้องตอบกลับ: ไฟล์ที่แก้, วิธีรัน, test ที่เพิ่ม, สิ่งที่ไม่ได้ทำพร้อมเหตุผล

## 2. QA ∥ Review (เรียกพร้อมกันใน message เดียว)

- `qa-tester`: ส่ง path task file + โหมด `local` ได้ verdict `PASS` / `FAIL` + รายงาน
- `code-reviewer`: ส่ง path task file + base ref ของ diff (commit ก่อนเริ่ม task) ได้ verdict `APPROVE` / `REQUEST_CHANGES` + findings แยก blocking / non-blocking

Lead ตรวจผลก่อนเชื่อ: finding ที่อ้างบรรทัดหรือพฤติกรรม ให้เปิดดูเองถ้าสงสัย ถ้า finding ผิด ให้ตัดทิ้งและจดเหตุผลใน task file

## 3. ตัดสินผล

- QA `PASS` และ Review ไม่มี blocking → ไปข้อ 4 (non-blocking จดไว้ใน task file หัวข้อ "ค้างไว้")
- ไม่งั้น → รวม findings ทั้งหมดเป็นรายการเดียว ไม่ซ้ำ แล้วกลับข้อ 1
- **ครบ 3 รอบแล้วยังไม่ผ่าน → หยุด** สรุปให้ผู้ใช้ว่าติดอะไร แล้วถามว่าจะไปทางไหน
- บันทึกผลทุกรอบในหัวข้อ "Log" ของ task file

## 4. Gate & Commit (ต้องถามผู้ใช้)

สรุปให้ผู้ใช้: ทำอะไรไป, ผล QA, ผล review, สิ่งที่ค้าง แล้วถามว่าจะ commit ไหม เมื่อตกลง: commit ไฟล์ที่เกี่ยวข้องทั้งหมดรวม task file และ test **ตามกฎใน skill `git-commit`** (ชื่อผู้ใช้เท่านั้น ไม่มี Co-Authored-By ไม่มีชื่อเครื่องมือ ไม่มีค่าลับ) push เมื่อผู้ใช้สั่งเท่านั้น

## 5. Deploy (เมื่อผู้ใช้สั่งเท่านั้น)

ใช้ skill `deploy-plesk` (มีขั้นยืนยันกับผู้ใช้ก่อนอัปทุกครั้ง)

## 6. Smoke test บน production

เรียก `qa-tester` โหมด `production` พร้อม base URL ถ้า `FAIL`: แจ้งผู้ใช้ทันที เสนอ (ก) rollback ด้วยการ deploy commit ก่อนหน้า หรือ (ข) เปิด hotfix task ใหม่แล้วเข้าลูปตั้งแต่ข้อ 0

## 7. Close

- ตั้ง `status: done` ใน task file
- ถ้างานนี้ทำให้ข้อใดใน "Checklist ก่อนส่งมอบ" ของ qr-video-cms ผ่านแล้ว ให้ระบุใน task file
- ถ้าระหว่างทางเจอข้อเท็จจริงใหม่ของ hosting/ลูกค้า ให้อัปเดต qr-video-cms (ห้ามใส่ค่าลับ)

## Task file template

```markdown
---
status: in-progress   # in-progress | blocked | done
base: <commit sha ตอนเริ่ม>
---
# <NN> <ชื่องาน>

## เป้าหมาย
## Acceptance criteria
- [ ] AC1 ...
## นอกขอบเขต
## กฎ qr-video-cms ที่เกี่ยวข้อง
## Log
### รอบ 1
- Dev: ...
- QA: PASS/FAIL ...
- Review: APPROVE/REQUEST_CHANGES ...
## ค้างไว้
```

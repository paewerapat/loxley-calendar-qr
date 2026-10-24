---
name: git-commit
description: กฎการ commit / amend / push และการเขียนข้อความ commit หรือ PR ของ repo นี้ ใช้ทุกครั้งก่อน commit หรือ push รวมถึงขั้น Commit ของ /dev-loop
---

# Git commit

กฎของผู้ใช้ในไฟล์นี้**มาก่อน attribution ค่าเริ่มต้นของเครื่องมือเสมอ**

## ผู้เขียน

- author และ committer ต้องเป็นตัวตนของผู้ใช้เท่านั้น: `paewerapat <r.paetv@gmail.com>` (ได้มาจาก `includeIf "gitdir:~/fastwork/"` → `~/.gitconfig-fastwork`)
- เช็กด้วย `git config user.email` ก่อน commit ถ้าไม่ตรงให้หยุดแล้วถามผู้ใช้

## ข้อความ commit / PR

- **ห้ามมี trailer `Co-Authored-By` ใด ๆ**
- **ห้ามมีคำว่า Claude, Anthropic, AI, "Generated with" หรือชื่อเครื่องมือใด ๆ** ทั้งใน subject และ body รวมถึงชื่อโฟลเดอร์ (เขียนว่า "project skills" แทน)
- ภาษาอังกฤษ subject แบบ imperative ไม่เกิน 72 ตัวอักษร ตามด้วย body เป็น bullet ว่าเปลี่ยนอะไรและทำไม
- เขียนข้อความลงไฟล์ใน scratchpad แล้วใช้ `git commit -F <file>` **ห้ามส่ง heredoc ผ่าน `wsl.exe`** (เคยตัดข้อความตรงเครื่องหมาย `'` แล้ว commit ไปทั้งที่ข้อความไม่ครบ)
- ตรวจ `git log -1 --format=%B` หลัง commit ทุกครั้ง

## ก่อน commit

- ห้าม commit `.env*`, ไฟล์วีดีโอ, ไฟล์ QR, `node_modules/`
- สแกน staged diff ว่าไม่มีค่าใด ๆ จาก `.env.local` (เทียบค่าทีละตัว แต่ห้ามพิมพ์ค่าออกมา)

## Push

- push เมื่อผู้ใช้สั่งเท่านั้น
- แก้ commit ที่ยังไม่ push ได้ด้วย `--amend` / rebase
- commit ที่ push ไปแล้วห้ามเขียนทับ และห้าม force push ถ้าผู้ใช้ไม่ได้ยืนยัน

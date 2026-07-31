# วิธีพรีวิวเกมบนเครื่องตัวเอง (ไม่ต้องรอ Railway)

โปรเจกต์นี้มี dev server ในตัวอยู่แล้ว (Vite) — แก้โค้ดแล้วเห็นผล**ภายใน 1-2 วินาที**
ในเบราว์เซอร์ ไม่ต้อง push ไม่ต้อง deploy ใด ๆ ทั้งสิ้น
Deploy ขึ้น Railway เฉพาะตอนพอใจแล้วเท่านั้น

## ติดตั้งครั้งแรก (ทำครั้งเดียว)

1. ติดตั้ง Node.js (ถ้ายังไม่มี) — โหลดจาก https://nodejs.org (เอาตัว LTS)
   หรือถ้าใช้ Homebrew: `brew install node`
2. เปิด Terminal เข้าโฟลเดอร์โปรเจกต์:

   ```
   cd path/to/duneflow
   npm install
   ```

## ใช้งานประจำวัน

```
npm run dev
```

แล้วเปิด Chrome ไปที่ **http://localhost:5173**

- แก้ไฟล์ .js → หน้าเว็บอัปเดตเองแทบจะทันที (hot reload)
- แก้ไฟล์ .wgsl (shader) → หน้าเว็บ**รีโหลดเอง**อัตโนมัติ (bake ใหม่ ~ไม่กี่วินาที)
- ปิดด้วย Ctrl+C ใน Terminal

หมายเหตุ: WebGPU ใช้บน localhost ได้ปกติ (นับเป็น secure context)
ต้องเป็น Chrome / Edge — Safari บางเวอร์ชันยังไม่รองรับ WebGPU เต็มรูปแบบ

## จะดูจากมือถือในวง Wi-Fi เดียวกัน

```
npm run dev -- --host
```

Terminal จะโชว์ URL แบบ `http://192.168.x.x:5173` — เปิดจากมือถือได้เลย
(WebGPU บนมือถือต้องเป็น Chrome for Android; ผ่าน http ในวงแลนบางเครื่อง
อาจไม่ยอมเปิด WebGPU — ถ้าเจอ ให้ทดสอบบนเดสก์ท็อปเป็นหลัก)

## เวิร์กโฟลว์ที่แนะนำ

1. `npm run dev` ค้างไว้ตลอด
2. แก้โค้ด → สลับไปดูเบราว์เซอร์ → วนไป
3. พอใจแล้วค่อย commit + push ผ่าน GitHub Desktop → Railway deploy เอง

# DUNEFLOW — สถาปัตยกรรม, การแปลงจากหิมะเป็นทะเลทราย, และ Roadmap

> แปลงมาจาก SNOWFLOW (MIT, Maksymilian Dendura) — WebGPU + Babylon.js + WGSL เขียนมือ
> รันด้วย `npm install && npm run dev` (ต้องใช้เบราว์เซอร์เดสก์ท็อปที่รองรับ WebGPU)

---

## 1. สิ่งที่ถูกแปลงเป็นทะเลทราย (Reskin)

| จุด | ไฟล์ | รายละเอียด |
|---|---|---|
| สีพื้นทราย | `src/shaders/snow.fragment.wgsl` | albedo หลัก → ทรายทองอุ่น, ทรายอัดแน่น → น้ำตาลเข้ม, ทรายที่ถูกเหวี่ยง (berm) → สว่างอุ่น, เงาหลุม → amber แทน blue |
| แสงทะลุสันดูน | `src/shaders/lib/shading.wgsl` | subsurface tint จากฟ้า → ส้ม-amber (rim light สไตล์หนัง Dune) |
| ฝุ่นทราย | `src/shaders/spray.fragment.wgsl` | สี grain ลอย → dust สีทราย |
| **Ice channel → Spice glaze** | `snow.fragment.wgsl` | channel น้ำแข็งเดิมกลายเป็น "คราบสไปซ์" สี cinnamon เงาสะท้อน — ใช้เป็น marker ของแหล่งสไปซ์ในเกม |
| Crystal → Spice crystal | `src/shaders/crystal.fragment.wgsl` | สกิล Crystallise ปลูก "ผลึกสไปซ์" แก้ว amber แทนน้ำแข็งฟ้า |
| แสงสะท้อนพื้น→ท้องฟ้า | `src/render/sky.js` | ground-bounce albedo หิมะ (0.83–0.91) → ทราย (0.58/0.47/0.33) ทำให้ขอบฟ้าอุ่นทั้ง LUT/SH โดยอัตโนมัติ |
| ค่าตั้งต้นบรรยากาศ | `src/core/settings.js` | ดวงอาทิตย์ 19°, หมอกฝุ่นหนาขึ้น, glint เบาลง, SSS เบาลง, ทราย refill เร็วขึ้น (1.7) รอยเท้าตื้นลง |
| ชุดตัวละคร | `src/character/character.js` | PALETTE → เสื้อคลุมทะเลทรายเกือบดำ + mantle tan + trim สี spice amber + fur ซีดแดด |
| Branding | `index.html` | DUNEFLOW / "a study in sand" + จานสี CSS อุ่นทั้ง boot screen |

**ที่ไม่ได้แตะโดยเจตนา:** สกิลน้ำยังเป็นน้ำ (น้ำคือของมีค่าใน Dune — bending น้ำเข้าธีมพอดี), ระบบ terrain/clipmap/deformation/shadow/post ทั้งหมดเหมือนเดิม 100%

---

## 2. Gameplay Layer ใหม่ (`src/game/`)

หลักการ: **เกมแตะ engine ผ่าน seam สาธารณะเท่านั้น** — `deform.brush()`, `spray.emit()`, `rig.addTrauma()`, `terrain.heightAt()`, `controller.position` — ไม่มี mesh/pipeline/shader ใหม่แม้แต่ตัวเดียว จึงถอดออก/แก้เนื้อเรื่องภายหลังได้โดยไม่กระทบ engine

```
src/game/
  game.js    orchestrator — ประกอบทุกอย่าง, ถูกเรียกจาก main.js เฟรมละครั้ง
  spice.js   แหล่งสไปซ์ 14 จุด: คราบ glaze เงาสะท้อน + ประกาย "spice blow"
             เดินเข้าใกล้ < 2 ม. = เก็บ (+3..7) → เกิดใหม่ที่อื่นใน 45 วิ
  worm.js    หนอนทราย: การเคลื่อนไหวสร้าง "เสียง" — ยืนเงียบ, เดินแทบไม่ดัง,
             วิ่งดัง, sand-surf ดังมาก → มิเตอร์เต็ม 0.55 หนอนโผล่ 110–170 ม.
             แล้ววิ่งเข้าหา "เสียง" (ไม่ใช่ตำแหน่ง!) — หยุดนิ่ง/เดินช้า 6 วิ
             = มันหลงทางแล้วมุดกลับ นี่คือกลไก "เดินไร้จังหวะ" ของหนัง
             ถ้าโดนจับ: ถูกเหวี่ยง 70 ม., เสียสไปซ์ครึ่งหนึ่ง (ยังไม่มีตาย —
             รอเนื้อเรื่อง)
  hud.js     DOM overlay: ตัวนับสไปซ์, มิเตอร์ wormsign, toast ข้อความ
```

**การแสดงผลหนอนโดยไม่มี mesh:** สันทรายวิ่ง = brush berm ต่อเนื่อง (แบบเดียวกับร่อง surf), พวยฝุ่น = spray pool เดิม, แรงสั่น = trauma ของ camera rig — ทั้งหมดคือระบบที่มีอยู่แล้ว

**จุดต่อใน `main.js`:** `game.update(dt)` ถูกเรียกหลัง `contact.update` ก่อน `rig.update` (เพื่อให้กล้องตามตำแหน่งใหม่ทันทีเมื่อถูกหนอนเหวี่ยง) และ expose ที่ `SNOWFLOW.game` สำหรับ debug

---

## 3. สถาปัตยกรรม engine ที่ต้องรู้ก่อนแก้ (6 กฎเหล็ก)

1. **Vertex buffer ไม่มีตำแหน่งจริง** — terrain/ตัวละคร/wake/spray เก็บแค่ index, vertex shader คำนวณตำแหน่งทั้งหมด → shadow pass และ depth prepass จึงต้องเขียนเอง ห้ามใช้ของ Babylon
2. **Terrain state buffer คือหัวใจ** — RGBA16F 2048² ครอบ 80 ม. รอบผู้เล่น, addressing แบบ toroidal, 4 channel: depth (บวกสะสม), berm (บวกสะสม), compression (บวกสะสม), **spice-glaze (max — stamp ซ้ำได้ปลอดภัย)** ทุกอย่างเขียนผ่าน `deform.brush()` ตัวเดียว สูงสุด 96 brush/เฟรม
   ⚠️ buffer หมุนตามผู้เล่น — รอยที่เลื่อนออกนอกหน้าต่าง 80 ม. **จะหายถาวร** ถ้าต้องการ mark ถาวรต้อง re-stamp (ดูวิธีใน `spice.js`)
3. **Zero allocation ใน render loop** — ห้าม `new` อะไรในเฟรม จะเห็น GC spike ทันทีในกราฟ F1
4. **Warm-up ทุก pipeline หลัง loading screen** — material ใหม่ต้องผ่าน `whenReady()` + ถูก**วาดจริง** (ดูคำเตือนใน `waterBody.warmUp`)
5. **ลำดับใน render loop เป็น load-bearing** — spells ก่อน terrain, figure.sync หลัง shadow refit, post.update ก่อนทุกอย่างที่อ่าน transform — มีคอมเมนต์กำกับทุกจุดใน `main.js`
6. **หนึ่งระบบ หนึ่ง draw call** — ก่อนสร้าง mesh ใหม่ ถามก่อนว่า reuse water strand (มี 8 slot), crystal pool (96 ต้น), หรือ spray pool (5120 เม็ด) ได้ไหม

---

## 4. Roadmap ที่แนะนำ (เรียงตามความคุ้ม)

**เฟส 1 — เกมลูปให้แน่น (ไม่ต้องแตะ shader):**
- [ ] เข็มทิศ/สแกนเนอร์ชี้สไปซ์ใกล้สุด (มี `spiceField.nearestDistance()` รอไว้แล้ว)
- [ ] ระบบใช้สไปซ์: แลกเป็นพลังสกิล / stamina สำหรับ sprint
- [ ] Day-night: ผูก `S.sunAzimuth/sunElevation` กับเวลาเกม (sky rebake อัตโนมัติเมื่อค่าเปลี่ยนอยู่แล้ว) — กลางคืนหนอนไวขึ้น
- [ ] เสียง (ยังไม่มีเลยทั้งโปรเจค): rumble หนอน, ลม, เก็บสไปซ์

**เฟส 2 — โลกและเนื้อเรื่อง:**
- [ ] Sietch/จุด safe zone: วงหินที่หนอนเข้าไม่ได้ (เช็คระยะจากจุด = พอ)
- [ ] NPC/objective marker แบบง่าย (billboard ผ่าน spray-style mesh ใหม่ 1 pipeline)
- [ ] Save/load: state มีแค่ spice + ตำแหน่ง → localStorage ไม่กี่บรรทัด
- [ ] Thumper: วางเครื่องล่อเสียง → ดึงหนอนออกจากเส้นทาง (แค่ย้าย target ของ worm)

**เฟส 3 — งานหนัก:**
- [ ] หนอนแบบมี mesh จริง (procedural segment ตามแนวทาง character/build.js)
- [ ] พายุทราย: fogDensity + windStrength ramp + spray มวลใหญ่
- [ ] Mobile/WebGL fallback — งานใหญ่สุดเพราะทุกอย่างเป็น WGSL; มีโครง `PRESETS.balanced` รอไว้

**จุดเปราะเมื่ออัปเกรด Babylon:** `gpuUtil.js:bindMatrixArray()` และ `postChain.js` แตะ private field (`_matrixArrays`, `_forcedOutputTexture`) — ตรวจก่อนทุกครั้งที่ bump เวอร์ชัน

---

## 5. คอนโซล debug

```js
SNOWFLOW.game.spice = 100          // เพิ่มสไปซ์
SNOWFLOW.game.worm.noise = 0.6     // เรียกหนอนทันที
SNOWFLOW.game.worm.distance        // ระยะหนอน
SNOWFLOW.spells.cast(4)            // ปลูกผลึกสไปซ์
SNOWFLOW.S.sunElevation = 8        // พระอาทิตย์ตกทะเลทราย (rebake อัตโนมัติ)
```
กด `F1` เปิด overlay ปรับทุกพารามิเตอร์สด

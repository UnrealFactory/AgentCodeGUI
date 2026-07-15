'use strict'
// Generates build/icon.ico (+ build/icon.png) for the installer, exe, taskbar and
// the "AgentCodeGUI로 열기" context-menu entry — no image dependencies.
//
// 2.0 mark = the app itself in miniature: a dark card (#191919, "창이 곧 카드") with a
// hairline ring and the near-white mascot robot glyph (IconMascot의 24-unit 패스 그대로).
// Each size is rasterised at 4× and box-downsampled for smooth edges, then PNG-encoded
// and packed into a multi-resolution .ico (PNG-compressed entries).
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const BG = [0x19, 0x19, 0x19] // dark card (앱 창 표면)
const FG = [0xe9, 0xe9, 0xe9] // near-white mascot (--accent)
const RING = [0x4b, 0x4b, 0x4b] // hairline ring ≈ white 22% over the card
const SS = 4 // supersample factor

// distance from point p to segment a–b
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

// min distance from p to a polyline (round caps/joins fall out of the segment min)
function polyDist(px, py, pts) {
  let d = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const v = segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
    if (v < d) d = v
  }
  return d
}

// flatten a quadratic bézier into a polyline
function quad(p0, p1, p2, n = 16) {
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
    ])
  }
  return pts
}

// flatten a cubic bézier into a polyline
function cubic(p0, p1, p2, p3, n = 16) {
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ])
  }
  return pts
}

// Render an S×S RGBA icon (4× supersampled internally).
function render(S) {
  const hi = S * SS
  const f = hi / 256 // everything below is authored in a 256-unit space
  const inset = 16 * f
  const radius = 54 * f
  const cx = hi / 2
  const cy = hi / 2
  const halfW = hi / 2 - inset
  const halfH = hi / 2 - inset
  const ringHw = 2.4 * f // hairline ring half-width (경계 안쪽으로 그린다)

  // 마스코트 — IconMascot(icons.tsx)의 24-unit 패스를 그대로, 시각 중심(12, 11.4)을
  // 카드 중심에 맞춰 확대한다. 아이콘 가독을 위해 스트로크는 svg 1.5 → 2.0 unit.
  const k = 8.6 * f // 1 svg unit
  const C = 128 * f
  const mx = (u) => C + (u - 12) * k
  const my = (u) => C + (u - 11.4) * k
  const P = (x, y) => [mx(x), my(y)]
  // 굵은 스트로크(2.0 unit)에선 귀가 머리 옆면에 붙어 한 덩이로 보인다 — 귀만
  // 0.4 unit 바깥으로 밀고 조금 얇게(0.8) 그려 svg의 열린 아크 느낌을 지킨다
  const antennae = [
    quad(P(9.5, 8), P(9, 5.8), P(7.3, 4.9)), // 왼 더듬이
    quad(P(14.5, 8), P(15, 5.8), P(16.7, 4.9)) // 오른 더듬이
  ]
  const ears = [
    cubic(P(4.0, 10.6), P(2.6, 11.5), P(2.6, 14.5), P(4.0, 15.4)), // 왼 귀
    cubic(P(20.0, 10.6), P(21.4, 11.5), P(21.4, 14.5), P(20.0, 15.4)) // 오른 귀
  ]
  const dots = [
    [mx(10.2), my(13), 1.0 * k], // 눈
    [mx(13.8), my(13), 1.0 * k],
    [mx(7), my(4.7), 0.9 * k], // 더듬이 점
    [mx(17), my(4.7), 0.9 * k]
  ]
  // 머리 — rx 4.5의 라운드 사각 외곽선 (SDF의 |sd|가 곧 경계까지의 거리)
  const headCx = mx(12)
  const headCy = my(13)
  const headHw = 6.5 * k
  const headHh = 5 * k
  const headR = 4.5 * k
  const hw = 1.0 * k // glyph half stroke width

  const headDist = (px, py) => {
    const qx = Math.abs(px - headCx) - (headHw - headR)
    const qy = Math.abs(py - headCy) - (headHh - headR)
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - headR
    return Math.abs(sd)
  }

  const buf = Buffer.alloc(hi * hi * 4)
  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      // rounded-rect signed distance (negative inside)
      const qx = Math.abs(x + 0.5 - cx) - (halfW - radius)
      const qy = Math.abs(y + 0.5 - cy) - (halfH - radius)
      const ox = Math.max(qx, 0)
      const oy = Math.max(qy, 0)
      const sd = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
      const i = (y * hi + x) * 4
      if (sd <= 0) {
        const px = x + 0.5
        const py = y + 0.5
        let d = headDist(px, py)
        for (const s of antennae) {
          const v = polyDist(px, py, s)
          if (v < d) d = v
        }
        let glyph = d <= hw
        if (!glyph) {
          for (const s of ears) {
            if (polyDist(px, py, s) <= 0.8 * k) {
              glyph = true
              break
            }
          }
        }
        if (!glyph) {
          for (const [dcx, dcy, dr] of dots) {
            if (Math.hypot(px - dcx, py - dcy) <= dr) {
              glyph = true
              break
            }
          }
        }
        // 카드 표면 → 경계 헤어라인 링 → 글리프 순으로 얹는다
        const col = glyph ? FG : -sd <= ringHw ? RING : BG
        buf[i] = col[0]
        buf[i + 1] = col[1]
        buf[i + 2] = col[2]
        buf[i + 3] = 0xff
      } // else fully transparent (already zeroed)
    }
  }

  // box-downsample 4×4 → S×S
  const out = Buffer.alloc(S * S * 4)
  const n = SS * SS
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0
      let gg = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * hi + (x * SS + dx)) * 4
          // premultiply so transparent (0,0,0,0) samples don't darken the edge
          const al = buf[i + 3]
          r += buf[i] * al
          gg += buf[i + 1] * al
          b += buf[i + 2] * al
          a += al
        }
      }
      const o = (y * S + x) * 4
      const av = a / n
      out[o] = a ? Math.round(r / a) : 0
      out[o + 1] = a ? Math.round(gg / a) : 0
      out[o + 2] = a ? Math.round(b / a) : 0
      out[o + 3] = Math.round(av)
    }
  }
  return out
}

// ── PNG encoder (RGBA, filter 0) ─────────────────────────────────────────────
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function pngEncode(S, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const raw = Buffer.alloc(S * (S * 4 + 1))
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ── ICO container (PNG-compressed entries) ───────────────────────────────────
function icoEncode(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  const blobs = []
  let offset = 6 + images.length * 16
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // palette
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bit count
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
    blobs.push(png)
  }
  return Buffer.concat([header, ...entries, ...blobs])
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((size) => ({ size, png: pngEncode(size, render(size)) }))

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.ico'), icoEncode(images))
fs.writeFileSync(path.join(outDir, 'icon.png'), images[images.length - 1].png) // 256×256
console.log('[gen-icon] wrote build/icon.ico (' + sizes.join(',') + ') + build/icon.png')

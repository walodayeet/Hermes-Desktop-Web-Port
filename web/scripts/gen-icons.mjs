// Generates public/icon-192.png and public/icon-512.png (amber "H" on dark
// rounded square). Dependency-free: raw RGBA + zlib deflate + hand-rolled PNG.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'public')

let crcTable
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4)
  const BG = [15, 17, 21, 255]
  const AMBER = [245, 158, 11, 255]
  const r = size * 0.22
  const inRounded = (x, y) => {
    const dx = x < r ? r - x : x >= size - r ? x - (size - r - 1) : 0
    const dy = y < r ? r - y : y >= size - r ? y - (size - r - 1) : 0
    return dx * dx + dy * dy <= r * r
  }
  const m = size * 0.24 // left/right margin of vertical bars
  const barW = size * 0.16
  const mid = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!inRounded(x, y)) {
        px[i + 3] = 0
        continue
      }
      const inVLeft = x >= m && x <= m + barW && y >= m && y <= size - m
      const inVRight = x >= size - m - barW && x <= size - m && y >= m && y <= size - m
      const inH = y >= mid - barW / 2 && y <= mid + barW / 2 && x >= m && x <= size - m
      const c = inVLeft || inVRight || inH ? AMBER : BG
      px[i] = c[0]
      px[i + 1] = c[1]
      px[i + 2] = c[2]
      px[i + 3] = c[3]
    }
  }
  return px
}

mkdirSync(outDir, { recursive: true })
for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), encodePNG(size, draw(size)))
  console.log(`wrote icon-${size}.png`)
}

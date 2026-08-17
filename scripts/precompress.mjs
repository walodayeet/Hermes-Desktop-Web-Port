#!/usr/bin/env node
/**
 * precompress.mjs — emit .gz + .br next to every static asset in web/dist.
 *
 * The web port's proxy serves precompressed variants when present (see
 * serveStatic in proxy/server.js): the Docker image then carries the
 * compressed bytes instead of the proxy compressing a 19MB shiki chunk per
 * request. Zero-dependency: node:zlib only.
 *
 * Skips: index.html (SPA fallback, re-fetched per load — tiny), .map files,
 * already-compressed assets (png/jpg/jpeg/gif/webp/ico/woff2), and files
 * smaller than 1KB (compression overhead not worth it).
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'

const ROOT = process.argv[2] ?? join(import.meta.dirname, '..', 'web', 'dist')
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff2', '.map', '.html'
])
const MIN_BYTES = 1024

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (st.isFile()) out.push(p)
  }
  return out
}

let gzCount = 0
let brCount = 0
let skipped = 0

for (const file of walk(ROOT)) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  if (SKIP_EXT.has(ext) || ext.endsWith('.map')) { skipped++; continue }
  const data = readFileSync(file)
  if (data.length < MIN_BYTES) { skipped++; continue }

  const gz = gzipSync(data, { level: 9 })
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) // quality 5: fast, still ~15% better than gzip

  writeFileSync(`${file}.gz`, gz)
  writeFileSync(`${file}.br`, br)
  gzCount++
  brCount++
}

console.log(`precompress: ${gzCount} .gz, ${brCount} .br emitted, ${skipped} skipped (${ROOT})`)

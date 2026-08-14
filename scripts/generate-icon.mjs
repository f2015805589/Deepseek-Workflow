// Renders the harness favicon mark into a multi-size Windows icon:
// build/icon.ico, which electron-builder embeds as the exe resource. The SVG's
// prefers-color-scheme fill is stripped (librsvg does not evaluate it) and the
// mark is pinned to black — the favicon's own light-mode rendering, i.e. the
// whale the harness shows in the browser chrome.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const MARK_BLACK = '#000000'
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Locate sharp in the pnpm store (a transitive dependency, never hoisted). */
function findSharp() {
  const store = join(repoRoot, 'node_modules/.pnpm')
  for (const dir of readdirSync(store)) {
    if (!dir.startsWith('sharp@')) continue
    const sharpDir = join(store, dir, 'node_modules/sharp')
    if (existsSync(join(sharpDir, 'package.json'))) return sharpDir
  }
  throw new Error('generate-icon: sharp not found in the pnpm store')
}

const sharp = createRequire(join(findSharp(), 'package.json'))('sharp')

const svgPath = join(repoRoot, 'apps/web/public/favicon.svg')
const svg = readFileSync(svgPath, 'utf8')
  .replace(/<style>[\s\S]*?<\/style>/, '')
  .replace(/ fill="[^"]*"/g, '')
  .replace('<path id="path"', `<path id="path" fill="${MARK_BLACK}"`)

const pngs = []
for (const size of SIZES) {
  pngs.push(await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer())
}

// ICONDIR header + one 16-byte directory entry per size + PNG payloads.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(SIZES.length, 4)
const entries = []
const payloads = []
let offset = 6 + 16 * SIZES.length
SIZES.forEach((size, index) => {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size === 256 ? 0 : size, 0) // 0 encodes 256
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // palette colors
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(pngs[index].length, 8)
  entry.writeUInt32LE(offset, 12)
  entries.push(entry)
  payloads.push(pngs[index])
  offset += pngs[index].length
})

mkdirSync(join(desktopDir, 'build'), { recursive: true })
writeFileSync(join(desktopDir, 'build/icon.ico'), Buffer.concat([header, ...entries, ...payloads]))
console.log('generate-icon: build/icon.ico written')

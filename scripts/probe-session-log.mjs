// Diagnostic: decompress a .jsonl.zstd session artifact frame-by-frame and
// locate seq discontinuities (duplicated/missing lines) like the desktop's
// "seq gap in committed region" error. Storage rows (seq0 + member count)
// expand to their exact event ranges; every other line is one event with a
// `seq` field. Reports the seam with frame context and whether overlapping
// events are identical to the already-committed ones.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const file = process.argv[2]
const buffer = readFileSync(file)
const { frames, tornStart } = scanFrames(buffer)
console.log(`file bytes: ${buffer.length}, frames: ${frames.length}, tornStart: ${tornStart ?? 'none'}`)

// Per-line: { line, frame, seqRange, rawSnippet, expanded } where expanded are
// JSON strings of the events for identity comparison.
const lines = []
let lineNo = 0
let plaintext = ''
for (let f = 0; f < frames.length; f++) {
  const { start, end } = frames[f]
  const frameText = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  plaintext += frameText
  const records = frameText.split('\n')
  for (let i = 0; i < records.length; i++) {
    const raw = records[i]
    if (raw === '') continue
    lineNo += 1
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      lines.push({ line: lineNo, frame: f, seqRange: null, raw: raw.slice(0, 60) })
      continue
    }
    if (
      typeof parsed === 'object' && parsed !== null
      && (parsed.type === 'text-chunks' || parsed.type === 'reasoning-chunks' || parsed.type === 'tool-call-chunks')
      && typeof parsed.seq0 === 'number' && typeof parsed.data === 'object' && parsed.data !== null
    ) {
      const payload = parsed.type === 'tool-call-chunks' ? parsed.data.args : parsed.data.texts
      if (Array.isArray(payload)) {
        lines.push({
          line: lineNo,
          frame: f,
          seqRange: [parsed.seq0, parsed.seq0 + payload.length - 1],
          kind: parsed.type,
          members: payload.length,
          raw: raw.slice(0, 60),
          full: raw,
        })
        continue
      }
    }
    const seq = typeof parsed?.seq === 'number' ? parsed.seq : null
    lines.push({ line: lineNo, frame: f, seqRange: seq === null ? null : [seq, seq], kind: parsed?.type ?? '?', raw: raw.slice(0, 80), full: raw })
  }
}
console.log('total lines:', lines.length)

const committed = []
let expected = 0
let firstSeam = null
for (const entry of lines) {
  if (entry.seqRange === null) {
    console.log(`line ${entry.line}: no seq (${entry.kind}): ${entry.raw}`)
    continue
  }
  const [from, to] = entry.seqRange
  if (from !== expected) {
    firstSeam ??= { line: entry.line, frame: entry.frame, expected, got: from, end: to, kind: entry.kind }
  }
  for (let s = from; s <= to; s++) committed[s] = entry.line
  expected = Math.max(expected, to + 1)
}
console.log('final event count (by seq):', expected, 'max line->seq map size:', committed.length - 1)

if (firstSeam !== null) {
  const { line, frame, expected, got, end, kind } = firstSeam
  console.log('\nFIRST SEAM:', JSON.stringify({ line, frame, expected, got, end, kind }))
  for (let i = Math.max(0, line - 6); i <= Math.min(lines.length - 1, line + 4); i++) {
    const e = lines[i]
    console.log(
      `  line ${e.line} (frame ${e.frame}): seqRange=${JSON.stringify(e.seqRange)} kind=${e.kind} members=${e.members ?? 1}`,
    )
    console.log('    ' + (e.full ?? e.raw))
  }
  // Do the events after the seam overlap committed seqs? Are they identical to
  // what was already committed at those seqs?
  const seamEvents = []
  for (let i = line - 1; i < lines.length; i++) {
    const e = lines[i]
    if (e.seqRange === null) continue
    const [from, to] = e.seqRange
    if (from < expected) seamEvents.push(i)
  }
  console.log('\nlines overlapping the committed region at the seam:', seamEvents.slice(0, 12))
}

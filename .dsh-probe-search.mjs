import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2]
const target = process.argv[3]
const patterns = process.argv.slice(4).map(p => new RegExp(p, 'i'))
const out = []
const seen = 0

function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.turbo' || name.endsWith('.tsbuildinfo')) continue
    const path = join(dir, name)
    let st
    try { st = statSync(path) } catch { continue }
    if (st.isDirectory()) {
      walk(path)
    } else if (/\.(ts|tsx|js|mjs|cjs|json|yml|yaml|md)$/.test(name)) {
      let text
      try { text = readFileSync(path, 'utf8') } catch { continue }
      const rel = relative(root, path)
      const lines = text.split(/\r?\n/)
      lines.forEach((line, i) => {
        if (patterns.some(p => p.test(line))) {
          out.push(`${rel}:${i + 1}: ${line.slice(0, 240)}`)
        }
      })
    }
  }
}
function scanFile(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return }
  const rel = relative(root, path)
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (patterns.some(p => p.test(line))) {
      out.push(`${rel}:${i + 1}: ${line.slice(0, 240)}`)
    }
  })
}

if (statSync(root).isFile()) scanFile(root)
else walk(root)
writeFileSync(target, out.join('\n'), 'utf8')

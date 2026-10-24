// Documentation consistency gate for dsh-dbhub-live.
//
// The repository keeps its knowledge in layers: AGENTS.md holds conclusions and
// points at `doc/` chapters that hold the reasoning. That only works while the
// pointers are real. This gate makes drift mechanical:
//
//   1. every relative markdown link in AGENTS.md and doc/*.md resolves to an
//      existing file (and, when it carries `#anchor`, to an existing heading);
//   2. every `doc/` document AGENTS.md links is shipped in package.json `files`
//      (the package contains AGENTS.md, so its links must not dangle);
//   3. every shipped `doc/*.md` path in `files` exists on disk;
//   4. AGENTS.md still points at the impact matrix, and every repo path quoted
//      in that matrix (doc/IMPACT-MATRIX.md) exists.
//
// Usage: npm run check:docs   (exit 0 = consistent, exit 1 = drift)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = 'AGENTS.md'
const DOC_DIR = 'doc'
const MATRIX_DOC = 'doc/IMPACT-MATRIX.md'

const findings = []
const record = (where, message) => findings.push(`${where}: ${message}`)

/** Repository-relative POSIX path for a native path. */
const toPosix = (p) => p.split(sep).join('/')

/**
 * GitHub-style heading slug: lowercase, drop HTML and every character that is
 * not a letter, a number, `-`, `_` or a space, then spaces become hyphens.
 * @param heading - raw heading text without the leading `#`s.
 */
function slugify(heading) {
  return heading
    .replace(/<[^>]*>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** @returns heading slugs of a markdown document. */
function headingSlugs(text) {
  const slugs = new Set()
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line.trimEnd())
    if (!match) continue
    slugs.add(slugify(match[1].replace(/#+\s*$/, '').trim()))
  }
  return slugs
}

/** @returns markdown links as `{ label, target }`. */
function markdownLinks(text) {
  const links = []
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    links.push({ label: match[1], target: match[2] })
  }
  return links
}

const fileCache = new Map()
function readDoc(absPath) {
  if (!fileCache.has(absPath)) fileCache.set(absPath, readFileSync(absPath, 'utf8'))
  return fileCache.get(absPath)
}

// ── 1. link + anchor resolution ──────────────────────────────────────────────

// Local-only drafts are gitignored and never shipped (see package.json `files`
// and .gitignore), so the gate stays deterministic between a working copy and a
// clean CI checkout by scanning only documented, distributable documents.
const LOCAL_DOC_RE = /^(PLAN-.*\.md|implementation-notes\.md|RELEASE-NOTES-.*\.md)$/

const scanned = [ENTRY]
const docDirAbs = join(ROOT, DOC_DIR)
if (existsSync(docDirAbs)) {
  for (const name of readdirSync(docDirAbs)) {
    if (!name.endsWith('.md') || LOCAL_DOC_RE.test(name)) continue
    scanned.push(`${DOC_DIR}/${name}`)
  }
}

let linkCount = 0
for (const source of scanned) {
  const abs = join(ROOT, source)
  if (!existsSync(abs)) {
    record(source, 'document is missing')
    continue
  }
  for (const { target } of markdownLinks(readDoc(abs))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // external URL
    if (target.startsWith('<')) continue // placeholder

    const [rawPath, anchor] = target.split('#')
    const sameFile = rawPath === ''
    const resolved = sameFile
      ? abs
      : join(dirname(abs), decodeURIComponent(rawPath))
    const label = sameFile ? source : `${source} → ${toPosix(relative(ROOT, resolved))}`
    linkCount += 1

    if (!existsSync(resolved)) {
      record(source, `link target "${target}" does not exist`)
      continue
    }
    if (statSync(resolved).isDirectory()) continue
    if (!anchor) continue
    if (!resolved.endsWith('.md')) {
      record(source, `link "${target}" carries an anchor but the target is not markdown`)
      continue
    }
    const slugs = headingSlugs(readDoc(resolved))
    const wanted = decodeURIComponent(anchor).replace(/^#/, '').toLowerCase()
    if (!slugs.has(wanted)) {
      record(label, `anchor "${wanted}" matches no heading`)
    }
  }
}

// ── 2 + 3. package.json `files` vs linked docs ───────────────────────────────

const pkgPath = join(ROOT, 'package.json')
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (error) {
  record('package.json', `cannot be parsed (${error.message})`)
}
const shipped = new Set(Array.isArray(pkg?.files) ? pkg.files : [])

const linkedDocs = new Set()
for (const { target } of markdownLinks(readDoc(join(ROOT, ENTRY)))) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
  const clean = target.split('#')[0]
  if (!clean.endsWith('.md')) continue
  const normalized = posix.normalize(clean)
  if (normalized.startsWith(`${DOC_DIR}/`)) linkedDocs.add(normalized)
}
for (const doc of linkedDocs) {
  if (!existsSync(join(ROOT, doc))) {
    record(ENTRY, `linked document "${doc}" is missing on disk`)
    continue
  }
  if (!shipped.has(doc)) {
    record(ENTRY, `linked document "${doc}" is not in package.json "files" — the published package would have a dangling link`)
  }
}
for (const entry of shipped) {
  if (!entry.startsWith(`${DOC_DIR}/`) || !entry.endsWith('.md')) continue
  if (!existsSync(join(ROOT, entry))) {
    record('package.json', `"files" lists "${entry}" but the file is missing`)
  }
}

// ── 4. the impact matrix: pointed at, present, and honest about paths ───────

const agentsText = readDoc(join(ROOT, ENTRY))
if (!markdownLinks(agentsText).some(({ target }) => target.split('#')[0] === MATRIX_DOC)) {
  record(ENTRY, `the reminder pointing at ${MATRIX_DOC} is missing — readers must be told where the impact matrix lives`)
}

const matrixAbs = join(ROOT, MATRIX_DOC)
if (!existsSync(matrixAbs)) {
  record(MATRIX_DOC, 'the impact matrix document is missing')
} else {
  const lines = readDoc(matrixAbs).split('\n')
  const headerIndex = lines.findIndex((line) => line.trim().startsWith('| 改动'))
  if (headerIndex === -1) {
    record(MATRIX_DOC, 'the matrix table header "| 改动 |" is missing')
  } else {
    // Count only the contiguous table, but validate every table-looking row in
    // the document: a row appended below the table must not escape the gate.
    let contiguous = 0
    for (const line of lines.slice(headerIndex)) {
      if (!line.trim().startsWith('|')) break
      contiguous += 1
    }
    if (contiguous < 5) record(MATRIX_DOC, `the matrix only has ${contiguous - 2} data row(s) — did it get truncated?`)

    let pathTokens = 0
    for (const line of lines) {
      if (!line.trim().startsWith('|')) continue
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const token = match[1].trim()
        if (token.includes('*') || token.includes('<') || token.includes('|')) continue
        if (!/\.(md|mjs|cjs|js|json|yml|yaml)$/.test(token)) continue
        pathTokens += 1
        if (!existsSync(join(ROOT, token))) {
          record(MATRIX_DOC, `matrix quotes "${token}" but it does not exist`)
        }
      }
    }
    if (pathTokens === 0) record(MATRIX_DOC, 'matrix quotes no repository paths — did the table change shape?')
  }
}

// ── report ──────────────────────────────────────────────────────────────────

if (findings.length > 0) {
  console.error(`[check:docs] ${findings.length} problem(s):`)
  for (const line of findings) console.error(`  - ${line}`)
  console.error('\n[check:docs] fix the pointers (or the document they point at), then rerun.')
  process.exit(1)
}

console.log(
  `[check:docs] clean: ${scanned.length} document(s), ${linkCount} link(s), ` +
    `${linkedDocs.size} shipped doc(s) — links, anchors, package contents and the impact matrix agree.`,
)

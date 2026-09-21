// Desensitization gate: no tracked file (and nothing shipped in the npm tarball)
// may contain a real internal host, database, project or company identifier.
//
// The blacklist itself is a SECRET-LOCAL value: it lives in the repository-local
// `.env` (excluded by .gitignore and never listed in package.json `files`), so
// the gate still runs on every commit while the identifiers stay out of git
// history, the public repo and the published package.
//
// Usage: npm run check:secrets   (exit 0 = clean, exit 1 = match or no config)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENV_FILE = join(ROOT, '.env')
const VAR = 'DSH_DBHUB_DESENSITIZE_RE'

// Directories and files the walk never descends into: VCS metadata, installed
// dependencies, the local blacklist itself and packed tarballs.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-test', 'dist'])
const SKIP_FILES = new Set(['.env', '.env.local'])
const SKIP_EXT = /\.(tgz|png|jpe?g|gif|webp|ico|zip|gz|exe|dll|node)$/i
const MAX_BYTES = 2 * 1024 * 1024

/**
 * Read every blacklist value from the local `.env`. Multiple assignments are
 * UNIONed (joined with `|`) instead of silently ignoring all but the first — a
 * maintainer who appends a second line must not lose that protection.
 * @returns `{ pattern, count }`; pattern is undefined when unset.
 */
function readPattern() {
  let text
  try {
    text = readFileSync(ENV_FILE, 'utf8')
  } catch {
    return { pattern: undefined, count: 0 }
  }
  const values = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() !== VAR) continue
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
    if (value) values.push(value)
  }
  return { pattern: values.length > 0 ? values.join('|') : undefined, count: values.length }
}

/** Every regular file under `dir`, skipping the ignored paths above. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name) || SKIP_EXT.test(entry.name)) continue
    const full = join(dir, entry.name)
    let size
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    if (size <= MAX_BYTES) out.push(full)
  }
  return out
}

const { pattern, count } = readPattern()
if (!pattern) {
  console.error(
    `[check:secrets] ${VAR} is not configured.\n` +
      `Put the blacklist regex (real internal hosts / database / project identifiers,\n` +
      `'|'-separated, regex-escaped) in the repository-local ${relative(process.cwd(), ENV_FILE) || '.env'}:\n` +
      `  ${VAR}=10\\.0\\.0\\.1|example-db|example-project\n` +
      'That file is gitignored and is never published; the value must never enter\n' +
      'AGENTS.md, the READMEs, tests or any other tracked file.',
  )
  process.exitCode = 1
}
if (count > 1) {
  console.warn(`[check:secrets] ${count} ${VAR} assignments found in .env — all of them are applied (union).`)
}

let matcher
try {
  matcher = new RegExp(pattern, 'i')
} catch (e) {
  console.error(`[check:secrets] ${VAR} is not a valid regular expression: ${String((e && e.message) || e)}`)
  process.exitCode = 1
}

const hits = []
for (const file of walk(ROOT)) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (matcher.test(lines[i])) {
      hits.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}: ${lines[i].trim().slice(0, 160)}`)
    }
  }
}

if (hits.length > 0) {
  console.error(`[check:secrets] ${hits.length} line(s) match the local blacklist:`)
  for (const hit of hits) console.error('  ' + hit)
  process.exitCode = 1
}
console.log('[check:secrets] clean: no tracked file matches the local blacklist')

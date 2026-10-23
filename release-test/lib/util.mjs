// Small shared helpers: paths, ids, hashing, redaction, fs helpers.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
// lib/ -> release-test/ -> repo root
export const REPO_ROOT = path.resolve(HERE, '..', '..')
export const WORK_DIR = path.join(REPO_ROOT, '.release-test')
export const REPORTS_DIR = path.join(WORK_DIR, 'reports')
export const CACHE_DIR = path.join(WORK_DIR, 'cache')
export const TOOLS_DIR = path.join(CACHE_DIR, 'tools')
export const HOMES_DIR = path.join(WORK_DIR, 'homes')
export const ARTIFACTS_DIR = path.join(CACHE_DIR, 'artifacts')
export const NPM_CACHE = path.join(CACHE_DIR, 'npm')
export const PNPM_STORE = path.join(CACHE_DIR, 'pnpm-store')

export const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export const readJson = (file, fallback = undefined) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    if (fallback !== undefined) return fallback
    throw new Error(`cannot read JSON: ${file}`)
  }
}

export const writeJson = (file, value) => {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  return file
}

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export const sha256Text = (text) => crypto.createHash('sha256').update(text).digest('hex')

export const stamp = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export const nowIso = () => new Date().toISOString()

export const hhmmss = (ms) => {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`
}

// Anything token-like or credential-like never reaches a committed or shared report.
export const redact = (text) => {
  if (typeof text !== 'string') return text
  return text
    .replace(/([?&]token=)[\w.-]+/g, '$1<redacted>')
    .replace(/(\/\/)[^\s/@]+:[^\s/@]+@/g, '$1<redacted>:<redacted>@')
    .replace(/(\/\/)[^\s/@]+@/g, '$1<redacted>@')
    .replace(/\b(token|password|passphrase|secret)(["'\s:=]+)([^\s"',}]{6,})/gi, '$1$2<redacted>')
}

export const tail = (text, max = 4000) => (text.length <= max ? text : `…(${text.length - max} chars omitted)…\n` + text.slice(-max))

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const isWindows = process.platform === 'win32'

export const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [] }
}

// dsh-dbhub-live: authorized collection of connection candidates.
//
// Scanning reads files that may contain passwords and costs tokens, so it is
// never silent: the caller must go through `askUser` authorization first, and
// every surfaced candidate is password-masked.

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnvFile, dsnFromEnv, dsnFromMap } from './config.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.idea', '.vscode', 'venv', '.venv', '__pycache__', '.dsh', '.mise', '.opencode', '.codex'])
const FILE_PATTERNS = [/\.env([.\w-]*)?$/, /application[-.\w]*\.(yml|yaml|properties)$/, /docker-compose[-.\w]*\.(yml|yaml)$/, /dbconfig\.properties$/, /jdbc\.properties$/, /database\.properties$/, /bootstrap[-.\w]*\.(yml|yaml)$/]

export function walkForCandidates(root, budget) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 2 || found.length >= 30 || budget.count >= 200) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const en of entries) {
      if (budget.count >= 200) return
      budget.count++
      if (SKIP_DIRS.has(en.name)) continue
      const full = join(dir, en.name)
      let isFile = en.isFile()
      if (!isFile && en.isSymbolicLink()) {
        try {
          isFile = statSync(full).isFile()
        } catch (e) {
          continue
        }
      }
      if (isFile) {
        if (FILE_PATTERNS.some((p) => p.test(en.name))) found.push(full)
      } else if (en.isDirectory() || en.isSymbolicLink()) {
        walk(full, depth + 1)
      }
    }
  }
  walk(root, 0)
  return found
}

export function extractDsnCandidates(filePath, text) {
  const out = []
  const push = (dsn, via) => {
    let d = dsn
    if (d && typeof d === 'string') d = d.trim().replace(/^postgresql:\/\//i, 'postgres://')
    if (d && /^[a-z]+:\/\//i.test(d) && !out.some((o) => o.dsn === d)) {
      out.push({ dsn: d, via })
    }
  }
  for (const m of String(text).matchAll(/(?:jdbc:mysql|jdbc:postgresql|jdbc:sqlserver|jdbc:mariadb)[^"'\s,;)]*/gi)) {
    push(m[0].replace(/^jdbc:/i, ''), 'jdbc url')
  }
  for (const m of String(text).matchAll(/url\s*[:=]\s*["']?(jdbc:[^"'\s]+)["']?/gi)) {
    push(m[1].replace(/^jdbc:/i, ''), 'url=')
  }
  for (const m of String(text).matchAll(/datasource\.url\s*[:=]\s*["']?([^"'\s]+)["']?/gi)) {
    push(m[1], 'datasource.url')
  }
  for (const m of String(text).matchAll(/\b(mysql|postgres|postgresql|mariadb|sqlserver|sqlite)(?:\+ssl)?:\/\/[^"'\s,;)]+/gi)) {
    push(m[0], 'dsn')
  }
  const map = parseEnvFile(text)
  const grouped = dsnFromMap(map)
  if (grouped) push(grouped, 'env 变量组')
  const mysqlGroup = {
    DB_TYPE: map.MYSQL_TYPE || map.DB_TYPE,
    DB_HOST: map.MYSQL_HOST || map.PGHOST || map.DB_HOST,
    DB_PORT: map.MYSQL_PORT || map.PGPORT || map.DB_PORT,
    DB_USER: map.MYSQL_USER || map.PGUSER || map.DB_USER,
    DB_PASSWORD: map.MYSQL_PASSWORD || map.PGPASSWORD || map.DB_PASSWORD,
    DB_NAME: map.MYSQL_DATABASE || map.PGDATABASE || map.DB_NAME,
  }
  const g2 = dsnFromEnv(mysqlGroup)
  if (g2) push(g2, 'MYSQL_*/PG* 变量组')
  return out.slice(0, 6)
}

// Ask the user a question through the interaction service; undefined when it
// is unavailable or the user cancels.
export async function askUser(userQuestions, agent, signal, questions) {
  if (!userQuestions || typeof userQuestions.ask !== 'function') return undefined
  try {
    return await userQuestions.ask({
      questions,
      ...(agent ? { agent } : {}),
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    return undefined
  }
}

export function answerItemOf(ans, id) {
  if (!ans || !Array.isArray(ans.answers)) return undefined
  return ans.answers.find((a) => a && a.id === id)
}

// Resolve the current session working directory from the executing agent.
export function sessionCwd(agent) {
  try {
    const s = agent && agent.session
    if (!s) return undefined
    const h = s.header
    if (h && typeof h.cwd === 'string' && h.cwd) return h.cwd
    if (typeof s.cwd === 'string' && s.cwd) return s.cwd
    if (s.meta && typeof s.meta.cwd === 'string' && s.meta.cwd) return s.meta.cwd
  } catch (e) {
    /* fall through */
  }
  return undefined
}
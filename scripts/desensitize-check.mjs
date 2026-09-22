// Desensitization gate for dsh-dbhub-live.
//
// Runs two rule sets, both defined by scripts/desensitize.config.mjs:
//   * a BACKSTOP over every scanned file (IP literals, secret formats, entropy)
//     so an unregistered new surface is still caught;
//   * the registered SLOTS' targeted rules (credentialed URLs, secret-keyword
//     assignments, internal host suffixes, local denylist names) where real
//     values are actually plausible.
//
// The repository is treated as content that ships publicly (npm tarball and the
// public repository), so anything that looks like a real host, account,
// password, database or project name fails the gate. Real values belong in
// $DSH_HOME/storages/dsh-dbhub-live/credentials.json (outside the repository)
// and in the local, gitignored .env denylist.
//
// Usage: npm run check:secrets   (exit 0 = clean, exit 1 = hit or broken config)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALL_RULES, BACKSTOP_RULES, DENYLIST_VAR, ENTROPY, IP_ALLOWLIST, INTERNAL_HOST_SUFFIXES,
  MAX_FILE_BYTES, PLACEHOLDER_HOSTS, PLACEHOLDER_PASSWORDS, PLACEHOLDER_VALUE_RE, PRAGMA,
  SECRET_FORMATS, SECRET_KEYWORDS, SKIP_DIRS, SKIP_EXT_RE, SKIP_FILES, SLOTS,
} from './desensitize.config.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENV_FILE = join(ROOT, '.env')

// ── local denylist (supplementary: bare names no pattern can see) ──────────

/**
 * Union every `DSH_DBHUB_DESENSITIZE_RE` assignment in the local .env.
 * @returns `{ matcher, count, broken }`; matcher is undefined when unconfigured.
 */
function readDenylist() {
  let text
  try {
    text = readFileSync(ENV_FILE, 'utf8')
  } catch {
    return { matcher: undefined, count: 0 }
  }
  const values = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() !== DENYLIST_VAR) continue
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value) values.push(value)
  }
  if (values.length === 0) return { matcher: undefined, count: 0 }
  try {
    return { matcher: new RegExp(values.join('|'), 'i'), count: values.length }
  } catch (e) {
    console.error(`[check:secrets] ${DENYLIST_VAR} in .env is not a valid regular expression: ${String((e && e.message) || e)}`)
    return { matcher: undefined, count: values.length, broken: true }
  }
}

// ── glob matching (no dependencies) ────────────────────────────────────────

/** Compile a repository-relative glob (`**`, `*`, `?`) into a RegExp. */
function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

// ── rule helpers ───────────────────────────────────────────────────────────

const IPV4_RE = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g
const CREDENTIAL_URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^/@\s:]+):([^@\s]*)@([A-Za-z0-9._:-]+)/gi
const URL_HOST_RE = /\b[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9._-]+)/gi
const SECRET_ASSIGN_RE = new RegExp(
  `\\b(${SECRET_KEYWORDS.join('|')})\\b\\s*[:=]\\s*(['"]?)([^\\s'"]+)\\2`,
  'gi',
)
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const QUOTED_TOKEN_RE = /(['"`])([A-Za-z0-9_+/=.-]{8,})\1/g

/**
 * Whether an assigned value looks like a written-down credential rather than a
 * code expression (identifier, call, index, template, escape sequence). Only the
 * former is a leak; the latter is how source code reads values at runtime.
 */
function looksLikeSecretLiteral(raw) {
  const value = raw.replace(/[,;)\]}"']+$/, '')
  if (value.length < 4) return false
  if (PLACEHOLDER_VALUE_RE.test(value) || PLACEHOLDER_PASSWORDS.includes(value)) return false
  if (/[([{$\\|`]/.test(value)) return false // call / index / template / escape / regex alternation
  if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(value)) return false // bare identifier or member path
  return true
}

/** Host-shaped quoted token (rejects config keys like `.env.local`, code like `process.env.HOME`). */
function isHostShaped(token) {
  return token === token.toLowerCase() && HOSTNAME_RE.test(token) && !token.startsWith('.') && !token.includes('..')
}

/** Shannon entropy in bits per character. */
function entropyBits(value) {
  const counts = new Map()
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const ipAllowed = (ip) => IP_ALLOWLIST.some((entry) => entry.test.test(ip))

function hostAllowed(host) {
  const bare = host.replace(/:\d+$/, '').toLowerCase()
  return ipAllowed(bare) || PLACEHOLDER_HOSTS.includes(bare)
}

/**
 * Evaluate the enabled rules on one line.
 * @param line - the source line.
 * @param rules - rule ids enabled for this file (backstop + slot rules).
 * @param denylist - compiled local denylist, or undefined.
 * @returns findings as `{ rule, message }`.
 */
function checkLine(line, rules, denylist) {
  const found = []
  const add = (rule, message) => found.push({ rule, message })

  if (rules.includes('ip')) {
    for (const match of line.matchAll(IPV4_RE)) {
      if (!ipAllowed(match[0])) {
        add('ip', `${match[0]} is not loopback or an RFC 5737 documentation address`)
      }
    }
  }

  if (rules.includes('secret')) {
    for (const { label, re } of SECRET_FORMATS) {
      if (re.test(line)) add('secret', `looks like a real ${label}`)
    }
  }

  if (rules.includes('password')) {
    for (const match of line.matchAll(CREDENTIAL_URL_RE)) {
      const password = match[3]
      if (!password) continue
      if (!PLACEHOLDER_PASSWORDS.includes(password) && !PLACEHOLDER_VALUE_RE.test(password)) {
        add('password', `credentialed URL password "${password}" is not a placeholder (use CHANGE_ME)`)
      }
    }
    for (const match of line.matchAll(SECRET_ASSIGN_RE)) {
      if (!looksLikeSecretLiteral(match[3])) continue
      add('password', `${match[1]} is assigned the literal "${match[3]}" — use a placeholder or a reference`)
    }
  }

  if (rules.includes('dsn')) {
    for (const match of line.matchAll(CREDENTIAL_URL_RE)) {
      if (!hostAllowed(match[4])) {
        add('dsn', `example host "${match[4]}" is not loopback, an RFC 5737 address or a placeholder host`)
      }
    }
  }

  if (rules.includes('host')) {
    // Only URL hosts and host-shaped quoted tokens are candidates: a raw line is
    // full of identifiers (`process.env.HOME` ends with `.home` but is code).
    const candidates = []
    for (const match of line.matchAll(URL_HOST_RE)) candidates.push(match[1])
    for (const match of line.matchAll(QUOTED_TOKEN_RE)) {
      if (isHostShaped(match[2])) candidates.push(match[2])
    }
    for (const host of candidates) {
      const bare = host.replace(/:\d+$/, '').toLowerCase()
      if (INTERNAL_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix)) && !hostAllowed(bare)) {
        add('host', `hostname "${host}" looks internal`)
      }
    }
  }

  if (rules.includes('name') && denylist) {
    const hit = line.match(denylist)
    if (hit) add('name', `matches the local denylist ("${hit[0]}")`)
  }

  if (rules.includes('entropy')) {
    for (const match of line.matchAll(QUOTED_TOKEN_RE)) {
      const token = match[2]
      if (token.length < ENTROPY.minLength) continue
      if (ENTROPY.requireMixed && !(/[a-z]/.test(token) && (/[A-Z]/.test(token) || /[0-9]/.test(token)))) continue
      if (ENTROPY.allowPatterns.some((re) => re.test(token))) continue
      if (PLACEHOLDER_VALUE_RE.test(token) || PLACEHOLDER_PASSWORDS.includes(token)) continue
      const bits = entropyBits(token)
      if (bits >= ENTROPY.minBitsPerChar) {
        add('entropy', `"${token}" looks like a random secret (${bits.toFixed(1)} bits/char)`)
      }
    }
  }

  return found
}

// ── walk ───────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.includes(entry.name)) walk(join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.includes(entry.name) || SKIP_EXT_RE.test(entry.name)) continue
    const full = join(dir, entry.name)
    try {
      if (statSync(full).size <= MAX_FILE_BYTES) out.push(full)
    } catch {
      /* unreadable: skip */
    }
  }
  return out
}

// ── run ────────────────────────────────────────────────────────────────────

const badRule = SLOTS.find((slot) => slot.rules.some((rule) => !ALL_RULES.includes(rule)))
if (badRule) {
  const unknown = badRule.rules.find((rule) => !ALL_RULES.includes(rule))
  console.error(`[check:secrets] slot "${badRule.id}" declares unknown rule "${unknown}" — fix scripts/desensitize.config.mjs`)
  process.exitCode = 1
} else {
  const { matcher: denylist, count, broken } = readDenylist()
  if (broken) {
    console.error('[check:secrets] .env denylist could not be compiled — fix it before continuing')
  } else if (!denylist) {
    console.warn(
      `[check:secrets] note: no local denylist (${DENYLIST_VAR} in .env) — bare project/database names are\n` +
        '               not pattern-detectable. Create .env (gitignored) to enable that layer.',
    )
  } else if (count > 1) {
    console.warn(`[check:secrets] note: ${count} ${DENYLIST_VAR} assignments in .env — all applied (union).`)
  }

  const files = walk(ROOT)
  const rel = (file) => relative(ROOT, file).split(sep).join('/')
  const slotMatchers = SLOTS.map((slot) => ({ slot, res: slot.globs.map(globToRegExp) }))
  const slotFileCounts = new Map(SLOTS.map((slot) => [slot.id, 0]))
  const findings = []

  for (const file of files) {
    const path = rel(file)
    const rules = new Set(BACKSTOP_RULES)
    for (const { slot, res } of slotMatchers) {
      if (!res.some((re) => re.test(path))) continue
      slotFileCounts.set(slot.id, slotFileCounts.get(slot.id) + 1)
      for (const rule of slot.rules) rules.add(rule)
    }

    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    const ruleList = [...rules]
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes(PRAGMA)) continue
      for (const { rule, message } of checkLine(line, ruleList, denylist)) {
        findings.push(`${path}:${i + 1}: [${rule}] ${message}`)
      }
    }
  }

  for (const slot of SLOTS) {
    if ((slotFileCounts.get(slot.id) || 0) === 0) {
      findings.push(`scripts/desensitize.config.mjs: [slot-stale] slot "${slot.id}" matches no file — update or remove it`)
    }
  }

  const activeRules = [
    ...BACKSTOP_RULES.map((rule) => `${rule}(backstop)`),
    ...[...new Set(SLOTS.flatMap((slot) => slot.rules))].filter((rule) => !BACKSTOP_RULES.includes(rule)),
    denylist ? 'denylist' : 'denylist(inactive)',
  ]

  if (findings.length > 0) {
    console.error(`[check:secrets] ${findings.length} finding(s) across ${files.length} file(s):`)
    for (const finding of findings) console.error('  ' + finding)
    console.error(
      '[check:secrets] replace with loopback/RFC 5737 hosts + CHANGE_ME passwords, or waive a false\n' +
        `               positive with the inline marker "${PRAGMA}".`,
    )
    process.exitCode = 1
  } else {
    console.log(
      `[check:secrets] clean: ${files.length} file(s), ${SLOTS.length} slot(s) covered — rules: ${activeRules.join(', ')}`,
    )
  }
}

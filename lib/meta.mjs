// dsh-dbhub-live: version metadata for the Host.
//
// Two independent questions live here:
//   1. which version of THIS plugin is running (its own package.json), and
//   2. which dsh release is hosting it, and whether that release is new enough
//      for the modern UI contracts (>= 0.2.1 base version).
//
// Both are read once per Host process (the card publishes them as plain view
// fields), so everything is cached and every failure degrades to '' / false —
// a version probe must never be able to break the plugin.
//
// Dependency direction: this module is a LEAF (node builtins only). lib/index.mjs
// imports it; nothing imports back, so no cycle can form.

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** This plugin's npm package name (also the npm update-check target). */
export const PLUGIN_NAME = 'dsh-dbhub-live'

/** The first dsh release with the modern client UI contracts. */
export const DSH_MODERN_BASE = '0.2.1'

/**
 * Package names that identify the running dsh runtime when walking up from the
 * process entry point. The CLI, the desktop runtime wrapper and the desktop app
 * shell are all valid hosts.
 */
export const DSH_PACKAGE_NAMES = Object.freeze([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-desktop-runtime',
  '@deepseek-ai/dsh-desktop',
])

// Accepts `v1.2.3`, `1.2.3-dev.1`, `1.2.3+build.5` and `1.2.3-rc.1+sha`.
const SEMVER_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

const NUMERIC_RE = /^\d+$/

/**
 * Parse a semver string into comparable parts.
 *
 * Lenient on the leading `v` (release tags are usually written `v5.2.0`) and
 * tolerant of any build metadata (which never participates in precedence), but
 * strict about the core triplet and empty prerelease identifiers. Returns
 * `undefined` for anything that is not semver — callers treat that as
 * "unknown version", never as 0.0.0.
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], raw: string } | undefined}
 */
export function parseSemver(text) {
  if (typeof text !== 'string') return undefined
  const raw = text.trim()
  const match = SEMVER_RE.exec(raw)
  if (!match) return undefined
  const prerelease = match[4] ? match[4].split('.') : []
  // "1.2.3-alpha..beta" is invalid semver: no identifier may be empty.
  if (prerelease.length > 0 && prerelease.some((id) => id === '')) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw,
  }
}

function compareTriplet(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/**
 * Semver prerelease precedence (semver.org §11): a version WITHOUT prerelease
 * outranks the same version WITH one; numeric identifiers compare numerically;
 * numeric sorts below alphanumeric; alphanumeric compares in ASCII order; a
 * longer identifier list wins when every shared identifier is equal.
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    const left = a[i]
    const right = b[i]
    const leftNumeric = NUMERIC_RE.test(left)
    const rightNumeric = NUMERIC_RE.test(right)
    if (leftNumeric && rightNumeric) {
      const l = Number(left)
      const r = Number(right)
      if (l !== r) return l < r ? -1 : 1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return 0
}

function compareParsed(a, b) {
  const core = compareTriplet(a, b)
  if (core !== 0) return core
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Semver precedence between two versions (strings or already-parsed objects).
 * Invalid input compares as "incomparable" and yields 0 — this must never throw.
 *
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  const left = typeof a === 'object' && a !== null ? a : parseSemver(a)
  const right = typeof b === 'object' && b !== null ? b : parseSemver(b)
  if (!left || !right) return 0
  return compareParsed(left, right)
}

/**
 * True when `candidate` is STRICTLY newer than `current` per semver precedence.
 * Unknown on either side yields false: without a known current version an
 * update cannot be claimed, so the card must not show an update banner.
 */
export function isNewer(candidate, current) {
  const next = parseSemver(candidate)
  const installed = parseSemver(current)
  if (!next || !installed) return false
  return compareParsed(next, installed) > 0
}

/**
 * True when `version` has the same-or-newer numeric triplet than `base`
 * (prerelease is ignored: `0.2.1-rc.2` counts as `0.2.1`). An unknown version is
 * false — "cannot tell" must not be reported as "modern".
 */
export function atLeastBase(version, base = DSH_MODERN_BASE) {
  const parsed = parseSemver(version)
  const floor = parseSemver(base)
  if (!parsed || !floor) return false
  return compareTriplet(parsed, floor) >= 0
}

let cachedPluginVersion

/**
 * This plugin's own version, read from the package.json next to lib/.
 * Cached for the process lifetime (an installed package never changes under a
 * running Host); '' when the file is missing or its version is not semver.
 */
export function readPluginVersion() {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion
  cachedPluginVersion = ''
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const version = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : ''
    cachedPluginVersion = parseSemver(version) ? version : ''
  } catch (e) {
    cachedPluginVersion = ''
  }
  return cachedPluginVersion
}

function isDirectory(abs) {
  try {
    return statSync(abs).isDirectory()
  } catch (e) {
    return false
  }
}

/**
 * Walk up from the running process entry point looking for an installed dsh
 * package.json. Exported so tests can drive it against a temp layout and a fake
 * argv entry instead of touching the real installation.
 *
 * @param {string|undefined} entryPath - usually `process.argv[1]`
 * @param {{ maxDepth?: number, packageNames?: ReadonlyArray<string> }} [options]
 * @returns {string} the package version, or '' when nothing matched
 */
export function walkDshVersion(entryPath, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : 8
  const names = new Set(
    Array.isArray(options.packageNames) && options.packageNames.length > 0
      ? options.packageNames
      : DSH_PACKAGE_NAMES,
  )
  if (typeof entryPath !== 'string' || entryPath.trim() === '') return ''
  // `process.argv[1]` is normally a file, but a loader may hand over a directory
  // or a path that does not exist yet; both resolve to a starting directory.
  const abs = resolve(entryPath.trim())
  let dir = isDirectory(abs) ? abs : dirname(abs)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const version = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : ''
      if (pkg && typeof pkg.name === 'string' && names.has(pkg.name) && parseSemver(version)) {
        return version
      }
    } catch (e) {
      /* no package.json here (or unreadable/non-JSON): keep walking up */
    }
    const parent = dirname(dir)
    if (!parent || parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * Best-effort identity of the running dsh runtime.
 *
 * `desktop` is true under the packaged desktop app (Electron main process) or
 * whenever the desktop shell exports its own version through the environment.
 * The version is resolved from the installed dsh package.json first (the
 * authoritative value) and from the desktop env var second.
 *
 * @returns {{ version: string, desktop: boolean }}
 */
export function detectDshRuntime() {
  const envVersion = process.env && typeof process.env.DSH_CLIENT_VERSION === 'string'
    ? process.env.DSH_CLIENT_VERSION.trim()
    : ''
  const desktop = Boolean(process.versions && process.versions.electron) || Boolean(envVersion)
  let version = ''
  try {
    version = walkDshVersion(process.argv && process.argv[1], { maxDepth: 8 })
  } catch (e) {
    version = ''
  }
  if (!version && envVersion && parseSemver(envVersion)) version = envVersion
  return { version, desktop }
}

/**
 * The modern-UI gate: a resolved dsh >= 0.2.1 is modern; an UNRESOLVABLE
 * version is modern only on the desktop runtime (it ships the modern UI by
 * definition, and its package layout is the least predictable one). An unknown
 * version on web is treated as legacy, which is the safe assumption for the old
 * 0.1.x line.
 */
export function dshIsModern(runtime) {
  const info = runtime && typeof runtime === 'object' ? runtime : {}
  const version = typeof info.version === 'string' ? info.version : ''
  if (parseSemver(version)) return atLeastBase(version, DSH_MODERN_BASE)
  return Boolean(info.desktop)
}

/**
 * The version fields the Host publishes, computed once per Host core:
 * `{ pluginVersion, dshVersion, dshModern, runtime }`. Plain strings/booleans —
 * nothing here is secret and nothing here needs the network.
 */
export function versionMeta() {
  const runtime = detectDshRuntime()
  return {
    pluginVersion: readPluginVersion(),
    dshVersion: runtime.version,
    dshModern: dshIsModern(runtime),
    runtime: runtime.desktop ? 'desktop' : 'web',
  }
}

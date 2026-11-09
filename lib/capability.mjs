// dsh-dbhub-live: dbhub version / capability guard.
//
// The read-only and SSH-tunnel features are translated into dbhub's TOML
// dialect (`[[tools]] readonly = true`, `ssh_*` per-source fields). That
// dialect exists only from dbhub 1.x on: the 0.x spelling (`read_only` on a
// source, or the `--readonly` flag) is either REJECTED by 1.4+ or — far worse —
// silently IGNORED, which would look like "read-only is configured" while every
// write still goes through. Generating an unverified old spelling is therefore
// forbidden; when the installed dbhub is too old we refuse the two features
// with an upgrade hint instead of degrading silently.
//
// Detection is deliberately file-based (no extra process spawn): the executable
// we resolved lives inside a package directory (`…/node_modules/.bin/dbhub.cmd`
// next to `…/node_modules/@bytebase/dbhub/package.json`) or under mise's
// `npm-bytebase-dbhub/<version>/` layout, and both carry the version.
// Pure module: `node:fs` + `node:path` only, no Cordis service.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Process-wide detection cache, keyed by `<absolute exe path>\0<mtimeMs>`. The
// answer for one executable is immutable for the life of the process, while a
// TOML call used to re-walk up to 18 candidate manifests with readFileSync on
// EVERY tool call (the guard runs before each read-only / tunnelled spawn). The
// mtime keeps an in-place upgrade (`npm install` over the old prefix) from
// serving a stale version, and one statSync is microseconds next to that walk.
const DETECTION_CACHE = new Map()

// Production reads the real fs; tests swap single primitives to COUNT the probes
// (the same seam config.mjs uses for its storage writers). Nothing here reads a
// hook unless a test installed one.
const NODE_FS = { existsSync, readFileSync, statSync }
let fsHooks = NODE_FS

/**
 * Replace a subset of the file primitives used by the version probe.
 * @param hooks - `{ existsSync?, readFileSync?, statSync? }`, or `null` to
 *   restore node:fs. Unlisted primitives keep the real implementation. The
 *   detection cache is dropped so a swapped fs can never be served a hit.
 */
export function setFsHooks(hooks) {
  fsHooks = hooks ? { ...NODE_FS, ...hooks } : NODE_FS
  DETECTION_CACHE.clear()
}

/** Minimum dbhub version whose TOML dialect this plugin generates. */
export const DBHUB_MIN_VERSION = '1.4.0'
/** Versions below this predate the TOML tool model entirely. */
export const DBHUB_TOML_SINCE = '1.0.0'

/**
 * Parse a semver-ish string into `{ major, minor, patch }`.
 * Accepts a leading `v`, prerelease/build suffixes, and returns `null` when
 * there is no leading numeric triplet.
 */
export function parseVersion(text) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''))
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) }
}

/** Compare two parsed versions: <0, 0, >0. */
export function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    const x = (a && a[k]) || 0
    const y = (b && b[k]) || 0
    if (x !== y) return x - y
  }
  return 0
}

/** True when `version` (parsed) is at or above `min` (string). */
export function atLeast(version, min) {
  const floor = parseVersion(min)
  if (!version || !floor) return false
  return compareVersions(version, floor) >= 0
}

/**
 * Read the version out of a mise-style layout path:
 * `…/npm-bytebase-dbhub/1.4.0/node_modules/.bin/dbhub.cmd`.
 * @returns a version string, or `''`.
 */
export function versionFromMisePath(exe) {
  const m = /npm-bytebase-dbhub[\\/]([^\\/]+)[\\/]/i.exec(String(exe || ''))
  if (!m) return ''
  return parseVersion(m[1]) ? m[1] : ''
}

/**
 * Walk up from the executable (bounded) looking for the owning package.json and
 * read its version. Works for the auto-managed install
 * (`<RUNTIME_DIR>/node_modules/@bytebase/dbhub/package.json`) and for any npm /
 * pnpm / mise layout that keeps the manifest above the shim.
 * @returns a version string, or `''`.
 */
export function versionFromPackageJson(exe) {
  const raw = String(exe || '').trim()
  if (!raw) return ''
  let dir
  try {
    dir = dirname(resolve(raw))
  } catch (e) {
    return ''
  }
  for (let i = 0; i < 6 && dir; i++) {
    // Three layouts matter, and all of them must be probed at EVERY level:
    //   · `<pkg>/package.json` — the mise shim package that pins dbhub;
    //   · `<dir>/node_modules/@bytebase/dbhub/package.json` — what
    //     `npm install @bytebase/dbhub --prefix <dir>` produces, i.e. the
    //     DEFAULT auto-managed install (and `npm -g` too);
    //   · `<dir>/node_modules/dbhub/package.json` — an unscoped install.
    for (const candidate of [
      join(dir, 'package.json'),
      join(dir, 'node_modules', '@bytebase', 'dbhub', 'package.json'),
      join(dir, 'node_modules', 'dbhub', 'package.json'),
    ]) {
      try {
        if (!fsHooks.existsSync(candidate) || !fsHooks.statSync(candidate).isFile()) continue
        const doc = JSON.parse(fsHooks.readFileSync(candidate, 'utf8'))
        const version = parseVersion(doc && doc.version) ? String(doc.version) : ''
        if (!version) continue
        // Only trust a manifest that IS dbhub: an unrelated package.json above
        // us (this plugin's own, say) must never lend it its version number.
        const name = String((doc && doc.name) || '')
        if (name === '@bytebase/dbhub' || name === 'dbhub') return version
      } catch (e) {
        /* keep walking */
      }
    }
    const parent = dirname(dir)
    if (!parent || parent === dir) break
    dir = parent
  }
  return ''
}

/** Resolve the installed dbhub version from an executable path ('' when unknown). */
export function detectVersion(exe) {
  return versionFromMisePath(exe) || versionFromPackageJson(exe)
}

/**
 * Map a version onto the two generated features.
 *  - `< 1.0.0`      → neither feature is supported (upgrade hint);
 *  - `1.0.0–1.3.x`  → allowed, but flagged "untested" so the UI can warn;
 *  - `>= 1.4.0`     → supported (the dialect this plugin was measured against);
 *  - unknown        → allowed with a warning (we cannot prove the version; the
 *                     real failure, if any, surfaces as a dbhub fatal error).
 * @returns `{ version, readonlyTools, ssh, warning }`.
 */
export function capabilitiesOf(rawVersion) {
  const version = String(rawVersion || '')
  const parsed = parseVersion(version)
  if (!parsed) {
    return { version, readonlyTools: true, ssh: true, warning: 'unknown' }
  }
  if (!atLeast(parsed, DBHUB_TOML_SINCE)) {
    return { version, readonlyTools: false, ssh: false, warning: 'tooOld' }
  }
  if (!atLeast(parsed, DBHUB_MIN_VERSION)) {
    return { version, readonlyTools: true, ssh: true, warning: 'untested' }
  }
  return { version, readonlyTools: true, ssh: true, warning: '' }
}

/**
 * Detection cache key: the path plus the executable's mtime (0 when it cannot be
 * stat'ed, which keeps the key stable for a layout whose shim does not exist).
 */
function cacheKeyOf(raw) {
  let stamp = 0
  if (raw) {
    try {
      stamp = Number(fsHooks.statSync(raw).mtimeMs) || 0
    } catch (e) {
      stamp = 0
    }
  }
  return raw + '\u0000' + String(stamp)
}

/** Drop every cached detection (tests / a deliberate re-probe). */
export function resetCapabilityCache() {
  DETECTION_CACHE.clear()
}

/**
 * Detect the capabilities of one resolved dbhub executable.
 * Never throws and never blocks: an unresolvable version is reported as
 * `unknown` and the features stay enabled (the caller only *uses* this on
 * read-only / SSH environments, and an genuine incompatibility surfaces as a
 * clear dbhub error).
 *
 * Cached per executable (see DETECTION_CACHE); a copy is returned so a caller can
 * never poison the cache.
 * @param exe - resolved dbhub executable path (may be undefined at boot).
 * @returns `{ version, readonlyTools, ssh, warning }`.
 */
export function detectDbhubCapabilities(exe) {
  const raw = String(exe === undefined || exe === null ? '' : exe).trim()
  const key = cacheKeyOf(raw)
  const hit = DETECTION_CACHE.get(key)
  if (hit) return { ...hit }
  let value
  try {
    value = capabilitiesOf(detectVersion(raw))
  } catch (e) {
    value = { version: '', readonlyTools: true, ssh: true, warning: 'unknown' }
  }
  DETECTION_CACHE.set(key, value)
  return { ...value }
}

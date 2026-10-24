// dsh-dbhub-live: the plugin's own update check (npm registry, GitHub fallback).
//
// This is a small, self-contained network probe used by the settings card: the
// Host asks "is a newer version of dsh-dbhub-live published?" and publishes the
// answer as a JSON view field. It is deliberately isolated from the dbhub
// runtime: no binary, no store, no DSN, no credentials — the ONLY secrets this
// module could ever see are none (both endpoints are public reads).
//
// Contract: `check()` NEVER rejects. Every failure becomes a short `error`
// string in the snapshot, and a previously known result is kept (stale) instead
// of being wiped, so a flaky network never turns the UI's version row blank.
//
// Dependency direction: a LEAF that imports only ./meta.mjs (semver helpers).
// lib/index.mjs imports it; nothing imports back.

import { PLUGIN_NAME, isNewer, parseSemver } from './meta.mjs'

/** Public npm dist-tag endpoint: `{ version }` for the `latest` tag. */
export const NPM_LATEST_URL = 'https://registry.npmjs.org/' + PLUGIN_NAME + '/latest'

/** Public GitHub releases API: `{ tag_name: 'v5.2.0', ... }`. */
export const GITHUB_LATEST_URL = 'https://api.github.com/repos/mr-mihu/dsh-dbhub-live/releases/latest'

/** Per-request budget. Two sources => at most ~2x this for one full check. */
export const DEFAULT_TIMEOUT_MS = 5000

/** Without `force`, a result younger than this is reused without any request. */
export const DEFAULT_THROTTLE_MS = 30 * 60 * 1000

const REQUEST_HEADERS = {
  accept: 'application/json',
  // GitHub's API rejects requests without a User-Agent (undici sets one, but an
  // explicit value names us in their logs).
  'user-agent': PLUGIN_NAME + '-host',
}

/** Parse a body into an object, tolerating a raw JSON string (fetch stubs). */
function bodyObject(body) {
  if (body && typeof body === 'object') return body
  if (typeof body !== 'string') return undefined
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch (e) {
    return undefined
  }
}

/**
 * Extract a version from the npm registry body (`{ version: '5.2.0' }`).
 * Pure; '' for any body without a semver-valid version.
 */
export function versionFromNpmBody(body) {
  const obj = bodyObject(body)
  const version = obj && typeof obj.version === 'string' ? obj.version.trim() : ''
  return parseSemver(version) ? version : ''
}

/**
 * Extract a version from the GitHub release body (`{ tag_name: 'v5.2.0' }`).
 * The release tag convention in this repo is `v<x.y.z>`, so one leading `v` is
 * stripped before validation. Pure; '' for anything else.
 */
export function versionFromGithubBody(body) {
  const obj = bodyObject(body)
  const raw = obj && typeof obj.tag_name === 'string' ? obj.tag_name.trim() : ''
  const version = raw.replace(/^[vV]/, '')
  return parseSemver(version) ? version : ''
}

/**
 * Turn any thrown value into a SHORT, sanitized message suitable for the view
 * (the card renders it inline). Never returns a URL: an error message from a
 * fetch stack can embed the request URL, and the view is browser-facing.
 */
function shortError(error) {
  if (error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR')) {
    return 'timeout'
  }
  let text = String((error && error.message) || error || 'unknown error')
  // Keep the low-level cause code (ENOTFOUND/ECONNREFUSED/...): it is the only
  // actionable part of a Node fetch error ("fetch failed").
  const cause = error && error.cause
  const code = cause && typeof cause.code === 'string' ? cause.code : ''
  text = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  if (code && !text.includes(code)) text = text ? text + ' (' + code + ')' : code
  if (text.length > 80) text = text.slice(0, 77) + '...'
  return text || 'request failed'
}

/**
 * Create a lazy update checker.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]   fetch-compatible implementation
 * @param {Function} [options.now]         clock (ms); injectable for tests
 * @param {string}   [options.npmUrl]      npm dist-tag endpoint
 * @param {string}   [options.githubUrl]   GitHub latest-release endpoint
 * @param {number}   [options.timeoutMs]   per-request budget
 * @param {number}   [options.throttleMs]  reuse window for non-forced checks
 * @param {string}   [options.currentVersion] installed plugin version to compare against
 * @returns {{ check: (force?: boolean) => Promise<object>, snapshot: () => object }}
 */
export function createUpdateChecker(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const npmUrl = typeof options.npmUrl === 'string' && options.npmUrl ? options.npmUrl : NPM_LATEST_URL
  const githubUrl = typeof options.githubUrl === 'string' && options.githubUrl
    ? options.githubUrl
    : GITHUB_LATEST_URL
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const throttleMs = Number.isFinite(options.throttleMs) && options.throttleMs >= 0
    ? options.throttleMs
    : DEFAULT_THROTTLE_MS
  const currentVersion = typeof options.currentVersion === 'string' ? options.currentVersion : ''

  // Last known result. `latest`/`source` survive a failed re-check on purpose
  // (see the module contract above).
  let state = { latest: '', latestSpec: '', hasUpdate: false, checkedAt: 0, source: '', error: '' }
  let inFlight

  const snapshot = () => ({ ...state })

  const safeNow = () => {
    try {
      const value = Number(now())
      return Number.isFinite(value) ? value : Date.now()
    } catch (e) {
      return Date.now()
    }
  }

  const throttled = () => state.checkedAt > 0 && safeNow() - state.checkedAt < throttleMs

  /**
   * One request, resolved to a parsed JSON body. A per-request AbortController
   * enforces the budget; the timer stays referenced until the request settles
   * (an unref'd timer would let the process drain before it fires) and is
   * always cleared.
   */
  const requestJson = async (url) => {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller
      ? setTimeout(() => {
        try {
          controller.abort()
        } catch (e) {
          /* already aborted */
        }
      }, timeoutMs)
      : undefined
    try {
      const response = await fetchImpl(url, {
        headers: REQUEST_HEADERS,
        signal: controller ? controller.signal : undefined,
      })
      if (!response || typeof response !== 'object') throw new Error('empty response')
      const status = typeof response.status === 'number' ? response.status : 0
      const ok = typeof response.ok === 'boolean'
        ? response.ok
        : status === 0 || (status >= 200 && status < 300)
      if (!ok) throw new Error('HTTP ' + (status || 'error'))
      if (typeof response.json === 'function') return await response.json()
      if (typeof response.text === 'function') {
        const text = await response.text()
        return text ? JSON.parse(text) : undefined
      }
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Try one source; return the version or '' after recording its error. */
  const attempt = async (label, url, extract, errors) => {
    try {
      const version = extract(await requestJson(url))
      if (!version) throw new Error('invalid version in response')
      return version
    } catch (e) {
      errors.push(label + ': ' + shortError(e))
      return ''
    }
  }

  const runCheck = async () => {
    const errors = []
    let latest = ''
    let source = ''
    try {
      latest = await attempt('npm', npmUrl, versionFromNpmBody, errors)
      if (latest) source = 'npm'
      if (!latest) {
        latest = await attempt('github', githubUrl, versionFromGithubBody, errors)
        if (latest) source = 'github'
      }
    } catch (e) {
      // Belt and braces: `attempt` already absorbs its own failures.
      errors.push(shortError(e))
    }
    const checkedAt = safeNow()
    if (latest) {
      state = {
        latest,
        latestSpec: PLUGIN_NAME + '@' + latest,
        hasUpdate: isNewer(latest, currentVersion),
        checkedAt,
        source,
        error: '',
      }
    } else {
      state = {
        // Keep whatever we knew: a transient failure is not "no release".
        latest: state.latest,
        latestSpec: state.latestSpec,
        hasUpdate: state.hasUpdate,
        checkedAt,
        source: state.source,
        error: errors.join('; ') || 'no version found',
      }
    }
    return snapshot()
  }

  /**
   * Run (or reuse) the check. Concurrent calls share one in-flight promise, so
   * a double click or a page reload cannot double the request burst.
   */
  const check = (force) => {
    if (inFlight) return inFlight
    if (!force && throttled()) return Promise.resolve(snapshot())
    inFlight = runCheck().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  return { check, snapshot }
}

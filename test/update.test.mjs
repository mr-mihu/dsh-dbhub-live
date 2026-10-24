// Unit tests for the plugin self-update check (lib/update.mjs): npm-first with a
// GitHub fallback, prerelease-aware hasUpdate, error sanitization, the 30 min
// throttle, `force`, concurrent-call dedupe and the per-request timeout.
//
// Everything is driven through an injected fetch stub and an injected clock, so
// these tests never touch the network and never wait on a real timer.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_THROTTLE_MS,
  GITHUB_LATEST_URL,
  NPM_LATEST_URL,
  createUpdateChecker,
  versionFromGithubBody,
  versionFromNpmBody,
} from '../lib/update.mjs'

// ── helpers ───────────────────────────────────────────────────────────────

/** A fetch stub that answers from a per-URL table: value = body | {status}. */
function stubFetch(routes) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const route = routes[url]
    if (!route) throw new Error('unexpected url ' + url)
    if (route instanceof Error) throw route
    if (typeof route === 'function') return route(url)
    const status = typeof route.status === 'number' ? route.status : 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    }
  }
  impl.calls = calls
  impl.byUrl = (needle) => calls.filter((url) => url.includes(needle)).length
  return impl
}

const ok = (body) => ({ status: 200, body })
const fail = (status) => ({ status })

function checker(overrides = {}) {
  return createUpdateChecker({
    currentVersion: '5.1.1-dev.1',
    now: () => 1000,
    ...overrides,
  })
}

const NPM_OK = { [NPM_LATEST_URL]: ok({ version: '5.2.0' }) }
const GH_OK = { [GITHUB_LATEST_URL]: ok({ tag_name: 'v5.2.0' }) }

// ── pure body extractors ──────────────────────────────────────────────────

test('versionFromNpmBody accepts objects and raw JSON strings, rejects junk', () => {
  assert.equal(versionFromNpmBody({ version: '5.2.0' }), '5.2.0')
  assert.equal(versionFromNpmBody({ version: ' 5.2.0-dev.1 ' }), '5.2.0-dev.1')
  assert.equal(versionFromNpmBody('{"version":"5.2.0"}'), '5.2.0')
  assert.equal(versionFromNpmBody({ version: 'latest' }), '')
  assert.equal(versionFromNpmBody({ version: '' }), '')
  assert.equal(versionFromNpmBody({}), '')
  assert.equal(versionFromNpmBody(null), '')
  assert.equal(versionFromNpmBody('not json'), '')
})

test('versionFromGithubBody strips the release tag v prefix', () => {
  assert.equal(versionFromGithubBody({ tag_name: 'v5.2.0' }), '5.2.0')
  assert.equal(versionFromGithubBody({ tag_name: '5.2.0' }), '5.2.0')
  assert.equal(versionFromGithubBody({ tag_name: 'V5.2.0-dev.3' }), '5.2.0-dev.3')
  assert.equal(versionFromGithubBody('{"tag_name":"v5.2.0"}'), '5.2.0')
  assert.equal(versionFromGithubBody({ tag_name: 'vnext' }), '')
  assert.equal(versionFromGithubBody({ name: 'v5.2.0' }), '')
  assert.equal(versionFromGithubBody(null), '')
})

// ── happy path + fallback ─────────────────────────────────────────────────

test('npm success produces the full snapshot', async () => {
  const fetchImpl = stubFetch(NPM_OK)
  const update = checker({ fetchImpl, now: () => 4242 })
  assert.deepEqual(update.snapshot(), {
    latest: '',
    latestSpec: '',
    hasUpdate: false,
    checkedAt: 0,
    source: '',
    error: '',
  }, 'nothing is claimed before the first check')
  const snap = await update.check()
  assert.deepEqual(snap, {
    latest: '5.2.0',
    latestSpec: 'dsh-dbhub-live@5.2.0',
    hasUpdate: true,
    checkedAt: 4242,
    source: 'npm',
    error: '',
  })
  assert.deepEqual(fetchImpl.calls, [NPM_LATEST_URL], 'github is not asked when npm answered')
  // No rejected promise, no throw: check() resolves on every path.
  assert.deepEqual(update.snapshot(), snap)
})

test('npm failure falls back to the GitHub release tag', async () => {
  const fetchImpl = stubFetch({ [NPM_LATEST_URL]: fail(503), [GITHUB_LATEST_URL]: ok({ tag_name: 'v5.2.0' }) })
  const snap = await checker({ fetchImpl }).check()
  assert.equal(snap.source, 'github')
  assert.equal(snap.latest, '5.2.0')
  assert.equal(snap.latestSpec, 'dsh-dbhub-live@5.2.0')
  assert.equal(snap.hasUpdate, true)
  assert.equal(snap.error, '', 'a successful fallback clears the npm error')
})

test('an invalid npm payload also falls back instead of claiming a version', async () => {
  const fetchImpl = stubFetch({
    [NPM_LATEST_URL]: ok({ version: 'latest' }),
    [GITHUB_LATEST_URL]: ok({ tag_name: 'v5.2.0' }),
  })
  const snap = await checker({ fetchImpl }).check()
  assert.equal(snap.latest, '5.2.0')
  assert.equal(snap.source, 'github')
  assert.equal(snap.error, '')
})

test('both sources failing yields a short error and KEEPS the previous result', async () => {
  let clock = 1000
  let current = stubFetch(NPM_OK)
  // One checker; the stub it calls is swapped between runs (like a network
  // that worked once and then went down).
  const flaky = createUpdateChecker({
    currentVersion: '5.1.1-dev.1',
    now: () => clock,
    throttleMs: 0,
    fetchImpl: (url, init) => current(url, init),
  })
  const good = await flaky.check()
  assert.equal(good.latest, '5.2.0')
  assert.equal(good.error, '')

  current = stubFetch({ [NPM_LATEST_URL]: fail(503), [GITHUB_LATEST_URL]: fail(500) })
  clock = 60_000
  const bad = await flaky.check(true)
  assert.equal(bad.latest, '5.2.0', 'stale latest preserved')
  assert.equal(bad.latestSpec, 'dsh-dbhub-live@5.2.0')
  assert.equal(bad.source, 'npm')
  assert.equal(bad.hasUpdate, true)
  assert.equal(bad.checkedAt, 60_000, 'checkedAt advances even on failure')
  assert.equal(bad.error, 'npm: HTTP 503; github: HTTP 500')

  // A brand-new checker has nothing to preserve: a failure leaves it empty.
  const fresh = createUpdateChecker({
    currentVersion: '5.1.1-dev.1',
    now: () => clock,
    fetchImpl: stubFetch({ [NPM_LATEST_URL]: fail(503), [GITHUB_LATEST_URL]: fail(500) }),
  })
  const empty = await fresh.check(true)
  assert.equal(empty.latest, '')
  assert.equal(empty.latestSpec, '')
  assert.equal(empty.hasUpdate, false)
  assert.equal(empty.source, '')
  assert.equal(empty.error, 'npm: HTTP 503; github: HTTP 500')
})

test('hasUpdate is strictly-newer and prerelease-aware', async () => {
  const cases = [
    // current, latest, expected hasUpdate
    ['5.1.1-dev.1', '5.2.0', true, 'a newer release'],
    ['5.2.0-dev.1', '5.2.0', true, 'the release supersedes its own dev build'],
    ['5.2.0', '5.2.0-dev.2', false, 'a dev build is older than the release'],
    ['5.2.0', '5.2.0', false, 'equal versions'],
    ['5.2.0', '5.1.0', false, 'an older release'],
    ['5.1.0', '5.2.0-dev.1', true, 'a newer dev build'],
    ['', '5.2.0', false, 'unknown current version never claims an update'],
  ]
  for (const [currentVersion, latest, expected, why] of cases) {
    const fetchImpl = stubFetch({ [NPM_LATEST_URL]: ok({ version: latest }) })
    const snap = await createUpdateChecker({ currentVersion, fetchImpl, now: () => 1 }).check(true)
    assert.equal(snap.hasUpdate, expected, currentVersion + ' -> ' + latest + ' (' + why + ')')
    assert.equal(snap.latest, latest)
  }
})

// ── throttle / force / dedupe ─────────────────────────────────────────────

test('a second check inside the throttle window makes no request', async () => {
  let clock = 10_000
  const fetchImpl = stubFetch(NPM_OK)
  const update = createUpdateChecker({ fetchImpl, now: () => clock })
  const first = await update.check()
  assert.equal(fetchImpl.calls.length, 1)

  clock = 10_000 + DEFAULT_THROTTLE_MS - 1
  const reused = await update.check()
  assert.deepEqual(reused, first, 'the snapshot is reused verbatim')
  assert.equal(fetchImpl.calls.length, 1, 'no new request inside the throttle window')

  // `force` always refetches, even immediately.
  const forced = await update.check(true)
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(forced.checkedAt, clock)
})

test('concurrent checks share one in-flight request', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = stubFetch({
    [NPM_LATEST_URL]: async () => {
      await gate
      return { ok: true, status: 200, json: async () => ({ version: '5.2.0' }) }
    },
  })
  const update = createUpdateChecker({ fetchImpl, now: () => 7 })
  const first = update.check(true)
  const second = update.check(true)
  assert.equal(first, second, 'the same promise is handed to every concurrent caller')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(fetchImpl.calls.length, 1, 'one request burst, not one per caller')
})

test('a failing check never rejects and error text is sanitized', async () => {
  const fetchImpl = stubFetch({
    [NPM_LATEST_URL]: new Error('boom https://registry.npmjs.org/dsh-dbhub-live/latest?token=abc123'),
    [GITHUB_LATEST_URL]: new Error('fetch failed'),
  })
  const snap = await createUpdateChecker({ fetchImpl, now: () => 5 }).check(true)
  assert.equal(snap.latest, '')
  assert.equal(snap.source, '')
  assert.match(snap.error, /^npm: /)
  assert.match(snap.error, /github: /)
  assert.ok(!snap.error.includes('http'), 'no URL survives into the view: ' + snap.error)
  assert.ok(!snap.error.includes('token='), 'no query token survives into the view: ' + snap.error)
  assert.ok(snap.error.length <= 200, 'the message stays short')
})

test('a request that outlives the budget is aborted and reported as timeout', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const signal = init && init.signal
    if (!signal) {
      reject(new Error('no abort signal was passed'))
      return
    }
    const abort = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort)
  })
  const snap = await createUpdateChecker({ fetchImpl, now: () => 1, timeoutMs: 20 }).check(true)
  assert.equal(snap.latest, '')
  assert.equal(snap.source, '')
  assert.equal(snap.error, 'npm: timeout; github: timeout')
  assert.equal(snap.checkedAt, 1)
})

test('snapshot() returns a detached copy', async () => {
  const update = checker({ fetchImpl: stubFetch(NPM_OK) })
  await update.check(true)
  const snap = update.snapshot()
  snap.latest = 'tampered'
  snap.hasUpdate = false
  assert.equal(update.snapshot().latest, '5.2.0')
  assert.equal(update.snapshot().hasUpdate, true)
})

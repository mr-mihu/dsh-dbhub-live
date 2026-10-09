// dsh-dbhub-live: the F4 connection-test fast path (lib/mcp.mjs).
//
// A card connection test must not re-walk every workspace when the answer is
// already known: the store is authoritative for a PERSISTED row, and the live
// row cache holds exactly the row the card is showing. Only when neither tier
// knows the row may the caller pay for a real walk — and a walk is expensive,
// because it spawns `mise env` for every workspace without a persisted default.
//
// The three tiers (`resolveTestDsn`) are pure; `cachedRows`/`cachedRow`/
// `hasRowCache` are the module-level accessors the caller feeds it.
//
// Test isolation: config.mjs/mcp.mjs derive the storage dir from DSH_HOME at
// import time, so point it at a temp dir BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-testop-'))
process.env.DSH_HOME = home

const cfg = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── fixtures ───────────────────────────────────────────────────────────────
//
// One logical row (workspace × 'prod') is described by all three tiers; a
// second workspace has NO persisted environment, so its row can only come from
// a real walk (auto-discovery) — that is the case tier 3 exists for.

const WS = 'D:/work/fast'
const WS_AUTO = 'D:/work/auto'
const DSN_DEFAULT = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
const DSN_PROD = 'mysql://user:CHANGE_ME@127.0.0.1:3307/app'
const DSN_AUTO = 'mysql://user:CHANGE_ME@127.0.0.1:3308/auto'
const SSH = { host: '192.0.2.10', port: 22, user: 'ops', auth: 'password', password: 'CHANGE_ME' }

// Persist through the real store API, so tier 1 reads the same row shape
// index.mjs hands to resolveTestDsn. WS_AUTO deliberately stays unpersisted.
cfg.setWorkspaceEnv(WS, 'default', DSN_DEFAULT, 'user')
cfg.setWorkspaceEnv(WS, 'prod', DSN_PROD, 'user')
cfg.setWorkspaceEnvOptions(WS, 'prod', { readOnly: true, ssh: SSH })

/** The ctx mcp.collectSources needs: a workspace registry + a .env resolver. */
const ctx = {
  get(name) {
    if (name === 'workspaceRegistry') {
      return { list: async () => [{ path: WS, title: 'fast' }, { path: WS_AUTO, title: 'auto' }] }
    }
    if (name === 'fs') return { resolve: async () => { throw new Error('no .env') } }
    return undefined
  },
}

/** A subprocess stand-in whose `mise env` answers with an auto-discovered DSN. */
const subprocess = {
  resolveExecutable: async (name) => '/fake/bin/' + name,
  spawn() {
    return {
      stdout: { on(_event, handler) { handler(Buffer.from('DSN=' + DSN_AUTO + '\n')) } },
      done: Promise.resolve({ exitCode: 0 }),
      terminate() {},
    }
  },
}

// ── tier 1: the persisted store row ────────────────────────────────────────

test('tier 1: a persisted store row wins, options included, with no walk', () => {
  const storeRows = cfg.listWorkspaceEnvironments(cfg.store)
  const prod = storeRows.find((r) => r.wsPath === WS && r.env === 'prod')
  assert.ok(prod, 'the fixture row must be persisted')
  assert.equal(prod.dsn, DSN_PROD)

  const picked = mcp.resolveTestDsn({ wsPath: WS, env: 'prod', storeRows, cachedRows: [], hasCache: false })
  assert.ok(picked, 'the store alone answers — the caller never has to walk')
  assert.equal(picked.from, 'store')
  assert.equal(picked.dsn, DSN_PROD)
  assert.equal(picked.ro, true, 'the read-only flag travels with the row')
  assert.equal(picked.ssh.auth, 'password')
  assert.equal(picked.ssh.password, 'CHANGE_ME')
})

// ── tier 2: the cached row the card is showing ─────────────────────────────

test('tier 2: with no store row, the already-cached row answers', () => {
  const cache = [{ wsPath: WS, env: 'prod', dsn: DSN_PROD, ro: false, ssh: null }]
  const picked = mcp.resolveTestDsn({ wsPath: WS, env: 'prod', storeRows: [], cachedRows: cache, hasCache: true })
  assert.ok(picked)
  assert.equal(picked.from, 'cache')
  assert.equal(picked.dsn, DSN_PROD, 'the same target tier 1 describes')
  // A cold cache is no cache: a cached array alone must not short-circuit the
  // walk (the caller passes hasCache = hasRowCache()).
  assert.equal(
    mcp.resolveTestDsn({ wsPath: WS, env: 'prod', storeRows: [], cachedRows: cache, hasCache: false }),
    null,
    'an unwalked cache must not answer',
  )
})

// ── tier 3: nothing known → the caller must walk ───────────────────────────

test('tier 3: nothing known returns null, then a real walk fills the cache', async () => {
  // Neither the store (never persisted) nor any completed walk knows this row.
  assert.equal(
    mcp.resolveTestDsn({ wsPath: WS_AUTO, env: 'default', storeRows: [], cachedRows: [], hasCache: false }),
    null,
    'the caller must walk before it can answer',
  )

  const { rows } = await mcp.collectSources(ctx, subprocess)
  assert.equal(mcp.hasRowCache(), true, 'the walk completed and armed the cache')
  assert.equal(rows.some((r) => r.wsPath === WS_AUTO && r.env === 'default' && r.dsn === DSN_AUTO), true)
  assert.equal(rows.some((r) => r.wsPath === WS_AUTO && r.persisted === false), true, 'the auto row is not persisted')

  // The same query, now fed from the module cache, resolves the same DSN.
  const walked = mcp.resolveTestDsn({
    wsPath: WS_AUTO, env: 'default', storeRows: [], cachedRows: mcp.cachedRows(), hasCache: mcp.hasRowCache(),
  })
  assert.ok(walked)
  assert.equal(walked.from, 'cache')
  assert.equal(walked.dsn, DSN_AUTO)

  // …and the persisted logical row resolves from the cache to the SAME DSN the
  // store tier returned above: all three tiers describe one target.
  const prod = mcp.resolveTestDsn({
    wsPath: WS, env: 'prod', storeRows: [], cachedRows: mcp.cachedRows(), hasCache: mcp.hasRowCache(),
  })
  assert.ok(prod)
  assert.equal(prod.from, 'cache')
  assert.equal(prod.dsn, DSN_PROD)

  // The accessors describe the same row, with the env name normalized.
  assert.equal(mcp.cachedRow(WS, ' prod ').dsn, DSN_PROD)
  assert.equal(mcp.cachedRow('D:/work/other', 'prod'), undefined)
  // cachedRows() hands out a copy: a caller cannot corrupt the cache.
  const copy = mcp.cachedRows()
  copy.push({ wsPath: 'D:/work/injected', env: 'default', dsn: DSN_DEFAULT })
  assert.equal(mcp.cachedRows().some((r) => r.wsPath === 'D:/work/injected'), false)
})

// ── env-name normalization ─────────────────────────────────────────────────

test('environment names are normalized on both sides of the match', () => {
  const storeRows = [{ wsPath: WS, env: 'prod', dsn: DSN_PROD, ro: false, ssh: null }]
  const spaced = mcp.resolveTestDsn({ wsPath: WS, env: ' prod ', storeRows, cachedRows: [], hasCache: false })
  assert.ok(spaced, 'a row stored as prod must match a query for " prod "')
  assert.equal(spaced.from, 'store')
  assert.equal(spaced.dsn, DSN_PROD)

  // A blank name is the reserved 'default' environment (mirrors the Host).
  const blank = mcp.resolveTestDsn({
    wsPath: WS, env: '  ', storeRows: [{ wsPath: WS, env: 'default', dsn: DSN_DEFAULT }], cachedRows: [], hasCache: false,
  })
  assert.ok(blank)
  assert.equal(blank.dsn, DSN_DEFAULT)

  // A cached row stored with stray whitespace matches a clean query too.
  const cached = mcp.resolveTestDsn({
    wsPath: WS, env: 'prod', storeRows: [], cachedRows: [{ wsPath: WS, env: ' prod ', dsn: DSN_PROD }], hasCache: true,
  })
  assert.ok(cached)
  assert.equal(cached.from, 'cache')
  assert.equal(cached.dsn, DSN_PROD)

  // A different workspace path is a different target — never a match.
  assert.equal(
    mcp.resolveTestDsn({ wsPath: 'D:/work/other', env: 'prod', storeRows, cachedRows: [], hasCache: false }),
    null,
  )
  // A row without a DSN cannot be probed.
  assert.equal(
    mcp.resolveTestDsn({ wsPath: WS, env: 'prod', storeRows: [{ wsPath: WS, env: 'prod' }], cachedRows: [], hasCache: false }),
    null,
  )
})

// ── the cache is per module instance ───────────────────────────────────────

test('hasRowCache/cachedRows/cachedRow are empty in a fresh mcp.mjs instance', async () => {
  await mcp.collectSources(ctx, subprocess)
  assert.equal(mcp.hasRowCache(), true, 'the shared instance has walked')

  // A query string yields a separate module instance with its own cache, while
  // config.mjs (the store) stays shared — exactly the isolation the test needs.
  const fresh = await import('../lib/mcp.mjs?fresh=' + Date.now())
  assert.notEqual(fresh, mcp, 'the query string must load a distinct instance')
  assert.equal(fresh.hasRowCache(), false, 'no walk has completed in the fresh instance')
  assert.deepEqual(fresh.cachedRows(), [], 'the fresh cache is empty')
  assert.equal(fresh.cachedRow(WS, 'prod'), undefined)
  assert.equal(
    fresh.resolveTestDsn({ wsPath: WS, env: 'prod', storeRows: [], cachedRows: fresh.cachedRows(), hasCache: fresh.hasRowCache() }),
    null,
    'a cold instance cannot answer from its cache',
  )
  assert.ok(
    fresh.resolveTestDsn({
      wsPath: WS, env: 'prod', storeRows: cfg.listWorkspaceEnvironments(cfg.store), cachedRows: [], hasCache: false,
    }),
    'the shared store still answers a fresh instance',
  )
})

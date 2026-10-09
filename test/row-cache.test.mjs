// Unit tests for the local row patch behind the card's instant feedback
// (lib/mcp.mjs). Test isolation: mcp.mjs pulls in config.mjs, which derives the
// storage directory from DSH_HOME at import time, so point it at a temp dir
// BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-rowcache-'))
process.env.DSH_HOME = home

const mcp = await import('../lib/mcp.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

const row = (title, wsPath, env, dsn, extra = {}) =>
  Object.assign({ wsPath, title, env, dsn, source: 'persisted(user)', persisted: true }, extra)

const base = () => [
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app'),
  row('app', 'D:/work/app', 'prod', 'mysql://127.0.0.1:3307/app'),
  row('docs', 'D:/work/docs', 'default', 'sqlite://127.0.0.1:0/docs', { source: '工作目录 .env', persisted: false }),
]

test('applyRowPatch adds a row without touching the input array', () => {
  const rows = base()
  const next = mcp.applyRowPatch(rows, {
    op: 'add', path: 'D:/work/new', title: 'new', env: 'default', dsn: 'postgres://127.0.0.1:5432/new',
  })
  assert.equal(rows.length, 3, 'input stays untouched')
  assert.equal(next.length, 4)
  const added = next[next.length - 1]
  assert.deepEqual(
    { wsPath: added.wsPath, title: added.title, env: added.env, source: added.source, persisted: added.persisted },
    { wsPath: 'D:/work/new', title: 'new', env: 'default', source: 'persisted(user)', persisted: true },
  )
})

test('applyRowPatch replaces the same workspace+environment', () => {
  const next = mcp.applyRowPatch(base(), {
    op: 'add', path: 'D:/work/app', env: 'prod', dsn: 'mysql://127.0.0.1:3399/other',
  })
  assert.equal(next.length, 3, 'no duplicate row appears')
  const prod = next.find((r) => r.wsPath === 'D:/work/app' && r.env === 'prod')
  assert.equal(prod.dsn, 'mysql://127.0.0.1:3399/other')
  assert.equal(prod.title, 'app', 'the known workspace title is kept')
})

test('applyRowPatch drops a removed row and keeps the other workspaces', () => {
  const next = mcp.applyRowPatch(base(), { op: 'remove', path: 'D:/work/app', env: 'prod' })
  assert.equal(next.length, 2)
  assert.equal(next.some((r) => r.wsPath === 'D:/work/app' && r.env === 'prod'), false)
  assert.equal(next.filter((r) => r.wsPath === 'D:/work/app').length, 1)
})

test('applyRowPatch moves a renamed row and never leaves the old name behind', () => {
  const next = mcp.applyRowPatch(base(), { op: 'rename', path: 'D:/work/app', from: 'prod', env: 'staging' })
  assert.equal(next.length, 3)
  assert.equal(next.some((r) => r.env === 'prod' && r.wsPath === 'D:/work/app'), false)
  const moved = next.find((r) => r.env === 'staging')
  assert.equal(moved.dsn, 'mysql://127.0.0.1:3307/app', 'the connection travels with the name')
  assert.equal(moved.title, 'app')
})

test('applyRowPatch renaming onto an existing name keeps exactly one row', () => {
  const next = mcp.applyRowPatch(base(), { op: 'rename', path: 'D:/work/app', from: 'default', env: 'prod' })
  assert.equal(next.filter((r) => r.wsPath === 'D:/work/app').length, 1)
  assert.equal(next.find((r) => r.wsPath === 'D:/work/app').env, 'prod')
})

test('applying the same rename twice is a no-op (a walk may already have done it)', () => {
  const once = mcp.applyRowPatch(base(), { op: 'rename', path: 'D:/work/app', from: 'default', env: 'staging' })
  const twice = mcp.applyRowPatch(once, { op: 'rename', path: 'D:/work/app', from: 'default', env: 'staging' })
  assert.deepEqual(twice, once, 'the row must not be dropped by a repeated patch')
  assert.equal(twice.filter((r) => r.wsPath === 'D:/work/app').length, 2)
})

test('the row mirror re-applies a patch that landed while a walk was running', () => {
  // The live failure this guards: a walk started BEFORE the write finished AFTER
  // it and published a list without the row the card had just shown.
  const mirror = mcp.createRowMirror()
  const walkStarted = mirror.beginWalk() // walk begins with nothing pending
  assert.equal(walkStarted, 0)
  mirror.patch({ op: 'add', path: 'D:/work/app', title: 'app', env: 'pro', dsn: 'mysql://127.0.0.1:3308/app' })
  assert.equal(mirror.pendingCount(), 1)
  // the walk lands: it re-applies the late patch, so the row survives
  const summaries = mirror.endWalk(walkStarted)
  assert.equal(summaries.some((s) => s.env === 'pro' && s.path === 'D:/work/app'), true)
  assert.equal(mirror.pendingCount(), 1, 'still held until a walk that started after it lands')
  // the follow-up walk started after the patch, so the patch is released
  const after = mirror.endWalk(mirror.beginWalk())
  assert.equal(after.some((s) => s.env === 'pro'), true)
  assert.equal(mirror.pendingCount(), 0)
})

test('a walk that lands without the new row cannot erase it', async () => {
  // Reproduces the reported flicker end to end at module level: a walk started
  // BEFORE the card's write finishes AFTER it and replaces the cache with its own,
  // older row set (the card showed the new row, then lost it again).
  const mirror = mcp.createRowMirror()
  const startedWith = mirror.beginWalk() // walk begins with nothing pending
  const shown = mirror.patch({ op: 'add', path: 'D:/work/w', title: 'w', env: 'pro', dsn: 'mysql://127.0.0.1:3308/w' })
  assert.equal(shown.some((s) => s.env === 'pro'), true, 'the write is visible immediately')
  await mcp.collectSources({ get: () => undefined }, undefined) // the stale walk clobbers the cache
  const after = mirror.endWalk(startedWith)
  assert.equal(after.some((s) => s.env === 'pro' && s.path === 'D:/work/w'), true, 'the patch survives the walk')
  assert.equal(mirror.pendingCount(), 1, 'held until a walk that started after it lands')
  const settled = mirror.endWalk(mirror.beginWalk())
  assert.equal(settled.some((s) => s.env === 'pro'), true)
  assert.equal(mirror.pendingCount(), 0)
})

test('a patched row still summarizes to metadata only (no DSN, no credentials)', () => {
  const rows = mcp.applyRowPatch([], {
    op: 'add', path: 'D:/work/app', title: 'app', env: 'prod',
    dsn: 'mysql://user:CHANGE_ME@127.0.0.1:3307/app',
  })
  const summaries = mcp.summarizeRows(rows)
  assert.equal(summaries.length, 1)
  assert.deepEqual(
    Object.keys(summaries[0]).sort(),
    ['conn', 'env', 'path', 'persisted', 'ro', 'source', 'ssh', 'srcId', 'title'].sort(),
  )
  const text = JSON.stringify(summaries)
  assert.equal(text.includes('CHANGE_ME'), false)
  assert.equal(text.includes('mysql://user'), false, 'no credentialed URL shape survives')
  assert.equal(text.includes('"dsn"'), false)
  assert.equal(summaries[0].conn, 'mysql://127.0.0.1:3307/app')
  assert.equal(summaries[0].source, 'persisted(user)', 'provenance stays, credentials do not')
  assert.equal(summaries[0].ro, false)
  assert.equal(summaries[0].ssh, null)
})

test('applyRowPatch carries the read-only flag and the secret-free tunnel metadata', () => {
  const rows = mcp.applyRowPatch([], {
    op: 'add', path: 'D:/work/app', title: 'app', env: 'prod',
    dsn: 'mysql://127.0.0.1:3307/app', ro: true,
    ssh: { host: 'bastion.example.com', port: 22, user: 'ops', auth: 'password', password: 'CHANGE_ME' },
  })
  const s = mcp.summarizeRows(rows)[0]
  assert.equal(rows[0].ro, true)
  assert.equal(s.ro, true)
  assert.equal(s.ssh.authKind, 'password')
  assert.equal(s.ssh.hasPassword, true)
  assert.equal(JSON.stringify(s).includes('CHANGE_ME'), false, 'the tunnel secret never reaches the mirror')
  assert.equal(JSON.stringify(s).includes('bastion.example.com'), true, 'the host is metadata, not a secret')
})

test('the options patch flips a row in place and is idempotent', () => {
  const rows = mcp.applyRowPatch(base(), {
    op: 'options', path: 'D:/work/app', env: 'prod', ro: true, ssh: null,
  })
  assert.equal(rows.length, 3, 'no row is added or removed')
  const prod = rows.find((r) => r.wsPath === 'D:/work/app' && r.env === 'prod')
  assert.equal(prod.ro, true)
  assert.equal(prod.dsn, 'mysql://127.0.0.1:3307/app', 'the connection is untouched')
  const twice = mcp.applyRowPatch(rows, { op: 'options', path: 'D:/work/app', env: 'prod', ro: true, ssh: null })
  assert.deepEqual(twice, rows)
  // A patch for a row that is not there changes nothing (no phantom row).
  assert.deepEqual(mcp.applyRowPatch(rows, { op: 'options', path: 'D:/work/none', env: 'prod', ro: true }), rows)
})

test('cachedRows/cachedRow expose the host-side rows the card is showing', async () => {
  // Earlier tests in this file already walked once, so the cache is warm; what
  // matters is that the accessors track the cache AND the patch layer.
  assert.ok(Array.isArray(mcp.cachedRows()))
  const mirror = mcp.createRowMirror()
  mirror.patch({ op: 'add', path: 'D:/work/app', title: 'app', env: 'default', dsn: 'mysql://127.0.0.1:3306/app' })
  const hit = mcp.cachedRow('D:/work/app', 'default')
  assert.ok(hit, 'a patched row is visible through cachedRow')
  assert.equal(hit.dsn, 'mysql://127.0.0.1:3306/app')
  assert.equal(mcp.cachedRows().filter((r) => r.env === 'default').length, 1)
  // A missing row is undefined, never a throw.
  assert.equal(mcp.cachedRow('D:/work/none', 'prod'), undefined)
})

test('concurrent collectSources calls share ONE walk', async () => {
  // A walk spawns `mise env` per workspace without a persisted default; the card
  // publish, a model list and a connection test can all land in the same second.
  const { resetAutoDsnCache } = await import('../lib/config.mjs')
  resetAutoDsnCache()
  let spawns = 0
  const subprocess = {
    resolveExecutable: async () => '/fake/mise',
    spawn: () => {
      spawns += 1
      return {
        stdout: { on: () => {} },
        done: Promise.resolve({ exitCode: 1 }),
        terminate: () => {},
      }
    },
  }
  const ctx = {
    get: (name) => (name === 'fs' ? { resolve: async () => { throw new Error('no .env') } } : undefined),
  }
  const [a, b] = await Promise.all([
    mcp.collectSources(ctx, subprocess),
    mcp.collectSources(ctx, subprocess),
  ])
  assert.equal(a, b, 'both callers receive the same walk result')
  assert.equal(spawns, 1, 'the in-flight walk was shared, not duplicated')
  // A deliberate rescan bypasses the in-flight handle — and, once the short
  // auto-discovery cache is cleared, really spawns again.
  resetAutoDsnCache()
  await mcp.collectSources(ctx, subprocess, { force: true })
  assert.equal(spawns, 2)
})

test('resolveTestDsn prefers the store, then the cached row, then asks for a walk', () => {
  const storeRow = { wsPath: 'D:/work/app', env: 'default', dsn: 'mysql://127.0.0.1:3306/store', ro: true, ssh: null }
  const cacheRow = { wsPath: 'D:/work/app', env: 'default', dsn: 'mysql://127.0.0.1:3306/store', ro: false, ssh: null }
  const fromStore = mcp.resolveTestDsn({ wsPath: 'D:/work/app', env: 'default', storeRows: [storeRow], cachedRows: [cacheRow], hasCache: true })
  assert.equal(fromStore.from, 'store')
  assert.equal(fromStore.dsn, storeRow.dsn)
  assert.equal(fromStore.ro, true, 'the authoritative row wins, options included')
  const fromCache = mcp.resolveTestDsn({ wsPath: 'D:/work/app', env: 'default', storeRows: [], cachedRows: [cacheRow], hasCache: true })
  assert.equal(fromCache.from, 'cache')
  assert.equal(fromCache.dsn, storeRow.dsn, 'all three tiers describe the same target')
  // Auto-discovered and never walked: the caller MUST walk (a cold cache cannot
  // prove a connection does not exist).
  assert.equal(mcp.resolveTestDsn({ wsPath: 'D:/work/app', env: 'default', storeRows: [], cachedRows: [], hasCache: false }), null)
  // Environment names are normalized before matching (mirrors the Host).
  const spaced = mcp.resolveTestDsn({ wsPath: 'D:/work/app', env: ' ' , storeRows: [storeRow], cachedRows: [], hasCache: false })
  assert.equal(spaced.from, 'store')
})

test('applyRowPatch tolerates junk input', () => {
  assert.deepEqual(mcp.applyRowPatch(undefined, { op: 'remove', path: 'x', env: 'y' }), [])
  assert.deepEqual(mcp.applyRowPatch(base(), null), base())
  assert.deepEqual(mcp.applyRowPatch(base(), { op: 'unknown' }), base(), 'an unknown op adds nothing')
})

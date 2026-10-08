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
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['conn', 'env', 'path', 'persisted', 'source', 'srcId', 'title'])
  const text = JSON.stringify(summaries)
  assert.equal(text.includes('CHANGE_ME'), false)
  assert.equal(text.includes('mysql://user'), false, 'no credentialed URL shape survives')
  assert.equal(text.includes('"dsn"'), false)
  assert.equal(summaries[0].conn, 'mysql://127.0.0.1:3307/app')
  assert.equal(summaries[0].source, 'persisted(user)', 'provenance stays, credentials do not')
})

test('applyRowPatch tolerates junk input', () => {
  assert.deepEqual(mcp.applyRowPatch(undefined, { op: 'remove', path: 'x', env: 'y' }), [])
  assert.deepEqual(mcp.applyRowPatch(base(), null), base())
  assert.deepEqual(mcp.applyRowPatch(base(), { op: 'unknown' }), base(), 'an unknown op adds nothing')
})

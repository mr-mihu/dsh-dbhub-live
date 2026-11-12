// Maximum-rows tests: the environment-level row cap (`maxRows`), its per-call
// override on `dbhub_execute_sql`, and the pure capping pass that trims dbhub's
// JSON receipt.
//
// Two halves, deliberately:
//   1. the STORE / command half — persistence semantics (`0`/absent = unlimited,
//      explicit delete, illegal values refused without a write) and the card's
//      `{op:'options', maxRows}` path, against fresh config instances;
//   2. the PURE half — `resolveRowCap` (override priority) and
//      `capExecuteSqlText` (boundaries, multi-statement independence, count
//      preservation, fail-soft passthrough, localized notice), plus one
//      end-to-end tool call through a fake dbhub so "the argument is ours, not
//      dbhub's" and "the environment cap really reaches the model" are pinned
//      rather than assumed.
//
// Test isolation: config.mjs binds its storage paths at import time, so
// DSH_HOME points at a temp dir BEFORE importing; store tests use a fresh module
// instance per case (unique query string). Desensitization convention: loopback
// host, CHANGE_ME secret.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-maxrows-'))
process.env.DSH_HOME = home
// runtime.mjs prefers a mise-managed dbhub; the fake subprocess is the one and
// only executable this file may resolve.
delete process.env.MISE_DATA_DIR

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
const storePath = join(storeDir, 'credentials.json')
mkdirSync(storeDir, { recursive: true })

let seq = 0
function freshConfig() {
  seq += 1
  return import('../lib/config.mjs?maxrows=' + seq + '-' + Date.now())
}

/** A fresh config instance whose on-disk store starts from `doc` (undefined = empty). */
async function configWith(doc) {
  if (doc === undefined) rmSync(storePath, { force: true })
  else writeFileSync(storePath, JSON.stringify(doc, null, 2))
  return freshConfig()
}

const readStore = () => JSON.parse(readFileSync(storePath, 'utf8'))
const readStoreText = () => readFileSync(storePath, 'utf8')

// The plain instances other modules share: `index.applyOptionsOp` writes through
// this store object, and `tools.mjs` reads the same rows.
const base = await import('../lib/config.mjs')
const index = await import('../lib/index.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const i18n = await import('../lib/i18n.mjs')
const { registerCoreTools, resolveRowCap, capExecuteSqlText } = await import('../lib/tools.mjs')

const DSN = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
const WS = 'D:/ws/cap'

function seedBase(fixture) {
  for (const key of Object.keys(base.store)) delete base.store[key]
  Object.assign(base.store, fixture || {})
  base.saveStore(base.store)
}

const entryOf = (doc, ws = WS, env = 'prod') => doc[ws].environments[env]

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── store: persist / preserve / explicit delete ───────────────────────────

test('setWorkspaceEnv stores a positive cap and the listing describes it', async () => {
  const c = await configWith(undefined)
  c.setWorkspaceEnv(WS, 'prod', DSN, 'user', { maxRows: 250 })
  assert.equal(entryOf(readStore()).maxRows, 250)
  const row = c.listWorkspaceEnvironments(c.store).find((r) => r.env === 'prod')
  assert.equal(row.maxRows, 250)
  // The metadata shape the card receives carries the cap (and nothing secret).
  const opts = c.describeEnvOptions(c.store[WS].environments.prod)
  assert.deepEqual(Object.keys(opts).sort(), ['maxRows', 'ro', 'ssh'])
  assert.equal(opts.maxRows, 250)
  assert.equal(JSON.stringify(opts).includes('CHANGE_ME'), false)
})

test('a stored explicit 0 reads as unlimited and is dropped by an explicit write', async () => {
  const c = await configWith({
    [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 0 } } },
  })
  // A hand-edited `0` is semantically "no cap"; `normalizeStore` keeps unknown
  // env fields verbatim, so the value stays on disk until something writes it.
  assert.equal(c.listWorkspaceEnvironments(c.store)[0].maxRows, 0)
  assert.equal(c.describeEnvOptions(c.store[WS].environments.prod).maxRows, 0)
  c.setWorkspaceEnvOptions(WS, 'prod', { readOnly: true })
  assert.equal(entryOf(readStore()).maxRows, 0, 'an unrelated option write leaves it alone')
  c.setWorkspaceEnvOptions(WS, 'prod', { maxRows: 0 })
  assert.equal(entryOf(readStore()).maxRows, undefined, '0 written through the options op removes the field')
  assert.equal(entryOf(readStore()).readOnly, true)
})

test('an omitted patch or opts preserves the stored cap', async () => {
  const c = await configWith({
    [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 42 } } },
  })
  // A DSN-only update (no opts) must not clear the user's cap.
  c.setWorkspaceEnv(WS, 'prod', DSN, 'user')
  assert.equal(entryOf(readStore()).maxRows, 42)
  // An options write that says nothing about the cap keeps it too.
  c.setWorkspaceEnvOptions(WS, 'prod', { readOnly: true })
  assert.equal(entryOf(readStore()).maxRows, 42)
})

test('maxRows: 0 / null in a writer is an explicit delete (both writers)', async () => {
  const c = await configWith({
    [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 10 } } },
  })
  c.setWorkspaceEnvOptions(WS, 'prod', { maxRows: 0 })
  assert.equal(entryOf(readStore()).maxRows, undefined)
  c.setWorkspaceEnvOptions(WS, 'prod', { maxRows: 7 })
  assert.equal(entryOf(readStore()).maxRows, 7)
  c.setWorkspaceEnv(WS, 'prod', DSN, 'user', { maxRows: null })
  assert.equal(entryOf(readStore()).maxRows, undefined)
})

test('a non-integer option value refuses the write and changes nothing', async () => {
  const c = await configWith({
    [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 10 } } },
  })
  for (const bad of [-1, 1.5, 'abc', Number.NaN]) {
    const before = readStoreText()
    assert.throws(() => c.setWorkspaceEnvOptions(WS, 'prod', { maxRows: bad }), (err) => err.code === 'badMaxRows', String(bad))
    assert.equal(readStoreText(), before, 'nothing was written for ' + String(bad))
    assert.throws(() => c.setWorkspaceEnv(WS, 'prod', DSN, 'user', { maxRows: bad }), (err) => err.code === 'badMaxRows')
    assert.equal(readStoreText(), before, 'nothing was written for ' + String(bad) + ' (setWorkspaceEnv)')
  }
})

test('a hand-edited / unusable stored cap degrades to unlimited (never to 1 row)', async () => {
  const c = await configWith({
    [WS]: {
      environments: {
        neg: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: -5 },
        frac: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 1.5 },
        text: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 'lots' },
        nil: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: null },
        ok: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 9 },
      },
    },
  })
  const rows = c.listWorkspaceEnvironments(c.store)
  const byEnv = Object.fromEntries(rows.map((r) => [r.env, r.maxRows]))
  assert.deepEqual(byEnv, { neg: 0, frac: 0, text: 0, nil: 0, ok: 9 })
})

// ── the card command: `{op:'options', maxRows}` ───────────────────────────

test('the card options op writes, preserves and clears the cap', async () => {
  seedBase({ [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1 } } } })
  const ws = { path: WS, title: 'cap' }
  const lookup = async () => undefined

  let r = await index.applyOptionsOp({ env: 'prod', maxRows: 300 }, ws, lookup)
  assert.equal(r.error, undefined)
  assert.equal(readStore()[WS].environments.prod.maxRows, 300)
  assert.ok(r.patches.some((p) => p.op === 'options'))
  // The mirror patch carries the stored cap so the card re-renders what landed.
  const mirrored = index.mirrorPatchOf(r.patches.find((p) => p.op === 'options'))
  assert.equal(mirrored.maxRows, 300)
  assert.equal(mirrored.dsn, undefined, 'a mirror patch never carries a DSN')

  // An options write that says nothing about the cap preserves it.
  r = await index.applyOptionsOp({ env: 'prod', readOnly: true }, ws, lookup)
  assert.equal(r.error, undefined)
  assert.equal(readStore()[WS].environments.prod.maxRows, 300)

  // 0 clears the stored field (the explicit "unlimited").
  r = await index.applyOptionsOp({ env: 'prod', maxRows: 0 }, ws, lookup)
  assert.equal(r.error, undefined)
  assert.equal('maxRows' in readStore()[WS].environments.prod, false)
})

test('an illegal cap is refused through the card path with zero writes', async () => {
  seedBase({ [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 10 } } } })
  const ws = { path: WS, title: 'cap' }
  for (const bad of [-2, 2.5, 'many', Number.NaN]) {
    const before = readStoreText()
    const r = await index.applyOptionsOp({ env: 'prod', maxRows: bad }, ws, async () => undefined)
    assert.deepEqual(r.patches, [])
    assert.equal(r.error, 'badMaxRows', 'refused: ' + String(bad))
    assert.equal(readStoreText(), before, 'zero writes for ' + String(bad))
  }
})

test('an illegal cap cannot be smuggled next to a rename (no half-applied command)', async () => {
  seedBase({ [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1 } } } })
  const r = await index.applyOptionsOp(
    { env: 'prod', newEnv: 'renamed', maxRows: -1 },
    { path: WS, title: 'cap' },
    async () => undefined,
  )
  assert.equal(r.error, 'badMaxRows')
  const doc = readStore()
  assert.ok(doc[WS].environments.prod, 'the source row was not renamed')
  assert.equal(doc[WS].environments.renamed, undefined, 'the rename did not land')
})

test('the refused cap has its own localized sentence in both languages', () => {
  for (const locale of ['zh', 'en']) {
    const text = i18n.tFor(locale, 'result.badMaxRows')
    assert.notEqual(text, 'result.badMaxRows')
    assert.match(text, /0/)
  }
  assert.equal(/[\u4e00-\u9fff]/.test(i18n.tFor('en', 'result.badMaxRows')), false, 'the en copy must stay English')
})

// ── override priority (pure) ──────────────────────────────────────────────

test('the call argument overrides the environment cap, and 0 means unlimited', () => {
  assert.equal(resolveRowCap({}, 5), 5, 'omitted → environment setting')
  assert.equal(resolveRowCap({ maxRows: 2 }, 5), 2, 'positive override wins')
  assert.equal(resolveRowCap({ maxRows: 0 }, 5), 0, '0 = unlimited FOR THIS CALL')
  assert.equal(resolveRowCap({ maxRows: 0 }, 0), 0)
  assert.equal(resolveRowCap({ maxRows: '7' }, 5), 7, 'a numeric string is tolerated')
})

test('an unusable override or environment value falls back safely', () => {
  assert.equal(resolveRowCap({ maxRows: -1 }, 5), 5, 'a negative override must not widen or break')
  assert.equal(resolveRowCap({ maxRows: 1.5 }, 5), 5)
  assert.equal(resolveRowCap({ maxRows: 'x' }, 5), 5)
  assert.equal(resolveRowCap({ maxRows: Number.NaN }, 5), 5)
  assert.equal(resolveRowCap({}, Number.NaN), 0, 'an unusable environment value = unlimited')
  assert.equal(resolveRowCap({}, -3), 0)
  assert.equal(resolveRowCap({}, 'nope'), 0)
})

// ── the pure capping pass ─────────────────────────────────────────────────

const HEADER = '{连接: {src: cap → mysql://127.0.0.1:3306/app}}'
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
const stmt = (rows, count) => ({ sql: 'select 1', rows, count: count === undefined ? rows.length : count })
const receipt = (statements) => HEADER + '\n' + JSON.stringify({ statements, source_id: 'default' })
const bodyOf = (text) => JSON.parse(text.split('\n').slice(2).join('\n'))

test('exactly `cap` rows is not truncation (the receipt is returned untouched)', () => {
  const text = receipt([stmt(rowsOf(3))])
  assert.equal(capExecuteSqlText(text, 3), text)
})

test('cap + 1 rows is trimmed, marked and counted', () => {
  const text = receipt([stmt(rowsOf(4), 999)])
  const out = capExecuteSqlText(text, 3)
  const parsed = bodyOf(out)
  assert.equal(parsed.source_id, 'default', 'other top-level fields survive')
  assert.equal(parsed.statements[0].rows.length, 3)
  assert.equal(parsed.statements[0].truncated, true)
  assert.equal(parsed.statements[0].shown, 3)
  assert.equal(parsed.statements[0].count, 999, 'the original count is preserved verbatim')
  assert.deepEqual(parsed.statements[0].rows, rowsOf(3), 'the row VALUES are sliced, never re-shaped')
  // The notice is the FIRST line; the metadata header stays the second.
  const lines = out.split('\n')
  assert.ok(lines[0].includes('已截断'), lines[0])
  assert.ok(lines[0].includes('3'), 'the notice names the effective cap')
  assert.ok(lines[0].includes('4'), 'the notice names the ORIGINAL row count')
  assert.ok(lines[0].includes('maxRows'), 'the notice names the per-call override')
  assert.equal(lines[1], HEADER)
})

test('cap = 1 keeps exactly one row', () => {
  const out = capExecuteSqlText(receipt([stmt(rowsOf(5))]), 1)
  const parsed = bodyOf(out)
  assert.equal(parsed.statements[0].rows.length, 1)
  assert.deepEqual(parsed.statements[0].rows, [{ id: 1 }])
  assert.equal(parsed.statements[0].shown, 1)
})

test('cap = 0 (and an invalid cap) is unlimited — the text passes through', () => {
  const text = receipt([stmt(rowsOf(50))])
  assert.equal(capExecuteSqlText(text, 0), text)
  assert.equal(capExecuteSqlText(text, -1), text)
  assert.equal(capExecuteSqlText(text, 'x'), text)
})

test('each statement is capped independently', () => {
  const text = receipt([stmt(rowsOf(5)), stmt(rowsOf(2)), stmt(rowsOf(9), 100)])
  const out = capExecuteSqlText(text, 3)
  const parsed = bodyOf(out)
  assert.equal(parsed.statements[0].rows.length, 3)
  assert.equal(parsed.statements[0].truncated, true)
  assert.equal(parsed.statements[1].rows.length, 2, 'a statement within the cap is untouched')
  assert.equal(parsed.statements[1].truncated, undefined)
  assert.equal(parsed.statements[2].rows.length, 3)
  assert.equal(parsed.statements[2].count, 100)
  // One notice line naming BOTH truncated statements, never a multi-line banner.
  const first = out.split('\n')[0]
  assert.ok(first.includes('语句 1'), first)
  assert.ok(first.includes('语句 3'), first)
  assert.equal(first.includes('语句 2'), false, 'an untouched statement is not reported as truncated')
})

test('a count that disagrees with the row array does not change the maths', () => {
  // `count` is dbhub's own number; the cap is applied to what was actually sent.
  const text = receipt([stmt(rowsOf(3), 250)])
  const out = capExecuteSqlText(text, 2)
  const parsed = bodyOf(out)
  assert.equal(parsed.statements[0].rows.length, 2)
  assert.equal(parsed.statements[0].count, 250, 'kept exactly as dbhub wrote it')
  assert.ok(out.split('\n')[0].includes('3'), 'the notice reports the row count that arrived, not `count`')
})

test('non-JSON / wrong-shape receipts are returned VERBATIM (fail-soft)', () => {
  const cases = [
    HEADER + '\n' + 'not json at all',
    HEADER, // no body line at all
    HEADER + '\n' + JSON.stringify({ statements: 'nope' }),
    HEADER + '\n' + JSON.stringify({ statements: [{ sql: 'select 1' }] }), // no rows array
    HEADER + '\n' + JSON.stringify({ statements: [null] }),
    HEADER + '\n' + JSON.stringify([{ rows: rowsOf(9) }]), // a bare array, not the documented object
    HEADER + '\n' + '{"statements":[{"rows":[1,2,3,4]},' // truncated JSON
  ]
  for (const text of cases) {
    assert.equal(capExecuteSqlText(text, 2), text, 'must not rewrite: ' + text.slice(0, 40))
  }
  // Non-string input never throws either.
  assert.equal(capExecuteSqlText(undefined, 2), undefined)
  assert.equal(capExecuteSqlText(null, 2), null)
})

test('the notice is localized (the en copy carries no Chinese)', () => {
  const text = receipt([stmt(rowsOf(4))])
  const en = capExecuteSqlText(text, 2, (key, params) => i18n.tFor('en', key, params))
  const first = en.split('\n')[0]
  assert.ok(first.includes('[result truncated]'), first)
  assert.ok(first.includes('statement 1'), first)
  assert.ok(first.includes('maxRows'), first)
  assert.equal(/[\u4e00-\u9fff]/.test(first), false, first)
  const zh = capExecuteSqlText(text, 2, (key, params) => i18n.tFor('zh', key, params))
  assert.ok(zh.split('\n')[0].includes('结果已截断'), zh.split('\n')[0])
})

// ── end-to-end: the tool applies the environment cap, the argument is ours ──

/** A fake dbhub child: answers initialize, then replies to tools/call. */
function fakeDbhub(receiptText) {
  const calls = []
  const subprocess = {
    resolveExecutable: async (name) => '/fake/bin/' + name,
    spawn() {
      const stdin = new EventEmitter()
      const handle = {
        stdin,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        terminate() {},
        waitForExit: async () => ({ exitCode: 0 }),
        // The MCP client subscribes to `done` (the host's process-lifetime
        // promise); nothing here ever ends it, which is exactly a healthy child.
        done: new Promise(() => {}),
      }
      const reply = (msg, result) => handle.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
      stdin.write = (text) => {
        const msg = JSON.parse(String(text).trim())
        if (msg.method === 'initialize') return reply(msg, { protocolVersion: '2025-03-26', capabilities: {} })
        if (msg.method === 'tools/call') {
          calls.push(msg.params)
          return reply(msg, { content: [{ type: 'text', text: receiptText }] })
        }
        return undefined
      }
      return handle
    },
  }
  return { subprocess, calls }
}

function toolHarness() {
  const captured = {}
  const ctx = {
    tools: { register: (def) => { captured[def.name] = def; return () => {} } },
    get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: WS, title: 'cap' }] } : undefined),
    inject: () => {},
  }
  return { captured, ctx }
}

test('dbhub_execute_sql caps the receipt by the environment setting and never forwards maxRows upstream', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  seedBase({ [WS]: { environments: { default: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 3 } } } })
  const receiptText = JSON.stringify({ statements: [stmt(rowsOf(6), 6)], source_id: 'default' })
  const { subprocess, calls } = fakeDbhub(receiptText)
  const { captured, ctx } = toolHarness()
  registerCoreTools(ctx, subprocess)

  const sourceId = mcp.sourceIdOf({ title: 'cap', wsPath: WS, env: 'default' })
  const out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1' }, {})
  assert.equal(out.ok, true)
  assert.ok(String(out.text).includes('已截断'), out.text)
  // The upstream call carries the SQL only: `maxRows` is the PLUGIN's argument.
  assert.deepEqual(calls[0].arguments, { sql: 'select 1' })
  assert.equal(calls[0].name, 'execute_sql')
  const body = JSON.parse(String(out.text).split('\n').slice(2).join('\n'))
  assert.equal(body.statements[0].rows.length, 3)
  assert.equal(body.statements[0].truncated, true)
  delete base.store[WS]
})

test('the per-call maxRows argument wins over the environment, and 0 disables it', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  seedBase({ [WS]: { environments: { default: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 3 } } } })
  const receiptText = JSON.stringify({ statements: [stmt(rowsOf(6), 6)], source_id: 'default' })
  const { subprocess, calls } = fakeDbhub(receiptText)
  const { captured, ctx } = toolHarness()
  registerCoreTools(ctx, subprocess)
  const sourceId = mcp.sourceIdOf({ title: 'cap', wsPath: WS, env: 'default' })

  // 0 = no cap at all for this call.
  let out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1', maxRows: 0 }, {})
  assert.equal(out.ok, true)
  assert.equal(String(out.text).includes('已截断'), false, 'the environment cap was overridden')
  assert.equal(JSON.parse(String(out.text).split('\n').slice(1).join('\n')).statements[0].rows.length, 6)
  assert.deepEqual(calls[0].arguments, { sql: 'select 1' }, 'still no maxRows upstream')

  // A smaller explicit cap applies even though the environment is larger.
  out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1', maxRows: 1 }, {})
  const body = JSON.parse(String(out.text).split('\n').slice(2).join('\n'))
  assert.equal(body.statements[0].rows.length, 1)
  assert.ok(String(out.text).split('\n')[0].includes('1'))
  delete base.store[WS]
})

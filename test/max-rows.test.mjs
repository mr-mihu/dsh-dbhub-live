// Maximum-rows tests: the GLOBAL result row cap (`options.defaultMaxRows`), its
// per-call override on `dbhub_execute_sql`, and the pure capping pass that trims
// dbhub's JSON receipt.
//
// Two halves, deliberately:
//   1. the SETTING half — the global value's validation (`badMaxRows`, zero
//      writes), its read-back, and the DEPRECATED per-environment `maxRows`
//      proving it no longer participates (store compat kept, card path ignored);
//   2. the PURE half — `resolveRowCap` (override priority) and
//      `capExecuteSqlText` (boundaries, multi-statement independence, count
//      preservation, fail-soft passthrough, localized notice), plus end-to-end
//      tool calls through a fake dbhub so "the argument is ours, not dbhub's",
//      "the global cap really reaches the model", and "a leftover environment
//      value is ignored" are pinned rather than assumed.
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
const options = await import('../lib/options.mjs')
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

// ── the GLOBAL setting: `defaultMaxRows` ─────────────────────────────────
//
// The per-environment `maxRows` is DEPRECATED: execution reads only the global
// option, and the card can no longer write the store field. Its validator and
// refusal live in `options.validatePatch` (the same gate the bridge uses before
// `applyPatch`), so an invalid save is refused with nothing written.

test('an illegal global cap is refused at the options layer with zero writes', () => {
  const before = readStoreText()
  for (const bad of [-2, 2.5, 'many', Number.NaN, -0.5]) {
    assert.throws(
      () => options.validatePatch({ defaultMaxRows: bad }),
      (err) => err.code === 'badMaxRows',
      'refused: ' + String(bad),
    )
  }
  // `validatePatch` only INSPECTS; a caller that sees the throw never reaches
  // `applyPatch`, so the effective value cannot have moved.
  assert.equal(options.get('defaultMaxRows'), 0)
  assert.equal(readStoreText(), before, 'zero writes for every refused value')
})

test('an illegal batch concurrency is refused at the options layer too', () => {
  for (const bad of [0, 9, 1.5, 'two']) {
    assert.throws(
      () => options.validatePatch({ batchConcurrency: bad }),
      (err) => err.code === 'badConcurrency',
      'refused: ' + String(bad),
    )
  }
})

test('a valid global cap is accepted, read back, and exposed in the snapshot', () => {
  try {
    assert.equal(options.applyPatch({ defaultMaxRows: 250 }), true)
    assert.equal(options.get('defaultMaxRows'), 250)
    assert.equal(options.snapshot().defaultMaxRows, 250)
    // 0 is a legal value and means unlimited.
    assert.equal(options.applyPatch({ defaultMaxRows: 0 }), true)
    assert.equal(options.get('defaultMaxRows'), 0)
  } finally {
    options.applyPatch({ defaultMaxRows: 0 })
  }
})

test('the card options command ignores the deprecated per-environment maxRows', async () => {
  seedBase({ [WS]: { environments: { prod: { dsn: DSN, source: 'user', updatedAt: 1 } } } })
  const r = await index.applyOptionsOp(
    { env: 'prod', maxRows: 300 },
    { path: WS, title: 'cap' },
    async () => undefined,
  )
  // `maxRows` is not an option field any more, so the command carries nothing
  // the store understands: the same zero-write no-op as any unknown key.
  assert.deepEqual(r.patches, [])
  assert.equal(r.noop, true)
  assert.equal('maxRows' in readStore()[WS].environments.prod, false, 'the card wrote nothing')
})

test('the refused cap has its own localized sentence in both languages', () => {
  for (const locale of ['zh', 'en']) {
    const text = i18n.tFor(locale, 'result.badMaxRows')
    assert.notEqual(text, 'result.badMaxRows')
    assert.match(text, /0/)
    const conc = i18n.tFor(locale, 'result.badConcurrency')
    assert.notEqual(conc, 'result.badConcurrency')
    assert.match(conc, /1/)
    assert.match(conc, /8/)
  }
  assert.equal(/[\u4e00-\u9fff]/.test(i18n.tFor('en', 'result.badMaxRows')), false, 'the en copy must stay English')
  assert.equal(/[\u4e00-\u9fff]/.test(i18n.tFor('en', 'result.badConcurrency')), false, 'the en copy must stay English')
})

// ── override priority (pure) ──────────────────────────────────────────────

test('the call argument overrides the global default, and 0 means unlimited', () => {
  assert.equal(resolveRowCap({}, 5), 5, 'omitted → the configured default')
  assert.equal(resolveRowCap({ maxRows: 2 }, 5), 2, 'positive override wins')
  assert.equal(resolveRowCap({ maxRows: 0 }, 5), 0, '0 = unlimited FOR THIS CALL')
  assert.equal(resolveRowCap({ maxRows: 0 }, 0), 0)
  assert.equal(resolveRowCap({ maxRows: '7' }, 5), 7, 'a numeric string is tolerated')
})

test('an unusable override or global value falls back safely', () => {
  assert.equal(resolveRowCap({ maxRows: -1 }, 5), 5, 'a negative override must not widen or break')
  assert.equal(resolveRowCap({ maxRows: 1.5 }, 5), 5)
  assert.equal(resolveRowCap({ maxRows: 'x' }, 5), 5)
  assert.equal(resolveRowCap({ maxRows: Number.NaN }, 5), 5)
  assert.equal(resolveRowCap({}, Number.NaN), 0, 'an unusable global value = unlimited')
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

test('dbhub_execute_sql caps the receipt by the GLOBAL setting and never forwards maxRows upstream', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  // A leftover per-environment value: it must NOT win over the global setting.
  seedBase({ [WS]: { environments: { default: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 3 } } } })
  options.applyPatch({ defaultMaxRows: 5 })
  try {
    const receiptText = JSON.stringify({ statements: [stmt(rowsOf(6), 6)], source_id: 'default' })
    const { subprocess, calls } = fakeDbhub(receiptText)
    const { captured, ctx } = toolHarness()
    registerCoreTools(ctx, subprocess)

    const sourceId = mcp.sourceIdOf({ title: 'cap', wsPath: WS, env: 'default' })
    const out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1' }, {})
    assert.equal(out.ok, true)
    const text = String(out.text)
    assert.ok(text.includes('已截断'), text)
    assert.ok(text.split('\n')[0].includes('5'), 'the notice names the GLOBAL default: ' + text.split('\n')[0])
    // The upstream call carries the SQL only: `maxRows` is the PLUGIN's argument.
    assert.deepEqual(calls[0].arguments, { sql: 'select 1' })
    assert.equal(calls[0].name, 'execute_sql')
    const body = JSON.parse(text.split('\n').slice(2).join('\n'))
    assert.equal(body.statements[0].rows.length, 5, 'the global cap applied, not the leftover environment value')
    assert.equal(body.statements[0].truncated, true)
  } finally {
    options.applyPatch({ defaultMaxRows: 0 })
    delete base.store[WS]
  }
})

test('a leftover per-environment maxRows is IGNORED (deprecated field)', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  seedBase({ [WS]: { environments: { default: { dsn: DSN, source: 'user', updatedAt: 1, maxRows: 3 } } } })
  options.applyPatch({ defaultMaxRows: 0 })
  try {
    const receiptText = JSON.stringify({ statements: [stmt(rowsOf(6), 6)], source_id: 'default' })
    const { subprocess } = fakeDbhub(receiptText)
    const { captured, ctx } = toolHarness()
    registerCoreTools(ctx, subprocess)
    const sourceId = mcp.sourceIdOf({ title: 'cap', wsPath: WS, env: 'default' })
    const out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1' }, {})
    assert.equal(out.ok, true)
    const text = String(out.text)
    assert.equal(text.includes('已截断'), false, 'the stored environment cap must not truncate anything')
    const body = JSON.parse(text.split('\n').slice(1).join('\n'))
    assert.equal(body.statements[0].rows.length, 6, 'every row comes back')
  } finally {
    delete base.store[WS]
  }
})

test('the per-call maxRows argument wins over the global default, and 0 disables it', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  seedBase({ [WS]: { environments: { default: { dsn: DSN, source: 'user', updatedAt: 1 } } } })
  options.applyPatch({ defaultMaxRows: 3 })
  try {
    const receiptText = JSON.stringify({ statements: [stmt(rowsOf(6), 6)], source_id: 'default' })
    const { subprocess, calls } = fakeDbhub(receiptText)
    const { captured, ctx } = toolHarness()
    registerCoreTools(ctx, subprocess)
    const sourceId = mcp.sourceIdOf({ title: 'cap', wsPath: WS, env: 'default' })

    // 0 = no cap at all for this call, even though the default is 3.
    let out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1', maxRows: 0 }, {})
    assert.equal(out.ok, true)
    assert.equal(String(out.text).includes('已截断'), false, 'the global default was overridden')
    assert.equal(JSON.parse(String(out.text).split('\n').slice(1).join('\n')).statements[0].rows.length, 6)
    assert.deepEqual(calls[0].arguments, { sql: 'select 1' }, 'still no maxRows upstream')

    // A smaller explicit cap applies even though the default is larger.
    out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1', maxRows: 1 }, {})
    const body = JSON.parse(String(out.text).split('\n').slice(2).join('\n'))
    assert.equal(body.statements[0].rows.length, 1)
    assert.ok(String(out.text).split('\n')[0].includes('1'))

    // Omitted → the global default (3), proving the setting is the fallback.
    out = await captured.dbhub_execute_sql.execute({ source: sourceId, sql: 'select 1' }, {})
    assert.equal(JSON.parse(String(out.text).split('\n').slice(2).join('\n')).statements[0].rows.length, 3)
  } finally {
    options.applyPatch({ defaultMaxRows: 0 })
    delete base.store[WS]
  }
})

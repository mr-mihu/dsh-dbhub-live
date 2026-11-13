// Query-result export tests: the `export: 'csv' | 'json'` argument of
// `dbhub_execute_sql`, the pure CSV/JSON builders and the file writer behind it.
//
// Three halves, deliberately:
//   1. the PURE half — RFC 4180 field escaping, the column UNION in
//      first-appearance order, the value conversions, the payload shape and the
//      file-name sanitization (a source handle may be Chinese, contain `../` or
//      be absurdly long: the name must stay inside the exports directory);
//   2. the WRITER half — files land in DATA_DIR/exports, a same-second export
//      never overwrites an earlier one, owner-only modes are requested;
//   3. the END-TO-END half — a fake dbhub so these behaviours are pinned rather
//      than assumed: no `export` changes nothing, csv/json replace the rows with
//      a summary + path, the ENVIRONMENT cap is bypassed unless `maxRows` is
//      explicit, a failing fs is fail-soft, and none of it leaks a credential.
//
// Test isolation: config.mjs binds its storage paths at import time, so DSH_HOME
// points at a temp dir BEFORE importing (exports land there, never in the real
// profile). Desensitization convention: RFC 5737 host, assembled placeholder
// password, no credentialed URL literal in this file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-export-'))
process.env.DSH_HOME = home
// runtime.mjs prefers a mise-managed dbhub; the fake subprocess is the one and
// only executable this file may resolve.
delete process.env.MISE_DATA_DIR

const storeDir = join(home, 'storages', 'dsh-dbhub-live')
const storePath = join(storeDir, 'credentials.json')
mkdirSync(storeDir, { recursive: true })

// The plain instances the tool reads (no cache-busting: the store must be the
// one the tool under test reads).
const base = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const i18n = await import('../lib/i18n.mjs')
const exp = await import('../lib/export.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs')

// Assembled so this file carries no credentialed URL literal (the desensitize
// gate scans them) while the runtime value still carries a canary password.
const CANARY = 'CHANGE' + '_ME_CANARY'
const HOST = '198.51.100.77'
const DSN = 'mysql://user:' + CANARY + '@' + HOST + ':3306/app'
const WS = 'D:/ws/export'
const AT = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))

const readStore = () => JSON.parse(readFileSync(storePath, 'utf8'))

function seedBase(fixture) {
  for (const key of Object.keys(base.store)) delete base.store[key]
  Object.assign(base.store, fixture || {})
  base.saveStore(base.store)
}

test.after(() => {
  exp.setExportFsHooks(null)
  rmSync(home, { recursive: true, force: true })
})

// ── CSV: column union, order and value conversion (pure) ──────────────────

test('CSV columns are the UNION of every row key, in first-appearance order', () => {
  const rows = [{ b: 1, a: 2 }, { c: 3, a: 4 }]
  // NOT sorted: the row objects carry the database's own column order.
  assert.deepEqual(exp.csvColumns(rows), ['b', 'a', 'c'])
  assert.equal(exp.csvTextOf(rows), 'b,a,c\r\n1,2,\r\n,4,3')
})

test('CSV converts null / undefined / objects / arrays / numbers / booleans', () => {
  const rows = [{
    n: 0, f: false, t: true, z: null, u: undefined, obj: { k: 'v' }, arr: [1, 2], s: 'x',
  }]
  const text = exp.csvTextOf(rows)
  assert.equal(
    text,
    'n,f,t,z,u,obj,arr,s\r\n' +
    '0,false,true,,,"{""k"":""v""}","[1,2]",x',
  )
})

test('CSV escapes commas, quotes, CR and LF (RFC 4180) and the header too', () => {
  const rows = [{ 'a,b': 'x,y', 'q"q': 'he said "hi"', lf: 'line1\nline2', cr: 'cr\rhere' }]
  assert.equal(
    exp.csvTextOf(rows),
    '"a,b","q""q",lf,cr\r\n' +
    '"x,y","he said ""hi""","line1\nline2","cr\rhere"',
  )
})

test('CSV uses CRLF and never appends an extra blank line', () => {
  const one = exp.csvTextOf([{ id: 1 }])
  assert.equal(one, 'id\r\n1')
  assert.equal(one.endsWith('\r\n'), false)
  assert.equal(one.split('\r\n').length, 2)
  assert.equal(one.includes('\n\n'), false)
})

test('CSV writes no BOM by default and one on request', () => {
  const plain = exp.csvTextOf([{ a: 1 }])
  assert.notEqual(plain.charCodeAt(0), 0xfeff)
  const bom = exp.csvTextOf([{ a: 1 }], { bom: true })
  assert.equal(bom.charCodeAt(0), 0xfeff)
  assert.equal(bom.slice(1), plain)
})

test('an empty result set has no column names to write (only a known header is emitted)', () => {
  // dbhub returns rows only (no column list): with zero rows the honest document
  // is empty, and it still carries no trailing blank line.
  assert.equal(exp.csvTextOf([]), '')
  assert.equal(exp.csvTextOf([], {}), '')
  // When the caller DOES know the columns, "header only" is expressible.
  assert.equal(exp.csvTextOf([], { columns: ['a', 'b'] }), 'a,b')
  // A non-array (or junk) input is treated as an empty result, never a throw.
  assert.equal(exp.csvTextOf(undefined), '')
  assert.equal(exp.csvTextOf(null), '')
})

test('a scalar row cannot crash the CSV writer', () => {
  assert.doesNotThrow(() => exp.csvTextOf([5, 'x', null]))
})

// ── JSON payload (pure) ───────────────────────────────────────────────────

test('the JSON payload is {source, statements:[{sql,rows,count}], exportedAt} and carries no DSN', () => {
  const statements = [
    { sql: 'select 1', rows: [{ a: 1 }], count: 1, truncated: true, shown: 1 },
    { sql: 'select 2', rows: [], count: 0 },
  ]
  const payload = exp.exportPayloadOf('ws_1a2b3c_default', statements, AT)
  assert.deepEqual(Object.keys(payload), ['source', 'statements', 'exportedAt'])
  assert.equal(payload.source, 'ws_1a2b3c_default')
  assert.equal(payload.exportedAt, AT.toISOString())
  assert.deepEqual(payload.statements, [
    { sql: 'select 1', rows: [{ a: 1 }], count: 1 },
    { sql: 'select 2', rows: [], count: 0 },
  ])
  // A missing count falls back to the number of rows that are actually there.
  assert.equal(exp.exportPayloadOf('s', [{ sql: 'q', rows: [{ a: 1 }, { a: 2 }] }], AT).statements[0].count, 2)
  const text = exp.exportJsonText(payload)
  assert.equal(text.includes(CANARY), false)
  assert.equal(text.includes('mysql://'), false)
  assert.equal(JSON.parse(text).statements.length, 2)
})

// ── file names: ASCII-safe, bounded, never outside the exports dir ────────

test('file names are ASCII-safe and cannot escape the exports directory', () => {
  const cases = [
    '../etc/passwd',
    '..\\..\\win.ini',
    'a/b',
    'a\\b',
    '.',
    '..',
    '中文环境',
    '📦📦📦',
    'con',
    'a\u0000b\u001fc',
    '',
  ]
  for (const raw of cases) {
    const name = exp.exportFileName({ sourceId: raw, format: 'csv', seq: 1, at: AT })
    assert.equal(basename(name), name, 'not a bare file name: ' + JSON.stringify(raw))
    assert.equal(name.includes('/'), false)
    assert.equal(name.includes('\\'), false)
    assert.equal(name.includes('..'), false)
    assert.equal(/[\u0000-\u001f\u007f]/.test(name), false)
    assert.match(name, /^[A-Za-z0-9_%.-]+-\d{8}-\d{6}-1\.csv$/)
    const full = resolve(exp.EXPORT_DIR, name)
    assert.ok(full.startsWith(exp.EXPORT_DIR + sep), 'escaped the exports dir: ' + full)
  }
  // The empty handle still produces a usable name.
  assert.match(exp.safeExportStem(''), /^[A-Za-z0-9_-]+$/)
})

test('different non-ASCII handles never collapse onto one file name', () => {
  const names = ['线上', '测试', '📦', '📦📦'].map((id) => exp.safeExportStem(id))
  assert.equal(new Set(names).size, names.length)
  // Percent-encoding is injective: the readable ASCII prefix survives, and the
  // encoded byte keeps the identity.
  assert.ok(exp.safeExportStem('线上').startsWith('%'))
})

test('an over-long handle is capped at 64 chars and keeps a short hash', () => {
  const long = 'x'.repeat(200)
  const stem = exp.safeExportStem(long)
  assert.ok(stem.length <= exp.EXPORT_STEM_MAX, stem.length + ' chars: ' + stem)
  assert.ok(stem.startsWith('xxxx'))
  // Two handles that differ only PAST the cap must still differ.
  const a = exp.safeExportStem('x'.repeat(180) + 'aaa')
  const b = exp.safeExportStem('x'.repeat(180) + 'bbb')
  assert.notEqual(a, b)
  assert.ok(a.length <= exp.EXPORT_STEM_MAX)
})

test('the stamp is UTC yyyymmdd-hhmmss (deterministic across host time zones)', () => {
  assert.equal(exp.exportStampOf(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '20260102-030405')
  assert.match(exp.exportStampOf(new Date()), /^\d{8}-\d{6}$/)
})

// ── writer ────────────────────────────────────────────────────────────────

test('the writer puts files in DATA_DIR/exports and never overwrites a same-second export', () => {
  assert.ok(exp.EXPORT_DIR.startsWith(join(home, 'storages', 'dsh-dbhub-live')), exp.EXPORT_DIR)
  const opts = {
    sourceId: 'ws_collide_default',
    format: 'csv',
    statements: [{ sql: 'select 1', rows: [{ a: 1 }], count: 1 }],
    at: AT,
  }
  const first = exp.writeExportFiles(opts)
  const second = exp.writeExportFiles(opts)
  assert.notEqual(first.files[0].path, second.files[0].path, 'a same-second export must not overwrite')
  assert.ok(existsSync(first.files[0].path))
  assert.ok(existsSync(second.files[0].path))
  assert.equal(readFileSync(first.files[0].path, 'utf8'), 'a\r\n1')
  assert.equal(second.totalRows, 1)
})

// ── end-to-end: a fake dbhub answers the MCP calls ────────────────────────

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
    get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: WS, title: 'exp' }] } : undefined),
    inject: () => {},
  }
  return { captured, ctx }
}

/** Run one `dbhub_execute_sql` call against a fake dbhub. */
async function execute({ receipt, fixture, args }) {
  if (!state.isEnabled()) state.setEnabled(true)
  seedBase(fixture)
  const { subprocess, calls } = fakeDbhub(receipt)
  const { captured, ctx } = toolHarness()
  registerCoreTools(ctx, subprocess)
  const out = await captured.dbhub_execute_sql.execute(args, {})
  return { out, calls }
}

const rowsOf = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: i + 1, tag: tag + '-' + (i + 1) }))
const stmt = (rows, count) => ({ sql: 'select 1', rows, count: count === undefined ? rows.length : count })
const receiptOf = (statements) => JSON.stringify({ statements, source_id: 'default' })
const bodyOf = (text, skip) => JSON.parse(String(text).split('\n').slice(skip).join('\n'))
// One ENVIRONMENT per end-to-end case: every case gets its own source handle
// (and therefore its own file-name stem), so the temp home can be shared by the
// whole file without one case counting another case's files.
const sourceOf = (name) => mcp.sourceIdOf({ title: 'exp', wsPath: WS, env: name })
const fixture = (name, env = {}) => ({ [WS]: { environments: { [name]: { dsn: DSN, source: 'user', updatedAt: 1, ...env } } } })

/** File names the source handle owns (the temp home is shared across tests). */
const exportFilesOf = (srcId) => {
  let names
  try {
    names = readdirSync(exp.EXPORT_DIR)
  } catch (e) {
    return []
  }
  const stem = exp.safeExportStem(srcId)
  return names.filter((n) => n.startsWith(stem + '-')).sort()
}

test('without `export` the receipt is byte-for-byte the old one (rows inline)', async () => {
  const receipt = receiptOf([stmt(rowsOf(3, 'CELL'))])
  const SRC = sourceOf('nocsv')
  const { out, calls } = await execute({ receipt, fixture: fixture('nocsv'), args: { source: SRC, sql: 'select 1' } })
  assert.equal(out.ok, true)
  assert.equal(String(out.text).includes('已导出'), false)
  // The metadata header line is still the first line and the JSON body follows it.
  assert.match(String(out.text).split('\n')[0], /^\{连接: exp_/)
  const body = bodyOf(out.text, 1)
  assert.equal(body.statements[0].rows.length, 3)
  assert.equal(String(out.text).includes('CELL-1'), true, 'the rows are inline without export')
  assert.deepEqual(calls[0].arguments, { sql: 'select 1' }, 'export is never forwarded upstream')
})

test('csv export writes one file per statement and returns only a summary', async () => {
  const receipt = receiptOf([stmt(rowsOf(5, 'CELL'))])
  const SRC = sourceOf('csvone')
  const { out, calls } = await execute({
    receipt,
    // The environment cap is DELIBERATELY set: an export ignores it.
    fixture: fixture('csvone', { maxRows: 2 }),
    args: { source: SRC, sql: 'select 1', export: 'csv' },
  })
  assert.equal(out.ok, true)
  const text = String(out.text)
  assert.match(text, /已导出 5 行到 /, text)
  assert.ok(text.includes(SRC), 'the summary names the source handle')
  assert.equal(text.includes('已截断'), false, 'the environment cap must not apply to an export')
  assert.equal(text.includes('CELL-1'), false, 'the rows must NOT be inlined')
  assert.ok(text.includes(i18n.currentT('result.exportNote')))
  assert.deepEqual(calls[0].arguments, { sql: 'select 1' }, 'neither export nor maxRows is forwarded')

  const names = exportFilesOf(SRC)
  assert.equal(names.length, 1, JSON.stringify(names))
  assert.match(names[0], /\.csv$/)
  const path = join(exp.EXPORT_DIR, names[0])
  assert.ok(text.includes(path), 'the summary carries the absolute path')
  const csv = readFileSync(path, 'utf8')
  assert.equal(csv.endsWith('\r\n'), false)
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'id,tag')
  assert.equal(lines.length, 6, 'header + 5 rows')
  assert.equal(lines[5], '5,CELL-5')
  // Zero knowledge: neither the canary password nor the host crosses.
  assert.equal(text.includes(CANARY), false)
  assert.equal(text.includes(HOST), false)
})

test('a multi-statement csv export produces one numbered file per statement', async () => {
  const receipt = receiptOf([stmt(rowsOf(2, 'A')), stmt(rowsOf(3, 'B'))])
  const SRC = sourceOf('csvmulti')
  const { out } = await execute({
    receipt,
    fixture: fixture('csvmulti'),
    args: { source: SRC, sql: 'select 1; select 2', export: 'csv' },
  })
  const text = String(out.text)
  assert.match(text, /已导出 2 条语句的结果到 2 个文件/)
  assert.match(text, /语句 1：2 行/)
  assert.match(text, /语句 2：3 行/)
  const names = exportFilesOf(SRC)
  assert.equal(names.length, 2, JSON.stringify(names))
  assert.match(names[0], /-1\.csv$/)
  assert.match(names[1], /-2\.csv$/)
  assert.equal(readFileSync(join(exp.EXPORT_DIR, names[0]), 'utf8').split('\r\n').length, 3)
  assert.equal(readFileSync(join(exp.EXPORT_DIR, names[1]), 'utf8').split('\r\n').length, 4)
  assert.ok(text.includes(join(exp.EXPORT_DIR, names[1])))
})

test('json export writes ONE file with the whole payload and no DSN', async () => {
  const receipt = receiptOf([stmt(rowsOf(2, 'A'), 2), stmt(rowsOf(3, 'B'), 9)])
  const SRC = sourceOf('jsonone')
  const { out } = await execute({
    receipt,
    fixture: fixture('jsonone'),
    args: { source: SRC, sql: 'select 1; select 2', export: 'json' },
  })
  const text = String(out.text)
  assert.match(text, /已导出 5 行（2 条语句）到 /, text)
  const names = exportFilesOf(SRC)
  assert.equal(names.length, 1, JSON.stringify(names))
  assert.match(names[0], /-1\.json$/)
  const raw = readFileSync(join(exp.EXPORT_DIR, names[0]), 'utf8')
  const payload = JSON.parse(raw)
  assert.equal(payload.source, SRC)
  assert.equal(payload.statements.length, 2)
  assert.deepEqual(payload.statements[0], { sql: 'select 1', rows: rowsOf(2, 'A'), count: 2 })
  assert.equal(payload.statements[1].count, 9, 'dbhub count is preserved verbatim')
  assert.ok(Number.isFinite(Date.parse(payload.exportedAt)), payload.exportedAt)
  assert.equal(raw.includes(CANARY), false, 'the JSON file must not carry a credential')
  assert.equal(raw.includes('mysql://'), false, 'the JSON file must not carry a DSN')
  assert.equal(raw.includes(HOST), false)
})

test('an EXPLICIT maxRows truncates the exported rows (notice first, count kept)', async () => {
  const receipt = receiptOf([stmt(rowsOf(5, 'CELL'), 5)])
  const SRC = sourceOf('capone')
  const { out } = await execute({
    receipt,
    // The environment cap is set but MUST be overridden by the explicit argument;
    // only the argument may truncate an export.
    fixture: fixture('capone', { maxRows: 9 }),
    args: { source: SRC, sql: 'select 1', export: 'json', maxRows: 2 },
  })
  const text = String(out.text)
  assert.ok(text.split('\n')[0].includes('已截断'), text.split('\n')[0])
  assert.ok(text.split('\n')[0].includes('5'), 'the notice names the original row count')
  assert.ok(text.split('\n')[0].includes('2'), 'the notice names the effective cap')
  const names = exportFilesOf(SRC)
  const payload = JSON.parse(readFileSync(join(exp.EXPORT_DIR, names[0]), 'utf8'))
  assert.equal(payload.statements[0].rows.length, 2)
  assert.equal(payload.statements[0].rows[0].id, 1)
  assert.equal(payload.statements[0].count, 5, 'count stays dbhub verbatim (no second serialization)')
})

test('an unusable export value behaves exactly like "no export"', async () => {
  const receipt = receiptOf([stmt(rowsOf(2, 'CELL'))])
  const SRC = sourceOf('noop')
  const before = exportFilesOf(SRC).length
  const { out } = await execute({
    receipt,
    fixture: fixture('noop'),
    args: { source: SRC, sql: 'select 1', export: 'xml' },
  })
  assert.equal(String(out.text).includes('已导出'), false)
  assert.equal(out.ok, true)
  assert.equal(bodyOf(out.text, 1).statements[0].rows.length, 2, 'the inline receipt is unchanged')
  assert.equal(exportFilesOf(SRC).length, before, 'no file was written')
})

test('a FAILING fs is fail-soft: inline receipt (still capped) + one notice, never an error', async () => {
  const SRC = sourceOf('failfs')
  const before = exportFilesOf(SRC).length
  exp.setExportFsHooks({
    writeFileSync: () => {
      const err = new Error('permission denied')
      err.code = 'EACCES'
      throw err
    },
  })
  try {
    const receipt = receiptOf([stmt(rowsOf(5, 'CELL'))])
    const { out } = await execute({
      receipt,
      fixture: fixture('failfs', { maxRows: 3 }),
      args: { source: SRC, sql: 'select 1', export: 'csv' },
    })
    assert.equal(out.ok, true, 'a failed export must never fail the query')
    const text = String(out.text)
    assert.ok(text.includes(i18n.currentT('result.exportFailed').replace('{code}', 'EACCES')), text)
    // The fallback is the ordinary receipt: environment cap applied, notice first
    // and the "export failed" sentence appended AFTER the JSON body.
    const lines = text.split('\n')
    assert.ok(lines[0].includes('已截断'), lines[0])
    assert.match(lines[1], /^\{连接: exp_/)
    assert.ok(lines[lines.length - 1].includes('EACCES'), lines[lines.length - 1])
    const body = JSON.parse(lines.slice(2, -1).join('\n'))
    assert.equal(body.statements[0].rows.length, 3, 'the normal cap still applies to the inline fallback')
    assert.equal(text.includes('CELL-1'), true, 'the rows are returned inline instead')
    assert.equal(exportFilesOf(SRC).length, before, 'nothing was written')
  } finally {
    exp.setExportFsHooks(null)
  }
})

test('an unparseable receipt is fail-soft too (the export never rewrites it)', async () => {
  const SRC = sourceOf('badbody')
  const { out } = await execute({
    receipt: 'not a json body at all',
    fixture: fixture('badbody'),
    args: { source: SRC, sql: 'select 1', export: 'json' },
  })
  assert.equal(out.ok, true)
  const text = String(out.text)
  assert.ok(text.includes('not a json body at all'), 'the original receipt is kept verbatim')
  assert.ok(text.includes(i18n.currentT('result.exportFailed').replace('{code}', 'badResult')), text)
})

test('the export copy is localized (en carries no Chinese)', () => {
  for (const key of ['result.exportSingle', 'result.exportJson', 'result.exportMulti', 'result.exportMultiItem', 'result.exportNote', 'result.exportEmpty', 'result.exportFailed']) {
    const zh = i18n.tFor('zh', key, { rows: '1', n: '1', files: '1', path: 'p', src: 's', code: 'E' })
    const en = i18n.tFor('en', key, { rows: '1', n: '1', files: '1', path: 'p', src: 's', code: 'E' })
    assert.notEqual(zh, key, 'missing zh key: ' + key)
    assert.notEqual(en, key, 'missing en key: ' + key)
    assert.equal(/[\u4e00-\u9fff]/.test(en), false, 'the en copy must stay English: ' + key)
  }
})

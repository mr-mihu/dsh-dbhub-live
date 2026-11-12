// Unit tests for the connection-list pure helpers in lib/client.js:
// `filterRows` (search), `sortRows` (name / recently-updated) and
// `batchSummaryOf` (the batch tally).
//
// They live inside the hand-authored client bundle, which cannot be imported as
// a module (it registers itself with `window.__ModuleLoader__`), so the bundle
// marks the block explicitly and this test evaluates exactly that text. Anything
// the block needs must therefore stay inside it — which is the property the last
// test pins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(CLIENT, 'utf8')

const START = '// ── connection list: search / sort / batch tally (PURE)'
const END = '// ── END connection list pure helpers'

const startAt = source.indexOf(START)
const endAt = source.indexOf(END)

test('the pure block keeps its extraction markers', () => {
  assert.ok(startAt >= 0, 'the PURE start marker is missing from lib/client.js')
  assert.ok(endAt > startAt, 'the PURE end marker is missing (or precedes the start)')
})

const block = startAt >= 0 && endAt > startAt ? source.slice(startAt, endAt) : ''
// eslint-disable-next-line no-new-func
const helpers = new Function(block + '\nreturn { rowKeyOf, filterRows, sortRows, batchSummaryOf };')()
const { rowKeyOf, filterRows, sortRows, batchSummaryOf } = helpers

// A row as the Host publishes it: metadata only (no DSN exists in the view).
const row = (title, path, env, conn, extra = {}) => Object.assign({
  title, path, env, conn,
  alias: title + (env === 'default' ? '' : '_' + env),
  srcId: title + '_1a2b3c' + (env === 'default' ? '' : '_' + env),
  persisted: true,
}, extra)

const ROWS = [
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app'),
  row('app', 'D:/work/app', 'prod', 'mysql://127.0.0.1:3307/app'),
  row('billing', 'D:/work/billing', 'prod', 'postgres://127.0.0.1:5432/bill', { alias: 'billing_prod' }),
  row('docs', 'D:/work/docs', '线上', 'sqlite://127.0.0.1:0/docs'),
]

test('rowKeyOf is the path|env identity every map shares', () => {
  assert.equal(rowKeyOf({ path: 'D:/w', env: 'prod' }), 'D:/w|prod')
  assert.equal(rowKeyOf({ path: 'D:/w' }), 'D:/w|')
  assert.equal(rowKeyOf(null), '|')
})

test('the search matches a workspace title case-insensitively', () => {
  assert.deepEqual(filterRows(ROWS, 'APP').map((r) => r.path + '|' + r.env),
    ['D:/work/app|default', 'D:/work/app|prod'])
  assert.deepEqual(filterRows(ROWS, 'Billing').map((r) => r.title), ['billing'])
})

test('the search matches an environment name, including Chinese', () => {
  assert.deepEqual(filterRows(ROWS, '线上').map((r) => r.env), ['线上'])
  assert.deepEqual(filterRows(ROWS, 'PROD').map((r) => r.env), ['prod', 'prod'])
  // A substring, not a prefix: "rod" hits "prod" too.
  assert.deepEqual(filterRows(ROWS, 'rod').map((r) => r.env), ['prod', 'prod'])
})

test('the search matches the alias and the connection metadata', () => {
  assert.deepEqual(filterRows(ROWS, 'billing_prod').map((r) => r.title), ['billing'])
  assert.deepEqual(filterRows(ROWS, '5432').map((r) => r.title), ['billing'])
  assert.deepEqual(filterRows(ROWS, 'sqlite').map((r) => r.title), ['docs'])
})

test('a blank query is not a filter (same list, in input order)', () => {
  assert.equal(filterRows(ROWS, ''), ROWS)
  assert.equal(filterRows(ROWS, '   '), ROWS)
  assert.equal(filterRows(ROWS, undefined), ROWS)
  assert.equal(filterRows(ROWS, null), ROWS)
})

test('a query with no hit returns an empty list, never everything', () => {
  assert.deepEqual(filterRows(ROWS, 'nope'), [])
  // Non-string / missing fields must not throw (the view is JSON from a host).
  assert.deepEqual(filterRows([{}, null, undefined], 'x'), [])
  assert.deepEqual(filterRows(null, 'x'), [])
  assert.deepEqual(filterRows([row('a', 'p', 'e', 'c', { title: 42 })], '42').length, 1)
})

test('the default order is title → environment → path', () => {
  const rows = [
    row('zzz', 'D:/w/z', 'prod', 'mysql://h:1/z'),
    row('aaa', 'D:/w/a', 'prod', 'mysql://h:1/a'),
    row('aaa', 'D:/w/a', 'default', 'mysql://h:1/a'),
    row('aaa', 'D:/w/b', 'prod', 'mysql://h:1/b'),
  ]
  assert.deepEqual(sortRows(rows, 'name').map(rowKeyOf),
    ['D:/w/a|default', 'D:/w/a|prod', 'D:/w/b|prod', 'D:/w/z|prod'])
  // Case-insensitively equal titles keep the raw spelling as the tiebreak, so the
  // result never depends on the input order.
  assert.deepEqual(sortRows([row('B', 'D:/w/1', 'default', 'c'), row('a', 'D:/w/2', 'default', 'c')], 'name')
    .map((r) => r.title), ['a', 'B'])
})

test('the name order is deterministic (the same list sorts the same way)', () => {
  const shuffled = [ROWS[3], ROWS[1], ROWS[0], ROWS[2]]
  assert.deepEqual(sortRows(shuffled, 'name').map(rowKeyOf), sortRows(ROWS, 'name').map(rowKeyOf))
  // …and the input array is never reordered in place.
  const copy = ROWS.slice()
  sortRows(ROWS, 'name')
  assert.deepEqual(ROWS, copy)
})

test('recently-updated sorts by the stamp, newest first', () => {
  const stamps = {
    'D:/work/app': '2026-01-01T00:00:00Z',
    'D:/work/billing': '2026-06-01T00:00:00Z',
    'D:/work/docs': '2026-03-01T00:00:00Z',
  }
  const at = (path) => stamps[path]
  assert.deepEqual(sortRows(ROWS, 'recent', at).map(rowKeyOf),
    ['D:/work/billing|prod', 'D:/work/docs|线上', 'D:/work/app|default', 'D:/work/app|prod'])
})

test('an equal stamp falls back to the name order (a stable, explainable list)', () => {
  const same = '2026-05-05T00:00:00Z'
  const rows = [
    row('beta', 'D:/w/b', 'default', 'mysql://h:1/b'),
    row('alpha', 'D:/w/a', 'prod', 'mysql://h:1/a2'),
    row('alpha', 'D:/w/a', 'default', 'mysql://h:1/a1'),
  ]
  const at = () => same
  const once = sortRows(rows, 'recent', at).map(rowKeyOf)
  assert.deepEqual(once, ['D:/w/a|default', 'D:/w/a|prod', 'D:/w/b|default'])
  // Same stamps, different input order → identical output (a total order).
  const shuffled = [rows[2], rows[0], rows[1]]
  assert.deepEqual(sortRows(shuffled, 'recent', at).map(rowKeyOf), once)
})

test('a row without a stamp sorts last, and a numeric stamp still orders correctly', () => {
  const at = () => ''
  const rows = [
    row('no-stamp', 'D:/w/n', 'default', 'mysql://h:1/n'),
    row('stamped', 'D:/w/s', 'default', 'mysql://h:1/s', { updatedAt: '2026-02-02T00:00:00Z' }),
  ]
  assert.deepEqual(sortRows(rows, 'recent', at).map((r) => r.title), ['stamped', 'no-stamp'])
  // The Host's store keeps `Date.now()` numbers; 999 must not beat 1000.
  const numeric = [
    row('old', 'D:/w/o', 'default', 'mysql://h:1/o', { updatedAt: 999 }),
    row('new', 'D:/w/n2', 'default', 'mysql://h:1/n2', { updatedAt: 1000 }),
  ]
  assert.deepEqual(sortRows(numeric, 'recent').map((r) => r.title), ['new', 'old'])
  // A row that carries its own stamp outranks the workspace lookup.
  const own = [row('own', 'D:/w/x', 'default', 'mysql://h:1/x', { updatedAt: '2027-01-01T00:00:00Z' })]
  const lookup = () => '2020-01-01T00:00:00Z'
  assert.deepEqual(sortRows(own, 'recent', lookup).map((r) => r.title), ['own'])
})

test('a throwing stamp lookup cannot break the list', () => {
  const boom = () => { throw new Error('no snapshot') }
  assert.equal(sortRows(ROWS, 'recent', boom).length, ROWS.length)
})

test('the batch tally counts pass / fail and treats everything else as untested', () => {
  const keys = ['a', 'b', 'c', 'd']
  const results = {
    a: { phase: 'done', ok: true },
    b: { phase: 'done', ok: false, message: 'refused' },
    c: { phase: 'testing' },
    d: { phase: 'wait' },
  }
  assert.deepEqual(batchSummaryOf(keys, results), { pass: 1, fail: 1, untested: 2, total: 4 })
  // A stopped run: the queued rows are deleted from the map, so they count as
  // untested rather than disappearing from the total.
  delete results.d
  assert.deepEqual(batchSummaryOf(keys, results), { pass: 1, fail: 1, untested: 2, total: 4 })
  assert.deepEqual(batchSummaryOf([], {}), { pass: 0, fail: 0, untested: 0, total: 0 })
  assert.deepEqual(batchSummaryOf(null, null), { pass: 0, fail: 0, untested: 0, total: 0 })
})

test('the pure block stays self-contained (no React / DOM / network)', () => {
  assert.doesNotMatch(block, /react\./, 'the pure block must not touch React')
  assert.doesNotMatch(block, /document\.|window\.|fetch\(|setTimeout|setInterval/,
    'the pure block must stay DOM- and timer-free')
})

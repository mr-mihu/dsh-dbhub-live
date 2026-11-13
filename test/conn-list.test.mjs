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
const helpers = new Function(block + '\nreturn { rowKeyOf, filterRows, sortRows, batchSummaryOf, nextSortMode, sortViewOf, orderMapOf, sortByStoredOrder, persistedRowsOf, moveIndexFor };')()
const { rowKeyOf, filterRows, sortRows, batchSummaryOf, nextSortMode, sortViewOf, orderMapOf, sortByStoredOrder, persistedRowsOf, moveIndexFor } = helpers

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

test('"no sort" is a real state: the list keeps the order the Host sent', () => {
  const rows = [
    row('zzz', 'D:/w/z', 'default', 'mysql://h:1/z'),
    row('aaa', 'D:/w/a', 'default', 'mysql://h:1/a'),
    row('mmm', 'D:/w/m', 'default', 'mysql://h:1/m'),
  ]
  // `''` (the control's 默认 state) and anything unrecognised mean "leave it alone".
  assert.deepEqual(sortRows(rows, '').map((r) => r.title), ['zzz', 'aaa', 'mmm'])
  assert.deepEqual(sortRows(rows, undefined).map((r) => r.title), ['zzz', 'aaa', 'mmm'])
  assert.deepEqual(sortRows(rows, 'nonsense').map((r) => r.title), ['zzz', 'aaa', 'mmm'])
  // …and it is still a copy: the caller's array is never reordered.
  const copy = rows.slice()
  sortRows(rows, '')
  assert.deepEqual(rows, copy)
})

test('the descending name order reverses the whole chain (title → env → path)', () => {
  const rows = [
    row('aaa', 'D:/w/a', 'default', 'mysql://h:1/a1'),
    row('aaa', 'D:/w/a', 'prod', 'mysql://h:1/a2'),
    row('aaa', 'D:/w/b', 'prod', 'mysql://h:1/b'),
    row('zzz', 'D:/w/z', 'prod', 'mysql://h:1/z'),
  ]
  assert.deepEqual(sortRows(rows, 'name-desc').map(rowKeyOf),
    ['D:/w/z|prod', 'D:/w/b|prod', 'D:/w/a|prod', 'D:/w/a|default'])
  // Rows that compare equal keep their INPUT order in both directions (a stable
  // sort — otherwise the list would flicker between renders).
  const twins = [
    row('same', 'D:/w/1', 'default', 'mysql://h:1/1'),
    row('same', 'D:/w/1', 'default', 'mysql://h:1/1'),
  ]
  assert.deepEqual(sortRows(twins, 'name-desc').map((r) => r.path), ['D:/w/1', 'D:/w/1'])
})

test('the sort control cycles 默认 → 名称 ↑ → 名称 ↓ → 最近更新 → 默认', () => {
  assert.equal(nextSortMode(''), 'name-asc')
  assert.equal(nextSortMode('name-asc'), 'name-desc')
  assert.equal(nextSortMode('name-desc'), 'recent')
  assert.equal(nextSortMode('recent'), '')
  // The pre-6.0 spelling of the ascending state continues the cycle, and an
  // unknown value starts it again instead of sticking.
  assert.equal(nextSortMode('name'), 'name-desc')
  assert.equal(nextSortMode('nonsense'), 'name-asc')
  assert.equal(nextSortMode(undefined), 'name-asc')
})

test('the sort control displays a label key and an arrow per state', () => {
  assert.deepEqual(sortViewOf(''), { key: 'sort.modeDefault', arrow: '' })
  assert.deepEqual(sortViewOf('name-asc'), { key: 'sort.name', arrow: '↑' })
  assert.deepEqual(sortViewOf('name'), { key: 'sort.name', arrow: '↑' })
  assert.deepEqual(sortViewOf('name-desc'), { key: 'sort.name', arrow: '↓' })
  assert.deepEqual(sortViewOf('recent'), { key: 'sort.recent', arrow: '' })
  assert.deepEqual(sortViewOf(undefined), { key: 'sort.modeDefault', arrow: '' })
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

// ── stored order (drag & drop) ──────────────────────────────────────────────
//
// The Host publishes the same `order` array on EVERY row of a workspace (there is
// no group object on the wire), and only PERSISTED environments appear in it.

test('orderMapOf reads one array per workspace, from the first row that has one', () => {
  const rows = [
    row('app', 'D:/w/a', 'prod', 'mysql://h:1/a1', { order: ['prod', 'default'] }),
    row('app', 'D:/w/a', 'default', 'mysql://h:1/a2'),
    row('docs', 'D:/w/d', 'default', 'mysql://h:1/d'),
  ]
  assert.deepEqual(orderMapOf(rows), { 'D:/w/a': ['prod', 'default'] })
  // No `order` anywhere (an older Host, or a workspace with no persisted row):
  // an empty map, never a guess.
  assert.deepEqual(orderMapOf([row('x', 'D:/w/x', 'default', 'mysql://h:1/x')]), {})
  // Junk entries are dropped rather than turned into env names.
  assert.deepEqual(orderMapOf([row('x', 'D:/w/x', 'default', 'c', { order: ['a', '', null, 7] })]),
    { 'D:/w/x': ['a', '7'] })
  assert.deepEqual(orderMapOf(null), {})
})

test('the stored order wins; rows it does not know follow by name', () => {
  const rows = [
    row('app', 'D:/w/a', 'default', 'mysql://h:1/a1', { order: ['prod', 'default'] }),
    row('app', 'D:/w/a', 'zeta', 'mysql://h:1/z', { persisted: false }),
    row('app', 'D:/w/a', 'prod', 'mysql://h:1/a2'),
    row('app', 'D:/w/a', 'beta', 'mysql://h:1/b', { persisted: false }),
  ]
  // prod/default as stored, then the auto rows alphabetically — and NOT the
  // input order (default, zeta, prod, beta).
  assert.deepEqual(sortByStoredOrder(rows).map((r) => r.env), ['prod', 'default', 'beta', 'zeta'])
  // Names in `order` that no longer exist are simply skipped.
  const stale = [
    row('g', 'D:/w/g', 'b', 'mysql://h:1/b', { order: ['gone', 'b', 'a'] }),
    row('g', 'D:/w/g', 'a', 'mysql://h:1/a'),
  ]
  assert.deepEqual(sortByStoredOrder(stale).map((r) => r.env), ['b', 'a'])
  // The caller's array is never reordered.
  const copy = rows.slice()
  sortByStoredOrder(rows)
  assert.deepEqual(rows, copy)
})

test('a workspace without a stored order falls back to name order (its own group only)', () => {
  const rows = [
    row('b', 'D:/w/b', 'zzz', 'mysql://h:1/z'),
    row('a', 'D:/w/a', 'yyy', 'mysql://h:1/y'),
    row('b', 'D:/w/b', 'aaa', 'mysql://h:1/a'),
    row('a', 'D:/w/a', 'xxx', 'mysql://h:1/x'),
  ]
  const out = sortByStoredOrder(rows)
  // Groups keep their first-appearance order; rows inside each sort by name.
  assert.deepEqual(out.map((r) => r.title + '/' + r.env), ['b/aaa', 'b/zzz', 'a/xxx', 'a/yyy'])
})

test('persistedRowsOf is the move/copy domain (auto rows are excluded)', () => {
  const rows = [
    row('a', 'D:/w/a', 'one', 'mysql://h:1/1'),
    row('a', 'D:/w/a', 'auto', 'mysql://h:1/2', { persisted: false }),
    row('a', 'D:/w/a', 'two', 'mysql://h:1/3'),
  ]
  assert.deepEqual(persistedRowsOf(rows).map((r) => r.env), ['one', 'two'])
  assert.deepEqual(persistedRowsOf(null), [])
})

test('moveIndexFor measures the index AFTER the source leaves its list', () => {
  const groupA = [
    row('a', 'D:/w/a', 'one', 'mysql://h:1/1'),
    row('a', 'D:/w/a', 'two', 'mysql://h:1/2'),
    row('a', 'D:/w/a', 'three', 'mysql://h:1/3'),
  ]
  const groupB = [
    row('b', 'D:/w/b', 'x', 'mysql://h:1/x'),
    row('b', 'D:/w/b', 'y', 'mysql://h:1/y'),
  ]
  const [one, two, three] = groupA
  const [x, y] = groupB
  // Within one workspace, dragging `one` below `two` → index 1 (not 2): after
  // removing `one` the list is [two, three] and 1 is right after `two`.
  assert.equal(moveIndexFor(groupA, one, two, true), 1)
  // Dragging `three` above `one` → index 0.
  assert.equal(moveIndexFor(groupA, three, one, false), 0)
  // Dropping on your OWN lower half is a no-op, not an off-by-one.
  assert.equal(moveIndexFor(groupA, two, two, true), 1)
  assert.equal(moveIndexFor(groupA, two, two, false), 1)
  // Cross-workspace: the source is not in the target list, so nothing shifts.
  assert.equal(moveIndexFor(groupB, one, y, true), 2)
  assert.equal(moveIndexFor(groupB, one, x, false), 0)
  // The group's empty area appends to the persisted rows of THAT workspace.
  assert.equal(moveIndexFor(groupB, one, null, true), 2)
  assert.equal(moveIndexFor(groupB, null, null, true), 2)
  // Out-of-range values are clamped to a legal insert position.
  assert.equal(moveIndexFor(groupA, null, one, false), 0)
  assert.equal(moveIndexFor(groupA, null, three, true), 3)
  // An auto-discovered row is not a place in `order`: dropping on it appends.
  const withAuto = [x, y, row('b', 'D:/w/b', 'auto', 'mysql://h:1/z', { persisted: false })]
  assert.equal(moveIndexFor(withAuto, null, withAuto[2], false), 2)
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

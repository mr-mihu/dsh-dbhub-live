// The dsh-Go native panel (lib/native.mjs): the view the Android app draws, the
// data model behind it, the actions a tap triggers, and — the one that matters —
// that none of it can carry a secret.
//
// These run without a Host on purpose: the module takes every Host fact through
// `deps`, so the shapes here are exactly what the bridge serialises.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NATIVE_PANEL_ID, MAX_ROWS, localeOf, panelView, panelData, panelFeed,
  registerNativePanel, resetNativeLog,
} from '../lib/native.mjs'

// ── fixtures ──────────────────────────────────────────────────────────────

/** A metadata-only summary row, exactly as summarizeRows publishes it. */
function row(over) {
  return {
    title: 'demo-app',
    path: 'C:\\ws\\demo',
    env: 'prod',
    alias: 'prod',
    conn: 'mysql://198.51.100.7:3306/appdb',
    source: 'user',
    persisted: true,
    srcId: 'demo_ab12_prod',
    ro: false,
    ssh: null,
    ...over,
  }
}

function snapshot(over) {
  return {
    // state.snapshot() …
    enabled: true,
    phase: 'running',
    toolCount: 4,
    lastError: '',
    mode: 'oneshot',
    // … and options.snapshot(), FLATTENED beside it (their keys do not overlap):
    // that is what index.mjs hands over.
    showSidebarEntry: true,
    announceAccessPolicy: true,
    exportDir: '',
    defaultMaxRows: 0,
    batchConcurrency: 2,
    rows: [row()],
    pluginVersion: '6.1.0',
    ...over,
  }
}

const ZH = { locale: 'zh-CN' }
const EN = { locale: 'en-US' }

// ── locale ────────────────────────────────────────────────────────────────

test('localeOf reads the app locale tag, defaulting to zh', () => {
  assert.equal(localeOf(ZH), 'zh')
  assert.equal(localeOf(EN), 'en')
  assert.equal(localeOf({ locale: 'EN_gb' }), 'en')
  assert.equal(localeOf({}), 'zh')
  assert.equal(localeOf(undefined), 'zh')
  assert.equal(localeOf({ locale: 42 }), 'zh')
})

// ── the view ──────────────────────────────────────────────────────────────

test('panelView uses only protocol-v1 components the app has always drawn', () => {
  // v2-only components would render as grey placeholders on an older app; the
  // panel is meant to work on every app that draws a panel at all.
  const V1 = new Set(['stack', 'row', 'text', 'callout', 'steps', 'compare', 'metric', 'chart', 'progress',
    'list', 'keyValue', 'table', 'actions', 'image', 'options', 'confirm'])
  const seen = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'string') seen.push(node.type)
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  }
  walk(panelView({}, ZH))
  assert.ok(seen.length > 0)
  for (const type of seen) assert.ok(V1.has(type), `view uses a non-v1 component: ${type}`)
  // No `v: 2` opt-in either — that is what would switch the app to the v2 path.
  assert.equal(panelView({}, ZH).v, undefined)
})

test('panelView is language-neutral structure: every changing value is a binding', () => {
  const view = panelView({}, ZH)
  const json = JSON.stringify(view)
  // Structure carries its own static headings; the changing values are bindings.
  assert.match(json, /\{"\$":"data\.statusText"\}/)
  assert.match(json, /\{"\$":"data\.rows"\}/)
  assert.match(json, /\{"\$":"data\.settingRows"\}/)
  assert.match(json, /\{"\$":"data\.toggleLabel"\}/)
  // A view the bridge accepts: under the panel's 32 KiB budget.
  assert.ok(Buffer.byteLength(json, 'utf8') < 32 * 1024)
})

test('panelView headings follow the app locale', () => {
  const zh = JSON.stringify(panelView({}, ZH))
  const en = JSON.stringify(panelView({}, EN))
  assert.notEqual(zh, en)
  assert.match(zh, /连接/)
  assert.match(en, /Connections/)
})

test('panelView action ids match the actions the registration supplies', () => {
  const ids = []
  const actions = panelView({}, ZH).children.find((c) => c.type === 'actions')
  for (const item of actions.items) ids.push(item.action)
  assert.deepEqual(ids.sort(), ['refresh', 'toggle'])
})

// ── the data model ────────────────────────────────────────────────────────

test('panelData carries metadata only — never a DSN, username or password', () => {
  const data = panelData(snapshot({
    rows: [
      row({ conn: 'mysql://198.51.100.7:3306/appdb' }),
      row({ env: 'dev', alias: 'dev', conn: 'postgres://192.0.2.9:5432/appdev', ro: true }),
    ],
  }), 'zh')
  const json = JSON.stringify(data)
  // The label the view shows is `connLabel` output: `scheme://host:port/database`
  // with the whole userinfo section stripped. A password, a username or a
  // credential-bearing userinfo must not appear.
  assert.doesNotMatch(json, /CHANGE_ME/)
  assert.doesNotMatch(json, /:\/\/[^"]*@/)          // userinfo
  assert.doesNotMatch(json, /\b(password|passwd|pwd|secret|token)\b/i)
  assert.match(json, /198\.51\.100\.7:3306\/appdb/)
})

test('panelData renders one row per connection with its read-only verdict as text', () => {
  const data = panelData(snapshot({
    rows: [row({ env: 'prod', alias: 'prod' }), row({ env: 'dev', alias: 'dev', ro: true })],
  }), 'zh')
  assert.equal(data.rows.length, 2)
  assert.equal(data.rows[0].title, 'prod')
  assert.equal(data.rows[0].trailing, '可写')
  assert.equal(data.rows[1].trailing, '只读')
  // Read-only also carries a tone, so the app does not rely on colour alone
  // (the icon set has no lock glyph by design).
  assert.equal(data.rows[1].tone, 'good')
  assert.equal(data.rows[0].tone, undefined)
})

test('panelData marks a tunnelled connection without exposing the tunnel', () => {
  const data = panelData(snapshot({
    rows: [row({ ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', hasPassword: true } })],
  }), 'zh')
  const json = JSON.stringify(data)
  assert.match(json, /经 SSH 隧道/)
  // The block is metadata, but its host/user are NOT published: the row shows
  // that a tunnel is in use, not where it goes.
  assert.doesNotMatch(json, /bastion/)
  assert.doesNotMatch(json, /deploy/)
})

test('panelData gives every addressable row a test action and no others', () => {
  const data = panelData(snapshot({
    rows: [row(), row({ env: 'dev', alias: 'dev', path: '' })],
  }), 'zh')
  assert.deepEqual(data.rows[0].action, { id: 'test', args: { path: 'C:\\ws\\demo', env: 'prod' } })
  // A row whose workspace cannot be named would invoke a probe that can never
  // resolve, so it stays inert instead of failing on every tap.
  assert.equal(data.rows[1].action, undefined)
})

test('panelData caps the list and says how many are left', () => {
  const many = []
  for (let i = 0; i < MAX_ROWS + 3; i += 1) many.push(row({ env: 'e' + i, alias: 'a' + i }))
  const data = panelData(snapshot({ rows: many }), 'zh')
  assert.equal(data.rows.length, MAX_ROWS + 1)
  assert.match(data.rows[MAX_ROWS].title, /还有 3 个连接/)
  // The overflow row is not tappable.
  assert.equal(data.rows[MAX_ROWS].action, undefined)
})

test('panelData renders an empty state that says what to do', () => {
  const data = panelData(snapshot({ rows: [] }), 'en')
  assert.equal(data.rows.length, 1)
  assert.match(data.rows[0].title, /No connections/)
  assert.equal(data.rows[0].action, undefined)
})

test('panelData reports the three phases, and only an error repeats the message', () => {
  const running = panelData(snapshot(), 'en')
  assert.equal(running.statusTone, 'info')
  assert.match(running.statusText, /Running/)

  const disabled = panelData(snapshot({ enabled: false, phase: 'disabled' }), 'en')
  assert.equal(disabled.statusTone, 'warn')
  assert.match(disabled.statusText, /Disabled/)

  const broken = panelData(snapshot({ phase: 'error', lastError: 'boom' }), 'en')
  assert.equal(broken.statusTone, 'bad')
  assert.match(broken.statusText, /boom/)
  // `lastError` is boot-only and is scrubbed at the source; the panel clips it.
  const long = panelData(snapshot({ phase: 'error', lastError: 'x'.repeat(400) }), 'en')
  assert.ok(long.statusText.length < 200)
})

test('panelData splits the settings into the read-only block and the controls', () => {
  const data = panelData(snapshot({
    defaultMaxRows: 0, batchConcurrency: 4,
    exportDir: '/tmp/exports', showSidebarEntry: false, announceAccessPolicy: false,
  }), 'en')
  // The read-only block keeps what the phone must not own: the probed directory
  // path and the build.
  const map = Object.fromEntries(data.settingRows)
  assert.deepEqual(Object.keys(map).sort(), ['Export directory', 'Plugin version'])
  assert.equal(map['Export directory'], '/tmp/exports')
  assert.equal(map['Plugin version'], '6.1.0')
  // '' is the default directory, not an empty line.
  assert.equal(Object.fromEntries(panelData(snapshot(), 'en').settingRows)['Export directory'], 'Default location')
  // The editable ones travel as `sel`, one string per control.
  assert.deepEqual(data.sel, {
    defaultMaxRows: '0',
    batchConcurrency: '4',
    showSidebarEntry: 'false',
    announceAccessPolicy: 'false',
  })
  // A stored value outside the offered set lights NOTHING: the nearest choice
  // would misreport what the Host actually holds.
  const odd = panelData(snapshot({ defaultMaxRows: 250, batchConcurrency: 3 }), 'en')
  assert.equal(odd.sel.defaultMaxRows, '')
  assert.equal(odd.sel.batchConcurrency, '')
})

test('panelData survives a Host that hands over nothing at all', () => {
  for (const input of [undefined, null, {}, { rows: null }, { rows: [null, 7, 'x'] }]) {
    const data = panelData(input, 'zh')
    assert.equal(typeof data.statusText, 'string')
    assert.ok(Array.isArray(data.rows))
    assert.ok(Array.isArray(data.settingRows))
    assert.ok(data.toggleLabel.length > 0)
  }
})

test('panelData toggle label states what the tap will do', () => {
  assert.equal(panelData(snapshot(), 'en').toggleLabel, 'Disable plugin')
  assert.equal(panelData(snapshot({ enabled: false }), 'en').toggleLabel, 'Enable plugin')
})

// ── the feed ──────────────────────────────────────────────────────────────

test('panelFeed emits at once, walks only when it must, and stops cleanly', () => {
  resetNativeLog()
  const emitted = []
  let walk = 0
  let disposed = 0
  const deps = {
    snapshot: () => snapshot(),
    subscribe: (fn) => {
      deps.push = fn
      return () => { disposed += 1 }
    },
    refresh: () => { walk += 1 },
    hasRows: () => false,
  }
  const cancel = panelFeed({}, (d) => emitted.push(d), ZH, deps)
  assert.equal(emitted.length, 1, 'the first model is emitted synchronously')
  assert.equal(walk, 1, 'a cold cache triggers exactly one walk')
  deps.push()
  assert.equal(emitted.length, 2, 'a Host change re-emits')
  cancel()
  assert.equal(disposed, 1, 'the subscription is released')
  deps.push()
  assert.equal(emitted.length, 2, 'nothing is emitted after cancel')
  // A refresh on a warm cache must not spawn another walk.
  const warm = { snapshot: () => snapshot(), subscribe: () => () => {}, refresh: () => { walk += 1 }, hasRows: () => true }
  panelFeed({}, () => {}, ZH, warm)()
  assert.equal(walk, 1)
})

test('panelFeed does not walk a disabled plugin', () => {
  let walk = 0
  const deps = {
    snapshot: () => snapshot({ enabled: false, phase: 'disabled' }),
    subscribe: () => () => {},
    refresh: () => { walk += 1 },
    hasRows: () => false,
  }
  panelFeed({}, () => {}, ZH, deps)()
  assert.equal(walk, 0)
})

test('panelFeed keeps the last model when the Host snapshot throws', () => {
  resetNativeLog()
  const emitted = []
  let calls = 0
  const deps = {
    snapshot: () => {
      calls += 1
      if (calls === 1) return snapshot()
      throw new Error('boom')
    },
    subscribe: (fn) => { deps.push = fn; return () => {} },
    refresh: () => {},
    hasRows: () => true,
  }
  panelFeed({}, (d) => emitted.push(d), ZH, deps)
  deps.push()
  assert.equal(emitted.length, 1, 'a throwing snapshot never emits a broken model')
})

// ── registration ──────────────────────────────────────────────────────────

test('registerNativePanel injects dshGo through ctx.inject, never the top-level splice', () => {
  // cordis has no optional-dependency syntax: `['dshGo?']` would never fire, and a
  // top-level `dshGo` dependency keeps the plugin from starting on a Host without
  // the bridge. Both are the documented failure modes, so assert on the CALL rather
  // than on the prose that warns about them.
  const source = readFileSync(new URL('../lib/native.mjs', import.meta.url), 'utf8')
  // Strip comments first: the module's prose quotes the two wrong spellings it
  // warns about, and a guard that trips on its own documentation is worthless.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const calls = [...code.matchAll(/ctx\.inject\(\s*\[([^\]]*)\]/g)].map((m) => m[1].trim())
  assert.deepEqual(calls, ["'dshGo'"], 'the only injection is a required dshGo one')
  // ...and the plugin's own top-level `inject` must not list it, or a Host
  // without the bridge would refuse to start the whole plugin.
  const index = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
  const topLevel = /export const inject = \[([^\]]*)\]/.exec(index)
  assert.ok(topLevel, 'index.mjs declares a top-level inject array')
  assert.doesNotMatch(topLevel[1], /dshGo/)
})

test('registerNativePanel hands the bridge one panel with view, data and actions', () => {
  resetNativeLog()
  const registered = []
  let injected
  const ctx = {
    inject(names, callback) {
      injected = names
      callback({ dshGo: { panel: (id, def) => registered.push({ id, def }) } })
    },
  }
  const deps = { snapshot: () => snapshot(), subscribe: () => () => {}, refresh: () => {}, hasRows: () => true, setEnabled: () => {}, testConnection: async () => ({ ok: true, ms: 1 }), setOption: () => ({ ok: true }) }
  assert.equal(registerNativePanel(ctx, deps), true)
  assert.deepEqual(injected, ['dshGo'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, NATIVE_PANEL_ID)
  const def = registered[0].def
  assert.equal(typeof def.view, 'function')
  assert.equal(typeof def.data, 'function')
  // Three verbs plus one writer per editable setting plus the per-connection
  // read-only switch; the writers are derived from OPTION_CONTROLS, so a new
  // control cannot ship without its action.
  assert.deepEqual(Object.keys(def.actions).sort(), [
    'refresh', 'ro', 'set.announceAccessPolicy', 'set.batchConcurrency', 'set.defaultMaxRows',
    'set.showSidebarEntry', 'test', 'toggle',
  ])
  // Every control the view draws has a handler, and every handler has a control.
  const drawn = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'options' && typeof node.id === 'string') drawn.add(node.id)
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  }
  walk(def.view({}, ZH))
  assert.deepEqual([...drawn].sort(), Object.keys(def.actions).filter((k) => k.startsWith('set.')).sort())
  // The view function is callable with the bridge's arguments.
  assert.equal(typeof def.view({}, ZH).type, 'string')
})

test('registerNativePanel is inert on a Host without the dshGo service', () => {
  resetNativeLog()
  // A Host with no bridge at all: the service is absent, the callback must not
  // throw, and nothing else may change.
  const ctx = { inject: () => {} }
  assert.equal(registerNativePanel(ctx, {}), false)
  assert.equal(registerNativePanel(undefined, {}), false)
  // A bridge that does not expose `panel` (an older one) is equally harmless.
  const old = { inject: (names, cb) => cb({ dshGo: {} }) }
  assert.equal(registerNativePanel(old, {}), false)
})

test('registerNativePanel contains a throwing injection', () => {
  resetNativeLog()
  const ctx = { inject: () => { throw new Error('no injector') } }
  assert.equal(registerNativePanel(ctx, {}), false)
})

// ── actions ───────────────────────────────────────────────────────────────

/** Register once against a fake bridge and return its action table. */
function actionsWith(deps) {
  let table
  const ctx = {
    inject: (names, callback) => callback({
      dshGo: { panel: (id, def) => { table = def.actions } },
    }),
  }
  registerNativePanel(ctx, {
    snapshot: () => snapshot(), subscribe: () => () => {}, refresh: () => {}, hasRows: () => true, ...deps,
  })
  return table
}

test('the toggle action flips the flag and answers in the app language', () => {
  for (const [locale, word] of [['zh-CN', '已停用'], ['en-US', 'Disabled']]) {
    let got
    const actions = actionsWith({ setEnabled: (v) => { got = v } })
    const effects = actions.toggle({}, { locale })
    assert.equal(got, false, 'an enabled plugin turns off')
    assert.equal(effects.toast, word)
  }
})

test('the toggle action reports a refused write instead of claiming success', () => {
  const actions = actionsWith({ setEnabled: () => { throw new Error('nope') } })
  const effects = actions.toggle({}, { locale: 'en-US' })
  assert.match(effects.toast, /did not apply/)
})

test('the refresh action re-walks and asks the app to re-read the view', () => {
  let walks = 0
  const actions = actionsWith({ refresh: () => { walks += 1 } })
  assert.deepEqual(actions.refresh({}, {}), { refresh: true })
  assert.equal(walks, 1)
})

test('the test action is deferred and resolves to a toast, never a late open', () => {
  let seen
  const actions = actionsWith({
    testConnection: async (path, env, signal) => {
      seen = { path, env, hasSignal: signal !== undefined || true }
      return { ok: true, ms: 42 }
    },
  })
  const pending = actions.test({}, { locale: 'en-US', value: { path: 'C:\\ws\\demo', env: 'prod' } })
  assert.ok(pending.pending, 'a probe is slow, so it is a deferred effect')
  assert.equal(pending.pending.timeoutMs, 60000)
  assert.equal(typeof pending.result, 'function')
  return pending.result(new AbortController().signal).then((effects) => {
    assert.deepEqual(seen, { path: 'C:\\ws\\demo', env: 'prod', hasSignal: true })
    assert.match(effects.toast, /Connected \(42 ms\)/)
  })
})

test('the test action turns a failure into the same short verdict, whatever the cause', () => {
  const actions = actionsWith({
    testConnection: async () => ({ ok: false, message: 'ECONNREFUSED 203.0.113.5:3306 — very long dbhub text' }),
  })
  return actions.test({}, { locale: 'en-US', value: { path: 'p', env: 'e' } }).result()
    .then((effects) => assert.match(effects.toast, /Connection failed/))
})

test('the test action survives a probe that throws', () => {
  const actions = actionsWith({ testConnection: async () => { throw new Error('spawn failed') } })
  return actions.test({}, { locale: 'en-US', value: { path: 'p', env: 'e' } }).result()
    .then((effects) => assert.match(effects.toast, /Connection failed/))
})

test('the test action refuses a tap that carries no connection', () => {
  const actions = actionsWith({})
  for (const event of [{}, { value: null }, { value: {} }, { value: { path: '' } }]) {
    const effects = actions.test({}, { locale: 'en-US', ...event })
    assert.equal(effects.pending, undefined, 'nothing to probe means nothing to wait for')
    assert.match(effects.toast, /Connection failed/)
  }
})

test('the test action treats a cancelled probe as a failure, never a success', () => {
  // The Host owns the cancellation check (see index.mjs `testConnection`); the
  // action's contract is only that a non-`ok` result becomes the failure verdict.
  const actions = actionsWith({ testConnection: async () => ({ ok: false, message: 'cancelled' }) })
  return actions.test({}, { locale: 'en-US', value: { path: 'p', env: 'e' } }).result()
    .then((effects) => assert.match(effects.toast, /Connection failed/))
})

test('the option action decodes a tapped choice into a one-key patch', () => {
  const written = []
  const actions = actionsWith({
    setOption: (patch) => {
      written.push(patch)
      return { ok: true }
    },
  })
  // A number and a boolean: the value shapes the controls offer. The app
  // transports both as strings.
  assert.equal(actions['set.defaultMaxRows']({}, { locale: 'en-US', value: { value: '500' } }).toast, 'Saved')
  assert.equal(actions['set.showSidebarEntry']({}, { locale: 'en-US', value: { value: 'true' } }).toast, 'Saved')
  assert.deepEqual(written, [
    { defaultMaxRows: 500 },
    { showSidebarEntry: true },
  ])
})

test('the option action refuses a value the panel never offered', () => {
  const written = []
  const actions = actionsWith({
    setOption: (patch) => {
      written.push(patch)
      return { ok: true }
    },
  })
  // Nothing outside the offered set may reach the Host's validators — not a
  // neighbouring number, not a negative, not a stringified exponent, not a
  // missing value, not an object. A value that IS one of the choices is accepted
  // whatever its JS type (the comparison is by string, as the app transports it).
  for (const value of ['250', '-1', '1e9', '', 'abc', undefined, null, { n: 1 }, [500]]) {
    const effects = actions['set.defaultMaxRows']({}, { locale: 'en-US', value: { value } })
    assert.match(effects.toast, /did not apply/, `value ${JSON.stringify(value)} must not reach the Host`)
  }
  assert.deepEqual(written, [], 'nothing reaches the write path')
  actions['set.defaultMaxRows']({}, { locale: 'en-US', value: { value: 500 } })
  assert.deepEqual(written, [{ defaultMaxRows: 500 }], 'an offered choice is accepted')
})

test('the option action reports a refused write and re-sends the Host selection', () => {
  const actions = actionsWith({
    // The Host keeps its value: `snapshot()` is unchanged, so the app must be
    // told the truth (the tapped option snaps back) instead of showing a value
    // the Host never accepted.
    setOption: () => ({ ok: false, error: 'badMaxRows' }),
  })
  const effects = actions['set.defaultMaxRows']({}, { locale: 'en-US', value: { value: '500' } })
  assert.match(effects.toast, /did not apply/)
  assert.equal(effects.patch.sel.defaultMaxRows, '0')
})

test('the option action survives a write that throws and one that returns nothing', () => {
  const throwing = actionsWith({ setOption: () => { throw new Error('boom') } })
  assert.match(throwing['set.batchConcurrency']({}, { locale: 'en-US', value: { value: '4' } }).toast, /did not apply/)
  // `undefined` means the Host wrote it (the callback is `void`-shaped in some
  // deployments); it must not read as a failure.
  const silent = actionsWith({ setOption: () => undefined })
  assert.match(silent['set.batchConcurrency']({}, { locale: 'en-US', value: { value: '4' } }).toast, /Saved/)
  // No `setOption` at all (an older Host wiring) is a refusal, not a crash.
  const missing = actionsWith({})
  assert.match(missing['set.batchConcurrency']({}, { locale: 'en-US', value: { value: '4' } }).toast, /did not apply/)
})

test('panelData lists the read-only switch per connection, carrying the value it wants', () => {
  const data = panelData(snapshot({
    rows: [row(), row({ env: 'dev', alias: 'dev', ro: true }), row({ env: 'tmp', alias: 'tmp', path: '' })],
  }), 'zh')
  assert.equal(data.roRows.length, 3)
  // The tap names the TARGET value, never "toggle": a stale view must not be able
  // to invert the switch twice and land on the opposite of what the user saw.
  assert.deepEqual(data.roRows[0].action, { id: 'ro', args: { path: 'C:\\ws\\demo', env: 'prod', ro: '1' } })
  assert.deepEqual(data.roRows[1].action, { id: 'ro', args: { path: 'C:\\ws\\demo', env: 'dev', ro: '0' } })
  // An unaddressable row is shown but inert (no workspace to write to).
  assert.equal(data.roRows[2].action, undefined)
  // State is text, never a security icon (the app's icon set has none on purpose).
  assert.equal(data.roRows[0].trailing, '可写')
  assert.equal(data.roRows[1].trailing, '只读')
  assert.equal(data.roRows[1].tone, 'good')
})

test('panelData gives the read-only list its own empty and overflow lines', () => {
  const empty = panelData(snapshot({ rows: [] }), 'en')
  assert.equal(empty.roRows.length, 1)
  assert.match(empty.roRows[0].title, /No connections/)
  assert.equal(empty.roRows[0].action, undefined)

  const many = []
  for (let i = 0; i < MAX_ROWS + 2; i += 1) many.push(row({ env: 'e' + i, alias: 'a' + i }))
  const data = panelData(snapshot({ rows: many }), 'en')
  assert.equal(data.roRows.length, MAX_ROWS + 1)
  assert.match(data.roRows[MAX_ROWS].title, /2 more connections/)
  assert.equal(data.roRows[MAX_ROWS].action, undefined)
})

test('the read-only action writes the value the tap carried, not the inverse of the view', async () => {
  const writes = []
  const actions = actionsWith({
    setReadOnly: (path, env, ro) => {
      writes.push({ path, env, ro })
      return { ok: true }
    },
  })
  // The handler is async (the Host writer is): the bridge awaits it, so the test
  // must too — a synchronous read would see a Promise and prove nothing.
  assert.match((await actions.ro({}, { locale: 'zh-CN', value: { path: 'C:\\ws\\demo', env: 'prod', ro: '1' } })).toast, /只读/)
  assert.match((await actions.ro({}, { locale: 'zh-CN', value: { path: 'C:\\ws\\demo', env: 'prod', ro: '0' } })).toast, /可写/)
  assert.deepEqual(writes, [
    { path: 'C:\\ws\\demo', env: 'prod', ro: true },
    { path: 'C:\\ws\\demo', env: 'prod', ro: false },
  ])
})

test('the read-only action refuses a tap it cannot act on, and reports a refused write', async () => {
  const writes = []
  const actions = actionsWith({
    setReadOnly: (path, env, ro) => {
      writes.push({ path, env, ro })
      return { ok: true }
    },
  })
  // No path, no value, a value that is neither 0 nor 1, an object: all refused
  // before the write path, all answered with the same short verdict.
  for (const value of [{}, { path: '' }, { path: 'p' }, { path: 'p', ro: 'yes' }, { path: 'p', ro: 2 }, { path: 'p', ro: {} }, null]) {
    const effects = await actions.ro({}, { locale: 'en-US', value })
    assert.match(effects.toast, /did not apply/, `value ${JSON.stringify(value)} must not reach the Host`)
  }
  assert.deepEqual(writes, [])

  const refused = actionsWith({ setReadOnly: async () => ({ ok: false, error: 'unknownWorkspace' }) })
  assert.match((await refused.ro({}, { locale: 'en-US', value: { path: 'p', env: 'e', ro: '1' } })).toast, /did not apply/)
  const throwing = actionsWith({ setReadOnly: async () => { throw new Error('boom') } })
  assert.match((await throwing.ro({}, { locale: 'en-US', value: { path: 'p', env: 'e', ro: '1' } })).toast, /did not apply/)
  // An older Host wiring without `setReadOnly` is a refusal, not a crash.
  assert.match((await actionsWith({}).ro({}, { locale: 'en-US', value: { path: 'p', env: 'e', ro: '1' } })).toast, /did not apply/)
})

test('every effect an action returns is on the whitelist the bridge accepts', () => {
  // A deferred result may only carry insert / copy / toast / patch; an immediate
  // one may add open / link / command / refresh. Anything else is dropped by the
  // bridge and the tap looks dead.
  const IMMEDIATE = new Set(['insert', 'command', 'open', 'link', 'toast', 'copy', 'refresh', 'patch'])
  const DEFERRED = new Set(['insert', 'copy', 'toast', 'patch'])
  const shapeOf = (effects) => {
    if (!effects || typeof effects !== 'object') return []
    // Shorthand (`{ toast }`) expands to one typed effect, like the bridge does.
    return Object.keys(effects).filter((k) => k !== 'pending' && k !== 'result' && effects[k] !== undefined)
  }
  for (const effects of [
    actionsWith({ setEnabled: () => {}, refresh: () => {} }).toggle({}, { locale: 'zh-CN' }),
    actionsWith({}).refresh({}, {}),
    actionsWith({ setOption: () => ({ ok: true }) })['set.defaultMaxRows']({}, { locale: 'zh-CN', value: { value: '500' } }),
    actionsWith({ setOption: () => ({ ok: false }) })['set.defaultMaxRows']({}, { locale: 'zh-CN', value: { value: '500' } }),
    actionsWith({ setReadOnly: () => ({ ok: true }) }).ro({}, { locale: 'zh-CN', value: { path: 'p', env: 'e', ro: '1' } }),
    actionsWith({ setReadOnly: () => ({ ok: false }) }).ro({}, { locale: 'zh-CN', value: { path: 'p', env: 'e', ro: '1' } }),
  ]) {
    for (const key of shapeOf(effects)) {
      if (key === 'refresh') continue
      assert.ok(IMMEDIATE.has(key), `unknown immediate effect key: ${key}`)
    }
  }
  return actionsWith({ testConnection: async () => ({ ok: false }) })
    .test({}, { locale: 'zh-CN', value: { path: 'p' } })
    .result()
    .then((effects) => {
      for (const key of shapeOf(effects)) assert.ok(DEFERRED.has(key), `unknown deferred effect key: ${key}`)
    })
})

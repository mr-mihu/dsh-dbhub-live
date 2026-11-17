// End-to-end wiring of the dsh-Go native panel through the plugin's REAL entry
// point: `apply()` must hand one panel to a Host that has the `dshGo` service,
// and must start exactly as before on a Host that does not.
//
// `test/native-panel.test.mjs` covers the shapes; this file covers the splice —
// the one place where a wrong `inject` form would either never fire or take the
// whole plugin down on a Host without the bridge.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-native-e2e-'))
process.env.DSH_HOME = home

const index = await import('../lib/index.mjs')
const optionsMod = await import('../lib/options.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * The smallest context `apply()` accepts. `withDshGo` decides whether the
 * `dshGo` service exists at all — the two cases a real Host can be in.
 */
function host(withDshGo) {
  const tools = []
  const panels = []
  const walked = { n: 0 }
  const ctx = {
    tools: { register: (def) => { tools.push(def.name); return () => {} } },
    get: (name) => (name === 'workspaceRegistry' ? { list: async () => [] } : undefined),
    effect: (fn) => { try { fn() } catch (e) { /* contained */ } return () => {} },
    on: () => {},
    inject: (names, callback) => {
      const scope = { effect: (fn) => { try { fn() } catch (e) { /* contained */ } return () => {} } }
      if (names.includes('dshGo') && withDshGo) {
        scope.dshGo = { panel: (id, def) => panels.push({ id, def }) }
      }
      try {
        callback(scope)
      } catch (e) {
        /* a Host without the service never enters this branch */
      }
      return () => {}
    },
  }
  return { ctx, tools, panels, walked }
}

test('apply() registers the native panel on a Host with the dshGo service', async () => {
  const h = host(true)
  await index.apply(h.ctx, undefined)
  // The four tools are unchanged: the panel is an ADDITION, not a replacement.
  assert.equal(h.tools.length, 4)
  assert.deepEqual(h.panels.map((p) => p.id), ['dbhub'])
  const def = h.panels[0].def
  assert.equal(typeof def.view, 'function')
  assert.equal(typeof def.data, 'function')
  assert.deepEqual(Object.keys(def.actions).sort(), [
    'refresh', 'set.announceAccessPolicy', 'set.batchConcurrency', 'set.defaultMaxRows',
    'set.showSidebarEntry', 'set.updateIntervalDays', 'test', 'toggle',
  ])
  // The data feed survives the real snapshot shape (state + options flattened).
  const emitted = []
  const cancel = def.data({}, (d) => emitted.push(d), { locale: 'en-US' })
  assert.equal(emitted.length, 1)
  assert.match(emitted[0].statusText, /Running/)
  assert.match(JSON.stringify(emitted[0]), /Plugin version/)
  assert.equal(typeof cancel, 'function')
  cancel()
})

test('apply() starts identically on a Host without the dshGo bridge', async () => {
  const h = host(false)
  await index.apply(h.ctx, undefined)
  // Same four tools, no panel, and crucially no throw: the plugin must boot on a
  // plain dsh Host, which is the overwhelmingly common case.
  assert.equal(h.tools.length, 4)
  assert.deepEqual(h.panels, [])
})

test('the panel data feed is secret-free over a REAL summarized row', async () => {
  // The earlier `panelData` tests feed hand-written rows. This one goes through
  // the Host's own summary path (`summarizeRows` → `connLabel` → `panelData`), so
  // a change in what the summary carries cannot slip past the zero-knowledge
  // assertion: it would land here as a leaked password/user/scheme.
  const { summarizeRows } = await import('../lib/mcp.mjs')
  const { panelData } = await import('../lib/native.mjs')
  const rows = summarizeRows([{
    wsPath: 'D:/ws/native',
    title: 'native',
    env: 'prod',
    dsn: 'mysql://dbuser:CHANGE_ME@198.51.100.7:3306/appdb',
    source: 'user',
    persisted: true,
  }])
  assert.equal(rows.length, 1, 'the fixture row must summarize (a vacuous test proves nothing)')
  // The summary itself already carries only a label — this asserts it, then the
  // panel must not add anything back.
  assert.match(rows[0].conn, /198\.51\.100\.7:3306\/appdb/)
  const data = panelData({
    enabled: true, phase: 'running', rows, pluginVersion: '6.1.0',
    defaultMaxRows: 0, batchConcurrency: 2, updateIntervalDays: 7,
    showSidebarEntry: true, announceAccessPolicy: true, exportDir: '',
  }, 'zh')
  const json = JSON.stringify(data)
  assert.doesNotMatch(json, /CHANGE_ME/)
  assert.doesNotMatch(json, /dbuser/)
  // The label keeps the protocol (the user needs to tell MySQL from Postgres)
  // and drops the whole userinfo section: no `user@`, no `user:pass@`.
  assert.doesNotMatch(json, /@/)
  assert.match(json, /mysql:\/\/198\.51\.100\.7:3306\/appdb/)
  // The row is tappable and addressable, so the phone can actually test it.
  assert.deepEqual(data.rows[0].action, { id: 'test', args: { path: 'D:/ws/native', env: 'prod' } })
})

test('apply() publishes the same four tools and no panel on a plain Host', async () => {
  // The panel is an ADDITION on every Host: the tool surface must be identical
  // with and without the bridge, so a dsh-Go upgrade can never change what the
  // model can call.
  const plain = host(false)
  await index.apply(plain.ctx, undefined)
  const bridged = host(true)
  await index.apply(bridged.ctx, undefined)
  assert.deepEqual([...plain.tools].sort(), [...bridged.tools].sort())
  assert.deepEqual(plain.panels, [])
  assert.equal(bridged.panels.length, 1)
})

test('the Host probe answers a result for a request it cannot serve', async () => {
  // Two Host-side paths that must produce an ANSWER rather than a rejection:
  // a request the app already cancelled, and a connection this Host does not have.
  // A rejected deferred result leaves a bare failure on the phone with nothing to
  // read, so both come back as `{ ok:false }` and turn into the same verdict toast.
  const h = host(true)
  await index.apply(h.ctx, undefined)
  const actions = h.panels[0].def.actions
  for (const signal of [undefined, AbortSignal.abort()]) {
    const effects = await actions
      .test({}, { locale: 'en-US', value: { path: 'D:/ws/none', env: 'prod' } })
      .result(signal)
    assert.match(effects.toast, /Connection failed/)
  }
})

test('a tapped setting really lands in the Host options and persists', async () => {
  // The point of routing the panel through the Host's own writer is that the
  // phone changes the SAME value the web card shows — and that it persists, so a
  // restart keeps it. A second write path would pass the first assertion and
  // fail the second.
  const h = host(true)
  await index.apply(h.ctx, undefined)
  const actions = h.panels[0].def.actions
  const before = optionsMod.get('defaultMaxRows')
  const target = String(before) === '500' ? '1000' : '500'

  const effects = actions['set.defaultMaxRows']({}, { locale: 'en-US', value: { value: target } })
  assert.match(effects.toast, /Saved/)
  assert.equal(optionsMod.get('defaultMaxRows'), Number(target))
  // The action re-sends the selection so the app lights the new choice.
  assert.equal(effects.patch.sel.defaultMaxRows, target)
  // Persisted through `applyPatch(..., {persist:true})`: the prefs file the web
  // card reads on the next boot holds it.
  const { loadPrefs } = await import('../lib/config.mjs')
  assert.equal(loadPrefs().defaultMaxRows, Number(target))

  // A value the panel never offered is refused before the write path, and the
  // Host keeps what it had.
  const bad = actions['set.defaultMaxRows']({}, { locale: 'en-US', value: { value: '250' } })
  assert.match(bad.toast, /did not apply/)
  assert.equal(optionsMod.get('defaultMaxRows'), Number(target))
  assert.equal(bad.patch.sel.defaultMaxRows, target, 'the app is told the truth: nothing changed')

  // Clean up for any later test in this file (one process, one prefs file).
  optionsMod.applyPatch({ defaultMaxRows: before }, { persist: true })
})

test('the phone cannot reach the one setting whose write needs a probe', async () => {
  // `exportDir` is free text whose save PROVES the directory writable. The panel
  // offers no control for it and no action named after it, so there is no way to
  // write it from the phone — by construction, not by a runtime check.
  const h = host(true)
  await index.apply(h.ctx, undefined)
  const actions = h.panels[0].def.actions
  assert.equal(actions['set.exportDir'], undefined)
  // ...and it is still visible as a read-only line, with its default spelled out.
  const emitted = []
  h.panels[0].def.data({}, (d) => emitted.push(d), { locale: 'en-US' })()
  const map = Object.fromEntries(emitted[0].settingRows)
  assert.equal(map['Export directory'], 'Default location')
})

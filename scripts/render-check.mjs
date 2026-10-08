// Offline render/interaction gate for dsh-dbhub-live's client bundle.
//
// React is not a dependency of this repository, so this script provides a
// minimal element factory + hook shim that runs the hand-authored bundle's page
// component for real: it walks the returned element tree and dispatches the
// onClick handlers a user would click. It covers the layout contract that the
// regex-level `test/client-format.test.mjs` cannot — which mode (tiles vs
// grouped) a data shape selects, default expansion, expand/collapse-all,
// add-panel behaviour, the copy button, and that no raw i18n key or unfilled
// placeholder reaches the page in either language.
//
// Run: npm run check:ui   (Node >= 18, no dependencies)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

// ── minimal react ──────────────────────────────────────────────────────────

const react = (() => {
  const instances = []
  let cursor = 0
  let current = null
  let dirty = false
  let pendingEffects = []

  function createElement(type, props, ...children) {
    const next = Object.assign({}, props || {})
    if (children.length === 1) next.children = children[0]
    else if (children.length > 1) next.children = children
    return { type, props: next }
  }

  const slot = () => {
    if (!current) throw new Error('hook used outside a component render')
    return current
  }

  function useState(init) {
    const s = slot()
    const i = cursor++
    if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init
    const set = (value) => {
      s.hooks[i] = typeof value === 'function' ? value(s.hooks[i]) : value
      dirty = true
    }
    return [s.hooks[i], set]
  }

  function useRef(init) {
    const s = slot()
    const i = cursor++
    if (!(i in s.hooks)) s.hooks[i] = { current: init }
    return s.hooks[i]
  }

  function useEffect(fn, deps) {
    const s = slot()
    const i = cursor++
    const prev = s.hooks[i]
    const changed = !prev || !deps || deps.some((d, k) => d !== prev.deps[k])
    s.hooks[i] = { deps: deps || [], cleanup: prev ? prev.cleanup : undefined, run: changed ? fn : null }
    if (changed) pendingEffects.push(s.hooks[i])
  }

  function walk(el, path) {
    if (el === null || el === undefined || el === false || el === true) return null
    if (typeof el === 'string' || typeof el === 'number') return { kind: 'text', text: String(el) }
    if (Array.isArray(el)) {
      return { kind: 'frag', children: el.map((c, i) => walk(c, `${path}.${i}`)).filter(Boolean) }
    }
    if (typeof el.type === 'function') {
      const idx = cursor++
      const s = instances[idx] || (instances[idx] = { hooks: [] })
      const savedCurrent = current
      const savedCursor = cursor
      current = s
      cursor = 0
      const out = el.type(el.props)
      current = savedCurrent
      cursor = savedCursor
      return walk(out, path)
    }
    const kids = el.props && el.props.children
    const list = kids === undefined ? [] : Array.isArray(kids) ? kids : [kids]
    return {
      kind: 'el',
      type: el.type,
      props: el.props || {},
      children: list.map((c, i) => walk(c, `${path}.${i}`)).filter(Boolean),
    }
  }

  /** Drop all hook state: call before mounting a NEW root component. */
  function reset() {
    instances.length = 0
    pendingEffects = []
    dirty = false
  }

  /** Run every stored effect cleanup — what a real unmount does. */
  function unmount() {
    for (const s of instances) {
      for (const hook of s.hooks) {
        if (hook && typeof hook.cleanup === 'function') {
          try { hook.cleanup() } catch (e) { /* cleanup must not break the gate */ }
          hook.cleanup = undefined
        }
      }
    }
  }

  /** Render `type` (and re-render until no state setter fired). */
  function render(type, props) {
    let tree
    do {
      dirty = false
      cursor = 0
      const s = instances[0] || (instances[0] = { hooks: [] })
      const savedCurrent = current
      current = s
      cursor = 1
      const out = type(props)
      current = savedCurrent
      tree = walk(out, '')
      const runnable = pendingEffects.filter((e) => e.run)
      pendingEffects = []
      for (const e of runnable) {
        const cleanup = e.run()
        if (typeof cleanup === 'function') e.cleanup = cleanup
      }
    } while (dirty)
    return tree
  }

  return { createElement, useState, useRef, useEffect, render, reset, unmount }
})()

// ── load the bundle through its ModuleLoader contract ──────────────────────

const primitivesStub = (() => {
  const icon = (cls) => (props) => react.createElement('svg', Object.assign({ className: cls }, props))
  return {
    IconChevronDownOutline14: icon('ico-chev'),
    IconCopyOutline16: icon('ico-copy'),
    IconEditOutline16: icon('ico-edit'),
    IconCloseOutline16: icon('ico-close'),
    IconTrashOutline16: icon('ico-trash'),
    IconPlayOutline16: icon('ico-run'),
    writeClipboard: () => Promise.resolve(true),
  }
})()

let definition = null
const windowShim = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}
new Function('window', readFileSync(CLIENT, 'utf8'))(windowShim)
if (!definition || definition.id !== 'dsh-dbhub-live') throw new Error('bundle did not register through the ModuleLoader contract')

const req = (name) => {
  if (name === 'react') return react
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require: ${name}`)
}
const bundle = definition.factory(req)

// ── fake host (settings namespace + slots + locale) ────────────────────────
//
// The locale registry is a PAGE-level singleton in the real client (one
// namespace + locale can only be registered once until its owner disposes it),
// so it is modelled outside the mount: that is what makes a hot reload visible
// here as a duplicate-registration failure.
const LOCALE_STORE = new Map()
let liveMount = null

function mount(snapshot, opts = {}) {
  const lang = opts.lang || 'zh'
  const registrations = {}
  const setCalls = []
  const opCalls = []
  const getCalls = []
  const formSets = []
  const effects = []
  const disposeHandlers = []
  const restores = []
  // The legacy transport is a service the bundle PROBES (`ctx.get`), never one it
  // injects, so the harness offers it the same way a dsh <= 0.1.6 client does.
  const settingsScope = {
    bind: () => ({
      getSnapshot: () => ({ value: snapshot }),
      subscribe: () => () => {},
      set: (key, value) => {
        if (key === 'configOp') opCalls.push(JSON.parse(String(value)))
        else setCalls.push([key, value])
        return Promise.resolve()
      },
    }),
  }
  // dsh 0.1.7+/0.2.x settings forms: `configForms.get(entryId).set(field, value)`.
  const configForms = {
    get: (entryId) => ({
      set: (field, value) => {
        formSets.push([entryId, field, value])
        return Promise.resolve(true)
      },
    }),
  }
  const ctx = {
    get(name) {
      if (name === 'settingsScope') return opts.transport === 'http' ? undefined : settingsScope
      if (name === 'configForms') return opts.configForms ? configForms : undefined
      if (name !== 'locale') return undefined
      return {
        getLocale: () => ({ active: lang }),
        register(ns, entries) {
          let owned = LOCALE_STORE.get(ns)
          if (!owned) {
            owned = new Map()
            LOCALE_STORE.set(ns, owned)
          }
          for (const locale of Object.keys(entries)) {
            if (owned.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
          }
          for (const [locale, dict] of Object.entries(entries)) owned.set(locale, dict)
          return () => {
            for (const [locale, dict] of Object.entries(entries)) if (owned.get(locale) === dict) owned.delete(locale)
          }
        },
        bind(ns) {
          return (key, params) => {
            const owned = LOCALE_STORE.get(ns) || new Map()
            const dict = owned.get(lang) || owned.get('zh') || {}
            let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : `!!${key}!!`
            if (params) for (const k of Object.keys(params)) text = text.split(`{${k}}`).join(String(params[k]))
            return text
          }
        },
      }
    },
    effect(fn) {
      effects.push(fn)
      return () => {
        const i = effects.indexOf(fn)
        if (i >= 0) effects.splice(i, 1)
      }
    },
    on(event, fn) {
      if (event === 'dispose') disposeHandlers.push(fn)
      return () => {}
    },
    slots: {
      inject(name, cb) {
        const out = cb()
        if (!(name in registrations)) registrations[name] = out
        return () => {}
      },
      register(def, comp) {
        registrations[def.name] = { def, comp }
        // A real slot registry REMOVES the entry when its disposer runs — the
        // sidebar entry's whole point is that it disappears. Model that, or the
        // "disable hides the entry" check could never fail.
        return () => {
          const current = registrations[def.name]
          if (current && current.comp === comp) delete registrations[def.name]
        }
      },
    },
  }
  if (opts.transport === 'http') {
    // The bundle reads the page-global `fetch`; the fake answers every bridge
    // route with the same view the legacy snapshot carries — but the view is
    // MUTABLE, because an `enabled` write must be observable on the next read
    // (that is exactly what re-syncs the sidebar entry).
    const previousFetch = globalThis.fetch
    const liveView = Object.assign({}, snapshot)
    globalThis.fetch = async (input, init) => {
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      if (body && body.op !== undefined) opCalls.push(body.op)
      else if (body && typeof body.enabled === 'boolean') {
        setCalls.push(['enabled', body.enabled])
        liveView.enabled = body.enabled
      } else if (body) setCalls.push(['options', body])
      else getCalls.push(String(input))
      return { ok: true, status: 200, json: async () => ({ ok: true, value: liveView }) }
    }
    restores.push(() => { globalThis.fetch = previousFetch })
  }
  bundle.apply(ctx)
  return {
    registrations, setCalls, opCalls, getCalls, formSets,
    /** What the plugin scope disposal (a hot reload) does. */
    dispose() {
      // Component effect cleanups first: the HTTP face stops polling in its
      // subscription cleanup, and a leaked interval would hang this gate.
      react.unmount()
      const list = effects.slice().reverse()
      effects.length = 0
      for (const fn of list) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanup()
      }
      const handlers = disposeHandlers.slice()
      disposeHandlers.length = 0
      for (const fn of handlers) fn()
      for (const fn of restores.splice(0)) fn()
    },
  }
}

// ── tree helpers ──────────────────────────────────────────────────────────

function toHtml(node) {
  if (!node) return ''
  if (node.kind === 'text') return node.text
  if (node.kind === 'frag') return node.children.map(toHtml).join('')
  const cls = node.props.className ? ` class="${node.props.className}"` : ''
  const aria = node.props['aria-expanded'] === undefined ? '' : ` aria-expanded="${node.props['aria-expanded']}"`
  const inner = node.children.map(toHtml).join('')
  const tag = node.type === 'input' ? 'input' : node.type === 'svg' ? 'svg' : node.type === 'button' ? 'button' : 'div'
  return `<${tag}${cls}${aria}>${inner}</${tag}>`
}

function count(node, cls) {
  if (!node || node.kind === 'text') return 0
  let n = node.kind === 'el' && String(node.props.className || '').split(/\s+/).includes(cls) ? 1 : 0
  for (const c of node.children || []) n += count(c, cls)
  return n
}

function elements(node, pred, out = []) {
  if (!node || node.kind === 'text') return out
  if (node.kind === 'el' && pred(node)) out.push(node)
  for (const c of node.children || []) elements(c, pred, out)
  return out
}

const classed = (node, cls) => elements(node, (el) => String(el.props.className || '').split(/\s+/).includes(cls))

/** Click the button whose aria-label is exactly `label` (icons carry no text). */
function clickLabel(node, label) {
  clickLabelAt(node, label, 0)
}

/** Click the nth button whose aria-label is exactly `label`. */
function clickLabelAt(node, label, index) {
  const hits = elements(node, (el) => el.props['aria-label'] === label && typeof el.props.onClick === 'function')
  const hit = hits[index]
  if (!hit) throw new Error(`no clickable element labelled ${JSON.stringify(label)} at index ${index} (found ${hits.length})`)
  hit.props.onClick({ stopPropagation() {}, preventDefault() {} })
}

function clickWithin(node, cls, text) {
  for (const scope of classed(node, cls)) {
    const hit = elements(scope, (el) => typeof el.props.onClick === 'function'
      && (el.children || []).map(toHtml).join('').includes(text))[0]
    if (hit) {
      hit.props.onClick({ stopPropagation() {}, preventDefault() {} })
      return
    }
  }
  throw new Error(`no clickable ${JSON.stringify(text)} inside .${cls}`)
}

/** Type into the nth `.dbh-input` inside `.cls` of the tree, as a browser would. */
function typeWithin(node, cls, index, value) {
  const scope = classed(node, cls)[0]
  if (!scope) throw new Error(`no .${cls} in the tree`)
  const input = classed(scope, 'dbh-input')[index]
  if (!input || typeof input.props.onChange !== 'function') throw new Error(`no input ${index} inside .${cls}`)
  input.props.onChange({ target: { value } })
}

function click(node, text) {
  const hit = elements(node, (el) => {
    const inner = (el.children || []).map(toHtml).join('')
    return typeof el.props.onClick === 'function' && inner.includes(text)
  })[0]
  if (!hit) throw new Error(`no clickable element containing ${JSON.stringify(text)}`)
  hit.props.onClick({ stopPropagation() {}, preventDefault() {} })
}

function clickClass(node, cls) {
  const hit = classed(node, cls)[0]
  if (!hit || typeof hit.props.onClick !== 'function') throw new Error(`no clickable element with class ${cls}`)
  hit.props.onClick({ stopPropagation() {}, preventDefault() {} })
}

/** The nth checkbox/radio (class `dbh-checkbox`) inside the first `.cls` scope. */
function checkBoxWithin(node, cls, index, checked) {
  const scope = classed(node, cls)[0]
  if (!scope) throw new Error(`no .${cls} in the tree`)
  const boxes = elements(scope, (el) => el.type === 'input'
    && String(el.props.className || '').split(/\s+/).includes('dbh-checkbox')
    && typeof el.props.onChange === 'function')
  const box = boxes[index]
  if (!box) throw new Error(`no checkbox ${index} inside .${cls} (found ${boxes.length})`)
  box.props.onChange({ target: { checked } })
  return box
}

// ── scenario data ─────────────────────────────────────────────────────────

const row = (title, path, env, conn, extra = {}) => Object.assign({
  title, path, env, conn, source: 'persisted(user)', persisted: true,
  srcId: `${title}_1a2b3c${env === 'default' ? '' : '_' + env}`,
}, extra)

const snapshotOf = (rows, extra = {}) => Object.assign({
  enabled: true, phase: 'running', toolCount: 4, lastError: '', mode: 'oneshot',
  updateIntervalDays: 7, testResult: '',
  // Upstream capability probe (JSON string). '' = "not probed yet", which the
  // page treats as "assume supported".
  capabilities: '',
  workspaces: JSON.stringify(rows),
}, extra)

const TILED = [
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app'),
  // a long handle, so the shortened form is exercised
  row('dsh-plugin', 'D:/work/plugin', 'default', 'postgres://127.0.0.1:5432/plug'),
  row('docs', 'D:/work/docs', 'default', 'sqlite://127.0.0.1:0/docs', { source: '工作目录 .env', persisted: false }),
]
const GROUPED = [
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app'),
  row('app', 'D:/work/app', 'prod', 'mysql://127.0.0.1:3307/app'),
  row('app', 'D:/work/app', '线上', 'mysql://127.0.0.1:3308/app', { persisted: false, source: '工作区 mise env' }),
  row('plugin', 'D:/work/plugin', 'default', 'postgres://127.0.0.1:5432/plug'),
]
const SINGLE_MULTI = [
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app'),
  row('app', 'D:/work/app', 'prod', 'mysql://127.0.0.1:3307/app'),
]
const DUP_TITLES = [
  row('app', 'D:/work/one/app', 'default', 'mysql://127.0.0.1:3306/a'),
  row('app', 'D:/work/two/app', 'default', 'mysql://127.0.0.1:3306/b'),
]
const wsSnap = (path, updatedAt = '2026-01-01T00:00:00Z') => (sel) => sel({ items: [{ path, updatedAt }] })

// ── assertion helpers ─────────────────────────────────────────────────────

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Mount the settings-section page component with the REAL injected face. */
function page(rows, opts = {}) {
  // A hot reload disposes the previous instance before applying the new bundle;
  // `keepStale` models the pathological case where it could not.
  if (liveMount && !opts.keepStale) liveMount.dispose()
  const snapshot = snapshotOf(rows, opts.snapshot)
  const m = mount(snapshot, opts)
  liveMount = m
  const entry = m.registrations['settings.section']
  if (!entry) throw new Error('settings.section was not registered')
  const props = Object.assign({}, entry.def.inject(), opts.props, { view: 'page' })
  const comp = entry.comp
  const renderAgain = () => react.render(comp, props)
  react.reset()
  return Object.assign(m, { props, comp, renderAgain, tree: react.render(comp, props) })
}

console.log('\n[1] tiled layout (every workspace has exactly one environment)')
{
  const p = page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  const html = toHtml(p.tree)
  check('tile grid rendered', count(p.tree, 'dbh-tiles') === 1)
  check('one tile per workspace', count(p.tree, 'dbh-tile') === 3, `got ${count(p.tree, 'dbh-tile')}`)
  check('no accordion groups', count(p.tree, 'dbh-group') === 0)
  check('no expand-all control', !html.includes('全部展开') && !html.includes('全部折叠'))
  check('one env chip per tile', count(p.tree, 'dbh-envname') === 3, `got ${count(p.tree, 'dbh-envname')}`)
  check('connection metadata shown once per tile', count(p.tree, 'dbh-conn') === 3)
  check('no inline source handle line', !html.includes('source:') && !html.includes('dsh-plugin_1a2b3c'))
  check('one source chip per connection', classed(p.tree, 'dbh-src').length === 3, `got ${classed(p.tree, 'dbh-src').length}`)
  // auto-discovered rows have no delete action, so 3 + 3 + 2 icon buttons
  check('actions are icon-only', classed(p.tree, 'dbh-iconbtn').length === 8, `got ${classed(p.tree, 'dbh-iconbtn').length}`)
  const handles = classed(p.tree, 'dbh-srcid').map((el) => toHtml(el))
  check('short handles are shown whole', handles.some((h) => h.includes('app_1a2b3c')) && handles.some((h) => h.includes('docs_1a2b3c')), JSON.stringify(handles))
  check('long handles keep their distinguishing tail', handles.some((h) => h.includes('…1a2b3c')), JSON.stringify(handles))
  check('database name rendered separately', classed(p.tree, 'dbh-conn-db').length === 3)
  check('host/port prefix is the truncatable half', classed(p.tree, 'dbh-conn-pre').length === 3)
}

console.log('\n[2] grouped layout (one workspace owns several environments)')
{
  const p = page(GROUPED, { props: { useWorkspaces: wsSnap('D:/work/app', '2026-01-02T00:00:00Z') } })
  if (process.env.DBHUB_DEBUG) console.log(toHtml(p.tree).slice(0, 3000))
  const heads = classed(p.tree, 'dbh-grouphead')
  const html = toHtml(p.tree)
  check('group per workspace', count(p.tree, 'dbh-group') === 2, `got ${count(p.tree, 'dbh-group')}`)
  check('recently used workspace auto-opens', heads[0].props['aria-expanded'] === true)
  check('the other workspace stays folded', heads[1].props['aria-expanded'] === false)
  check('folded group hides its rows', count(p.tree, 'dbh-envrow') === 3, `got ${count(p.tree, 'dbh-envrow')}`)
  check('expand-all control present', html.includes('全部展开'))
  check('per-group add button present', html.includes('＋ 环境'))
  check('group head shows env/saved counts', html.includes('3 环境 · 2 已保存'))
  check('emoji/status line present', html.includes('🟢 运行中'))
}

console.log('\n[3] a lone workspace opens by itself (no workspace snapshot available)')
{
  const p = page(SINGLE_MULTI, {})
  const heads = classed(p.tree, 'dbh-grouphead')
  check('single group', count(p.tree, 'dbh-group') === 1)
  check('open by default', heads[0].props['aria-expanded'] === true)
  check('its rows are visible', count(p.tree, 'dbh-envrow') === 2)
}

console.log('\n[4] empty state')
{
  const p = page([], {})
  const html = toHtml(p.tree)
  check('empty hint rendered', count(p.tree, 'dbh-empty') === 1)
  check('add entry still offered', html.includes('＋ 添加连接'))
  check('no tiles / groups', count(p.tree, 'dbh-tile') === 0 && count(p.tree, 'dbh-group') === 0)
}

console.log('\n[5] duplicate workspace titles are disambiguated by path')
{
  const p = page(DUP_TITLES, {})
  const html = toHtml(p.tree)
  check('both paths shown', html.includes('D:/work/one/app') && html.includes('D:/work/two/app'))
}

console.log('\n[6] malformed workspace snapshot cannot break the page')
{
  const p = page(GROUPED, { props: { useWorkspaces: () => null } })
  check('falls back to all-folded', classed(p.tree, 'dbh-grouphead').every((el) => el.props['aria-expanded'] === false))
}

console.log('\n[7] interaction: expand/collapse all + group toggle')
{
  const p = page(GROUPED, {})
  check('starts folded without a snapshot', count(p.tree, 'dbh-envrow') === 0)
  click(p.tree, '全部展开')
  p.tree = p.renderAgain()
  check('expand-all opens every group', count(p.tree, 'dbh-envrow') === 4, `got ${count(p.tree, 'dbh-envrow')}`)
  click(p.tree, '全部折叠')
  p.tree = p.renderAgain()
  check('collapse-all folds every group', count(p.tree, 'dbh-envrow') === 0)
  click(p.tree, 'app')
  p.tree = p.renderAgain()
  check('clicking a group head opens it', count(p.tree, 'dbh-envrow') === 3, `got ${count(p.tree, 'dbh-envrow')}`)
  const heads = classed(p.tree, 'dbh-grouphead')
  check('aria-expanded tracks the group', heads[0].props['aria-expanded'] === true && heads[1].props['aria-expanded'] === false)
  click(p.tree, 'app')
  p.tree = p.renderAgain()
  check('clicking it again folds it', count(p.tree, 'dbh-envrow') === 0)
}

console.log('\n[8] interaction: add panel (global + per group), settings strip, copy')
{
  const p = page(GROUPED, {})
  check('add panel hidden by default', count(p.tree, 'dbh-addpanel') === 0)
  check('settings strip hidden by default', count(p.tree, 'dbh-strip') === 0)
  check('collapsed summary line shown', toHtml(p.tree).includes('自动更新 7 天'))
  click(p.tree, '＋ 添加连接')
  p.tree = p.renderAgain()
  check('global add panel opens with 3 fields', count(p.tree, 'dbh-addpanel') === 1 && classed(p.tree, 'dbh-field').length === 3)
  const fields = classed(p.tree, 'dbh-field')
  check('fields are workspace / env / DSN', toHtml(fields[0]).includes('工作区') && toHtml(fields[2]).includes('DSN'))
  const datalists = elements(p.tree, (el) => el.type === 'datalist')
  check('workspace datalist fed from existing groups', datalists.length === 1 && elements(datalists[0], (el) => el.type === 'option').length === 2)
  click(p.tree, '取消')
  p.tree = p.renderAgain()
  check('cancel closes the add panel', count(p.tree, 'dbh-addpanel') === 0)
  click(p.tree, '＋ 环境')
  p.tree = p.renderAgain()
  const target = classed(p.tree, 'dbh-target')[0]
  check('per-group add pre-fills the workspace', !!target && toHtml(target).includes('D:/work/app'))
  check('per-group add drops the workspace input', classed(p.tree, 'dbh-field').length === 3 && classed(p.tree, 'dbh-target').length === 1)
  click(p.tree, '取消')
  p.tree = p.renderAgain()
  click(p.tree, 'app')
  p.tree = p.renderAgain()
  check('group expanded for the copy check', count(p.tree, 'dbh-envrow') === 3)
  clickClass(p.tree, 'dbh-src')
  // writeClipboard resolves a promise, so the copied flag lands a microtask later
  await new Promise((r) => setTimeout(r, 0))
  p.tree = p.renderAgain()
  check('copy chip works without navigator.clipboard', classed(p.tree, 'dbh-src').length === 3)
  check('copy feedback shown', toHtml(p.tree).includes('已复制'))
  click(p.tree, '设置')
  p.tree = p.renderAgain()
  check('settings strip opens', count(p.tree, 'dbh-strip') === 1)
  // F0: the sidebar switch is GONE — the entry follows the plugin's enabled
  // state, and the strip says so instead of offering a second switch.
  check('strip no longer carries a sidebar switch', !toHtml(p.tree).includes('在侧边栏显示入口'))
  check('strip keeps the interval field', classed(p.tree, 'dbh-num').length === 1)
  check('strip explains that the entry follows the enabled state', count(p.tree, 'dbh-hint') >= 1 && toHtml(classed(p.tree, 'dbh-strip')[0]).includes('侧边栏'))
}

console.log('\n[9] summary view (Plugins page one-liner)')
{
  const p = page(TILED, {})
  const summaryReg = p.registrations['plugins.row.config']
  const summaryProps = Object.assign({}, summaryReg.def.inject(), { view: 'summary' })
  const tree = react.render(summaryReg.comp, summaryProps)
  const html = toHtml(tree)
  check('single line', count(tree, 'dbh-summary') === 1 && count(tree, 'dbh-tile') === 0)
  check('carries phase, tool count and env count', html.includes('运行中') && html.includes('4 个工具') && html.includes('3 个环境'))
}

console.log('\n[10] i18n coverage (no raw key or unfilled placeholder may reach the page)')
{
  const problems = []
  for (const lang of ['zh', 'en']) {
    for (const rows of [GROUPED, TILED, []]) {
      const p = page(rows, { lang, props: { useWorkspaces: wsSnap('D:/work/app') } })
      const html = toHtml(p.tree)
      const leftovers = html.match(/!![a-zA-Z][a-zA-Z.]*!!/g) || []
      const placeholders = html.match(/\{[a-zA-Z]\}/g) || []
      if (leftovers.length) problems.push(`${lang}/${rows.length}rows missing: ${[...new Set(leftovers)].join(', ')}`)
      if (placeholders.length) problems.push(`${lang}/${rows.length}rows unfilled: ${[...new Set(placeholders)].join(', ')}`)
    }
  }
  check('every key exists in both dictionaries and every placeholder is filled', problems.length === 0, problems.join(' | '))
}

console.log('\n[11] disable/enable + option writes still go through the namespace')
{
  const p = page(TILED, {})
  click(p.tree, '禁用')
  check('setEnabled(false) dispatched', p.setCalls.some(([k, v]) => k === 'enabled' && v === false), JSON.stringify(p.setCalls))
  if (count(p.tree, 'dbh-strip') === 0) {
    click(p.tree, '设置')
    p.tree = p.renderAgain()
  }
  check('settings strip open', count(p.tree, 'dbh-strip') === 1)
  click(p.tree, '保存配置')
  // saveConfig queues one path-op write per field, so let the microtasks drain.
  await new Promise((r) => setTimeout(r, 0))
  check('saveConfig writes updateIntervalDays', p.setCalls.some(([k, v]) => k === 'updateIntervalDays' && v === 7), JSON.stringify(p.setCalls))
}

console.log('\n[12] view state survives a remount inside the same page session')
{
  const first = page(SINGLE_MULTI, {})
  click(first.tree, '全部折叠')
  first.tree = first.renderAgain()
  check('folded in the first mount', count(first.tree, 'dbh-envrow') === 0)
  const second = page(SINGLE_MULTI, {})
  check('a new mount keeps the folded choice', count(second.tree, 'dbh-envrow') === 0)
  check('and keeps the settings strip open', count(second.tree, 'dbh-strip') === 1)
}

console.log('\n[13] connection origin is a tooltip, not an inline badge')
{
  // A dedicated fixture: another workspace path cannot inherit an expansion
  // choice remembered from an earlier mount (view state is shared per session).
  const rows = [
    row('origin-app', 'D:/work/origin', 'default', 'mysql://127.0.0.1:3306/a'),
    row('origin-app', 'D:/work/origin', 'staging', 'mysql://127.0.0.1:3307/a', { persisted: false, source: '工作区 mise env' }),
  ]
  const p = page(rows, {})
  const titles = classed(p.tree, 'dbh-envname').map((c) => String(c.props.title || ''))
  check('both environment chips rendered', titles.length === 2, JSON.stringify(titles))
  check('no pill / badge element anywhere', classed(p.tree, 'dbh-pill').length === 0)
  check('hand-entered row names its origin only in the tooltip', titles.some((x) => x.includes('来源：已保存·用户')))
  check('auto-discovered row says it is not saved', titles.some((x) => x.includes('来源：自动·mise env') && x.includes('未保存')))
  const tiled = page(TILED, { props: { useWorkspaces: wsSnap('D:/work/origin') } })
  check('tiled mode uses the same tooltip', classed(tiled.tree, 'dbh-envname').some((c) => String(c.props.title || '').includes('来源：')))
  check('tiled mode has no badge either', classed(tiled.tree, 'dbh-pill').length === 0)
}

console.log('\n[14] a hot reload must not break on duplicate locale registration')
{
  // The live failure this guards: "locale namespace dsh-dbhub-live already has
  // locale zh" after a client bundle swap, which aborts the whole plugin half.
  const ns = 'dsh-dbhub-live'
  const first = page(TILED, {})
  check('apply owns the namespace dictionaries', (LOCALE_STORE.get(ns) || new Map()).size === 2)
  first.dispose()
  check('dispose releases them for the next instance', (LOCALE_STORE.get(ns) || new Map()).size === 0)
  const second = page(TILED, {})
  check('a clean reload re-registers', (LOCALE_STORE.get(ns) || new Map()).size === 2)
  check('reloaded page renders localized copy', toHtml(second.tree).includes('运行中'))
  // pathological: the previous instance never released its dictionaries
  let failure = null
  let stale = null
  try {
    stale = page(TILED, { keepStale: true })
  } catch (e) {
    failure = e
  }
  check('duplicate registration does not fail the plugin half', failure === null, failure && failure.message)
  const html = stale ? toHtml(stale.tree) : ''
  check('the page still renders its own copy (no raw keys)', html.includes('运行中') && !html.includes('ws.source'))
  check('including the newly added keys', stale !== null && classed(stale.tree, 'dbh-envname').some((c) => String(c.props.title || '').includes('来源')))
}

console.log('\n[15] writing into an existing environment asks first')
{
  // The reported flaw: an add whose environment name already exists silently
  // replaced that connection (the Host's setWorkspaceEnv always overwrites).
  // A dedicated fixture: a lone workspace group opens by itself, so the scenario
  // does not depend on expansion state remembered by earlier mounts.
  const OVERWRITE_ROWS = [
    row('ovr-app', 'D:/work/ovr', 'default', 'mysql://127.0.0.1:3306/app'),
    row('ovr-app', 'D:/work/ovr', 'prod', 'mysql://127.0.0.1:3307/app'),
  ]
  const p = page(OVERWRITE_ROWS, {})
  check('the lone workspace is open', count(p.tree, 'dbh-envrow') === 2)
  click(p.tree, '＋ 环境')
  p.tree = p.renderAgain()
  check('per-group add has no workspace field', classed(p.tree, 'dbh-target').length === 1)
  // env input is index 0 (the per-group form has no workspace input)
  typeWithin(p.tree, 'dbh-addpanel', 0, 'prod')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 1, 'mysql://127.0.0.1:3399/app')
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-addpanel', '添加连接')
  p.tree = p.renderAgain()
  check('collision shows the overwrite prompt', count(p.tree, 'dbh-warncard') === 1)
  check('the prompt names the existing connection', toHtml(p.tree).includes('127.0.0.1:3307'))
  check('nothing was dispatched before the answer', p.opCalls.length === 0, JSON.stringify(p.opCalls))
  check('the pre-test card is not shown at the same time', count(p.tree, 'dbh-pretest') === 0)
  clickWithin(p.tree, 'dbh-warncard', '取消')
  p.tree = p.renderAgain()
  check('cancel dismisses the prompt', count(p.tree, 'dbh-warncard') === 0)
  check('cancel writes nothing at all', p.opCalls.length === 0, JSON.stringify(p.opCalls))
  check('the form survives so the name can be fixed', classed(p.tree, 'dbh-addpanel').length === 1)
  // same click, but confirmed
  clickWithin(p.tree, 'dbh-addpanel', '添加连接')
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-warncard', '覆盖并保存')
  await new Promise((r) => setTimeout(r, 0))
  check('confirm enters the normal pre-test flow exactly once',
    p.opCalls.length === 1 && p.opCalls[0].op === 'test' && p.opCalls[0].env === 'prod' && p.opCalls[0].workspace === 'D:/work/ovr',
    JSON.stringify(p.opCalls))

  // a free environment name must NOT be questioned
  const free = page(OVERWRITE_ROWS, {})
  click(free.tree, '＋ 添加连接')
  free.tree = free.renderAgain()
  typeWithin(free.tree, 'dbh-addpanel', 1, 'staging')
  free.tree = free.renderAgain()
  typeWithin(free.tree, 'dbh-addpanel', 2, 'mysql://127.0.0.1:3399/app')
  free.tree = free.renderAgain()
  clickWithin(free.tree, 'dbh-addpanel', '添加连接')
  free.tree = free.renderAgain()
  check('a free environment name is not questioned', count(free.tree, 'dbh-warncard') === 0)
  await new Promise((r) => setTimeout(r, 0))
  check('and goes straight to the pre-test', free.opCalls.some((o) => o.op === 'test' && o.env === 'staging'), JSON.stringify(free.opCalls))
}

console.log('\n[16] renaming onto an existing environment asks first too')
{
  const RENAME_ROWS = [
    row('rn-app', 'D:/work/rn', 'default', 'mysql://127.0.0.1:3306/app'),
    row('rn-app', 'D:/work/rn', 'prod', 'mysql://127.0.0.1:3307/app'),
  ]
  const p = page(RENAME_ROWS, {})
  clickLabel(p.tree, '修改') // first row = rn-app/default
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-editrow', 0, 'prod') // rename default → prod (exists, no DSN change)
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-editrow', '保存')
  p.tree = p.renderAgain()
  check('rename onto an existing environment asks first', count(p.tree, 'dbh-warncard') === 1)
  check('no rename dispatched yet', p.opCalls.length === 0, JSON.stringify(p.opCalls))
  clickWithin(p.tree, 'dbh-warncard', '覆盖并保存')
  await new Promise((r) => setTimeout(r, 0))
  check('confirmed rename is dispatched once with the right names',
    p.opCalls.length === 1 && p.opCalls[0].op === 'rename' && p.opCalls[0].env === 'default' && p.opCalls[0].newEnv === 'prod',
    JSON.stringify(p.opCalls))

  // editing the connection of the SAME environment is not an overwrite question
  const q = page(RENAME_ROWS, {})
  clickLabel(q.tree, '修改')
  q.tree = q.renderAgain()
  typeWithin(q.tree, 'dbh-editrow', 1, 'mysql://127.0.0.1:3400/app')
  q.tree = q.renderAgain()
  clickWithin(q.tree, 'dbh-editrow', '保存')
  q.tree = q.renderAgain()
  check('editing the same environment is not questioned', count(q.tree, 'dbh-warncard') === 0)
  await new Promise((r) => setTimeout(r, 0))
  check('and goes straight to the pre-test', q.opCalls.some((o) => o.op === 'test' && o.env === 'default'), JSON.stringify(q.opCalls))
}

console.log('\n[17] copying a connection label yields the exact string (no separator)')
{
  // The reported flaw: the label renders as two flex items, and the browser's
  // own copy serialization inserts a space between block-level boxes, so pasting
  // "…3306/app" into the DSN field produced "…3306/ app".
  const p = page(TILED, {})
  const label = classed(p.tree, 'dbh-conn')[0]
  check('the label owns its copy behaviour', !!label && typeof label.props.onCopy === 'function')
  let written = null
  let prevented = false
  const event = {
    clipboardData: { setData: (type, value) => { written = { type, value } } },
    preventDefault: () => { prevented = true },
  }
  if (label) label.props.onCopy(event)
  check('copy is taken over', prevented === true)
  check('clipboard carries the exact metadata label', !!written && written.value === 'mysql://127.0.0.1:3306/app', JSON.stringify(written))
  check('no separator sneaks in', !!written && !/\s/.test(written.value), JSON.stringify(written))
  // grouped rows use the same label component (a fresh path: a lone workspace
  // group opens by itself, so no expansion state from earlier mounts leaks in)
  const grouped = page([
    row('cp-app', 'D:/work/cp', 'default', 'mysql://127.0.0.1:3306/app'),
    row('cp-app', 'D:/work/cp', 'prod', 'mysql://127.0.0.1:3307/app'),
  ], {})
  const gLabel = classed(grouped.tree, 'dbh-conn')[0]
  check('grouped rows are covered too', !!gLabel && typeof gLabel.props.onCopy === 'function')
  let gWritten = null
  if (gLabel) gLabel.props.onCopy({ clipboardData: { setData: (t, v) => { gWritten = v } }, preventDefault: () => {} })
  check('grouped copy is clean as well', gWritten === 'mysql://127.0.0.1:3306/app', JSON.stringify(gWritten))
  // a copy that cannot be claimed must not throw
  let threw = null
  try {
    if (label) label.props.onCopy({})
  } catch (e) { threw = e }
  check('a copy event without clipboardData is tolerated', threw === null, threw && threw.message)
}

console.log('\n[18] HTTP bridge transport (the dsh 0.2.x path)')
{
  // No settingsScope on this line: the face must fall back to the plugin's own
  // authenticated /api/dsh-dbhub-live bridge and render the same page.
  const p = page(TILED, { transport: 'http', props: { useWorkspaces: wsSnap('D:/work/app') } })
  await new Promise((r) => setTimeout(r, 0))
  p.tree = p.renderAgain()
  const html = toHtml(p.tree)
  check('the state route was read over the bridge', p.getCalls.some((u) => u.includes('dsh-dbhub-live/state')), JSON.stringify(p.getCalls))
  check('rows arrive over fetch', count(p.tree, 'dbh-tile') === 3, `got ${count(p.tree, 'dbh-tile')}`)
  check('connection metadata is rendered', html.includes('mysql://127.0.0.1:3306/') || count(p.tree, 'dbh-conn') === 3)
  check('the empty pre-fetch paint does not survive', html.includes('docs') || count(p.tree, 'dbh-envname') === 3)
  await p.props.setEnabled(false)
  check('the toggle POSTs to the bridge', p.setCalls.some(([k, v]) => k === 'enabled' && v === false), JSON.stringify(p.setCalls))
  await p.props.saveConfig({ updateIntervalDays: 3 })
  check('option writes POST to the bridge', p.setCalls.some(([k, v]) => k === 'options' && v.updateIntervalDays === 3), JSON.stringify(p.setCalls))
  await p.props.configOp({ op: 'remove', workspace: 'D:/work/app', env: 'default' })
  check('connection commands POST to the bridge', p.opCalls.some((o) => o.op === 'remove'), JSON.stringify(p.opCalls))
  // A second mount must be able to take over: the poll interval belongs to the
  // subscription and goes away with it (a leak would hang this gate).
  p.dispose()

  // With the settings client present, the same page writes its options through
  // the plugin's own settings form (`ctx.configForms.get(entryId).set(...)`) —
  // the sanctioned dsh 0.1.7+/0.2.x path — and keeps the bridge route unused.
  const q = page(TILED, {
    transport: 'http',
    configForms: true,
    snapshot: { entryId: 'dbhub-live' },
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  await new Promise((r) => setTimeout(r, 0))
  q.tree = q.renderAgain()
  check('the Host view carries the settings entry id', q.getCalls.length > 0)
  await q.props.saveConfig({ updateIntervalDays: 4 })
  check('option writes go through the settings form',
    q.formSets.some(([id, field, value]) => id === 'dbhub-live' && field === 'updateIntervalDays' && value === 4),
    JSON.stringify(q.formSets))
  check('the bridge route stays unused for that write', !q.setCalls.some(([k]) => k === 'options'), JSON.stringify(q.setCalls))
  // An unresolved entry id must not lose the write: it falls back to the bridge.
  const r = page(TILED, { transport: 'http', configForms: true, props: { useWorkspaces: wsSnap('D:/work/app') } })
  await new Promise((res) => setTimeout(res, 0))
  r.tree = r.renderAgain()
  await r.props.saveConfig({ updateIntervalDays: 6 })
  check('an unresolved entry id falls back to the bridge',
    r.setCalls.some(([k, v]) => k === 'options' && v.updateIntervalDays === 6) && r.formSets.length === 0,
    JSON.stringify({ sets: r.setCalls, forms: r.formSets }))
  q.dispose()
  r.dispose()
}

console.log('\n[19] disabling the plugin hides the sidebar entry (the settings page stays)')
{
  // F0: entry visible ⇔ plugin enabled. The settings section and the Plugins row
  // are NOT part of that equation — otherwise disabling would lock the user out
  // of the very switch that re-enables it.
  const p = page(TILED, { transport: 'http', props: { useWorkspaces: wsSnap('D:/work/app') } })
  await new Promise((r) => setTimeout(r, 0))
  p.tree = p.renderAgain()
  check('sidebar entry registered while enabled', !!p.registrations['sidebar.panellist'])
  check('settings section registered while enabled', !!p.registrations['settings.section'])
  await p.props.setEnabled(false)
  p.tree = p.renderAgain()
  check('disabling disposes the sidebar entry', !p.registrations['sidebar.panellist'])
  check('the settings page survives the disable', !!p.registrations['settings.section'])
  check('the Plugins row survives the disable', !!p.registrations['plugins.row.config'])
  check('the page still offers the enable button', toHtml(p.tree).includes('启用'))
  await p.props.setEnabled(true)
  p.tree = p.renderAgain()
  check('re-enabling brings the entry back', !!p.registrations['sidebar.panellist'])
  // The disabled hint is what tells the user where the entry went. The strip's
  // open state is page-session state shared with earlier groups, so only open it
  // when it is actually closed.
  await p.props.setEnabled(false)
  p.tree = p.renderAgain()
  if (count(p.tree, 'dbh-strip') === 0) {
    click(p.tree, '设置')
    p.tree = p.renderAgain()
  }
  check('the settings strip explains the hidden entry', toHtml(p.tree).includes('侧边栏入口已隐藏'), toHtml(p.tree).slice(0, 400))
  p.dispose()
}

console.log('\n[20] read-only switch → op payload → inline row marker')
{
  const rows = [
    row('ro-app', 'D:/work/ro', 'default', 'mysql://127.0.0.1:3306/app'),
    row('ro-app', 'D:/work/ro', 'prod', 'mysql://127.0.0.1:3307/app', { ro: true }),
  ]
  const p = page(rows, {})
  check('the lone workspace is open', count(p.tree, 'dbh-envrow') === 2)
  check('only the read-only row carries the marker', count(p.tree, 'dbh-ro') === 1, `got ${count(p.tree, 'dbh-ro')}`)
  const chips = classed(p.tree, 'dbh-envname')
  check('the marker sits inside the environment chip', toHtml(chips[1]).includes('只读'))
  check('the chip tooltip explains read-only', String(chips[1].props.title || '').includes('只读模式'))
  check('the writable row has no marker', !toHtml(chips[0]).includes('只读'))
  // the add form carries the switch, and it rides the pre-test payload
  click(p.tree, '＋ 添加连接')
  p.tree = p.renderAgain()
  check('add panel offers the read-only switch', toHtml(p.tree).includes('只读模式'))
  check('the add panel still has exactly 3 fields (no new .dbh-field)', classed(p.tree, 'dbh-field').length === 3)
  const addInputs = classed(classed(p.tree, 'dbh-addpanel')[0], 'dbh-input')
  check('the read-only box is not a .dbh-input', addInputs.length === 3, `got ${addInputs.length}`)
  checkBoxWithin(p.tree, 'dbh-addpanel', 0, true)
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 1, 'staging')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 2, 'mysql://127.0.0.1:3401/app')
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-addpanel', '添加连接')
  p.tree = p.renderAgain()
  check('the pre-test payload carries readOnly: true',
    p.opCalls.some((o) => o.op === 'test' && o.readOnly === true && o.env === 'staging'),
    JSON.stringify(p.opCalls))
  // Turning it back OFF on the read-only row goes through the options op (no DSN
  // needed). The prod row is the second one in the group.
  const q = page(rows, {})
  clickLabelAt(q.tree, '修改', 1)
  q.tree = q.renderAgain()
  check('the editor pre-loads the row read-only state',
    elements(q.tree, (el) => el.type === 'input' && el.props.checked === true && String(el.props.className || '').includes('dbh-checkbox')).length >= 1)
  checkBoxWithin(q.tree, 'dbh-editrow', 0, false)
  q.tree = q.renderAgain()
  clickWithin(q.tree, 'dbh-editrow', '保存')
  q.tree = q.renderAgain()
  check('flipping read-only off sends an options op (no DSN)',
    q.opCalls.some((o) => o.op === 'options' && o.env === 'prod' && o.readOnly === false && o.newEnv === undefined),
    JSON.stringify(q.opCalls))
}

console.log('\n[21] advanced SSH tunnel: expand → fill → payload, secrets never rendered')
{
  const p = page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  click(p.tree, '＋ 添加连接')
  p.tree = p.renderAgain()
  check('advanced section is folded', count(p.tree, 'dbh-advbody') === 0)
  clickWithin(p.tree, 'dbh-addpanel', '高级：SSH 隧道')
  p.tree = p.renderAgain()
  check('advanced section expands', count(p.tree, 'dbh-advbody') === 1)
  check('fields stay hidden until the tunnel is enabled', classed(p.tree, 'dbh-advrow').length === 0,
    `got ${classed(p.tree, 'dbh-advrow').length}`)
  // checkbox 0 = read-only, checkbox 1 = "connect through a tunnel"
  checkBoxWithin(p.tree, 'dbh-addpanel', 1, true)
  p.tree = p.renderAgain()
  const rows = classed(p.tree, 'dbh-advrow')
  check('host/port/user/auth/key/passphrase/proxy fields appear', rows.length >= 7, `got ${rows.length}`)
  check('the host hint warns about aliases and the slow handshake',
    toHtml(classed(p.tree, 'dbh-advbody')[0]).includes('域名或 IP'))
  typeWithin(p.tree, 'dbh-advbody', 0, 'bastion.example.com')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-advbody', 1, '2222')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-advbody', 2, 'ops')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-advbody', 3, '~/.ssh/id_ed25519')
  p.tree = p.renderAgain()
  // A free environment name: writing over an existing one would raise the
  // overwrite gate before the pre-test runs.
  typeWithin(p.tree, 'dbh-addpanel', 1, 'sshbox')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 2, 'mysql://127.0.0.1:3402/app')
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-addpanel', '添加连接')
  p.tree = p.renderAgain()
  const sent = p.opCalls.find((o) => o.op === 'test' && o.ssh)
  check('the pre-test payload carries the ssh block', !!sent, JSON.stringify(p.opCalls))
  check('ssh host/port/user/auth travel as non-secret fields',
    !!sent && sent.ssh.host === 'bastion.example.com' && sent.ssh.port === '2222' && sent.ssh.user === 'ops' && sent.ssh.auth === 'key',
    JSON.stringify(sent && sent.ssh))
  check('the key path is sent, the blank passphrase is NOT (blank = keep)',
    !!sent && sent.ssh.keyPath === '~/.ssh/id_ed25519' && sent.ssh.passphrase === undefined,
    JSON.stringify(sent && sent.ssh))
  check('no secret reaches the rendered page', !toHtml(p.tree).includes('CHANGE_ME'))
  // The tunnel state is metadata on the row: it rides the chip tooltip.
  const rowsWithSsh = [
    row('ssh-app', 'D:/work/ssh', 'default', 'mysql://127.0.0.1:3306/app', {
      ssh: { host: 'bastion.example.com', port: 22, user: 'ops', authKind: 'key', hasPassword: false, hasPassphrase: false, keyReady: true, proxyJump: '' },
    }),
  ]
  const q = page(rowsWithSsh, {})
  const chip = classed(q.tree, 'dbh-envname')[0]
  check('a tunnelled row says so in its chip tooltip', String(chip.props.title || '').includes('SSH 隧道 bastion.example.com:22'))
  check('no secret is rendered for that row', !toHtml(q.tree).includes('id_ed25519'))
}

console.log('\n[22] a running probe shows its elapsed time and cleans the ticker up')
{
  const p = page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  clickLabel(p.tree, '测试')
  p.tree = p.renderAgain()
  check('the testing state is shown', toHtml(p.tree).includes('测试中… 0s'), toHtml(p.tree).slice(0, 200))
  const sent = p.opCalls.filter((o) => o.op === 'test' && o.nonce)
  check('exactly one probe was dispatched', sent.length === 1, JSON.stringify(p.opCalls))
  await new Promise((r) => setTimeout(r, 1100))
  p.tree = p.renderAgain()
  check('the elapsed seconds advance', /测试中… [1-9]\ds?/.test(toHtml(p.tree)) || toHtml(p.tree).includes('测试中… 1s'), toHtml(p.tree).slice(0, 300))
  // Disposal must clear the 1s ticker: this gate hangs (and CI times out) if a
  // per-row interval survives the unmount.
  p.dispose()
}

if (liveMount) liveMount.dispose()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exitCode = failures === 0 ? 0 : 1

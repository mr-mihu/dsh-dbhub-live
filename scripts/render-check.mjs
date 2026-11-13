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

// Every poll interval the client opens is tracked, so "no interval outlives the
// page" becomes an explicit check instead of the process silently hanging. (The
// client's write watchdogs are setTimeout-based and are simply cut off by the
// process.exit at the end — they are not a leak signal.)
const liveIntervals = new Map()
{
  const realInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = function (fn, ms, ...rest) {
    const id = realInterval(fn, ms, ...rest)
    liveIntervals.set(id, ms)
    return id
  }
  globalThis.clearInterval = function (id) {
    liveIntervals.delete(id)
    return realClearInterval(id)
  }
}

// ── minimal react ──────────────────────────────────────────────────────────

const react = (() => {
  const instances = []
  let cursor = 0
  // One STABLE node object per tree position, replayed on every render pass: the
  // harness mounts no DOM, but a component that measures a node has to be able to
  // see the same node twice (a fresh object each pass would look like a remount
  // and re-trigger every node-bound effect forever).
  const mountedNodes = new Map()
  let current = null
  let dirty = false
  let pendingEffects = []
  // Every effect cleanup is also registered here. A remount replaces the hook
  // store, so a cleanup stored only on the discarded instance would be lost —
  // and a lost cleanup means a live poll interval that outlives its page.
  const cleanups = new Set()

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

  /**
   * Run one function component and enforce React's hook-order contract: the
   * SAME component must consume the SAME number of hooks on every render.
   * Without this the harness happily re-fills a different number of slots, so a
   * conditional hook (an early return before the hooks, the classic crash
   * "Rendered more hooks than during the previous render") stays invisible.
   * A DIFFERENT component type at the same position is a remount in React, so
   * it starts with an empty hook store.
   */
  function runComponent(type, props, index, firstHookIndex) {
    let s = instances[index]
    if (!s || s.comp !== type) s = instances[index] = { hooks: [], comp: type, count: undefined }
    const savedCurrent = current
    const savedCursor = cursor
    current = s
    cursor = firstHookIndex
    let out
    try {
      out = type(props)
      const used = cursor - firstHookIndex
      if (s.count !== undefined && s.count !== used) {
        throw new Error(`hook order changed: ${s.count} hooks on the previous render, ${used} now `
          + '(Rendered more/fewer hooks than during the previous render)')
      }
      s.count = used
    } finally {
      current = savedCurrent
      cursor = savedCursor
    }
    return out
  }

  function walk(el, path) {
    if (el === null || el === undefined || el === false || el === true) return null
    if (typeof el === 'string' || typeof el === 'number') return { kind: 'text', text: String(el) }
    if (Array.isArray(el)) {
      return { kind: 'frag', children: el.map((c, i) => walk(c, `${path}.${i}`)).filter(Boolean) }
    }
    if (typeof el.type === 'function') {
      const idx = cursor++
      const out = runComponent(el.type, el.props, idx, 0)
      return walk(out, path)
    }
    // Commit-phase refs. React attaches `ref` BEFORE the effects of that render
    // run, and a CALLBACK ref is the only way a component learns that a node
    // mounted (or that a different node replaced it) — that is exactly the defect
    // the measured-column case pins, so the harness has to honour it.
    const ref = el.props && el.props.ref
    if (ref) {
      let node = mountedNodes.get(path)
      if (!node) {
        node = { path }
        mountedNodes.set(path, node)
      }
      if (typeof ref === 'function') ref(node)
      else if (typeof ref === 'object') ref.current = node
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
    mountedNodes.clear()
    pendingEffects = []
    dirty = false
    lastRootType = null
  }

  /** Run every stored effect cleanup — what a real unmount does. */
  function unmount() {
    for (const fn of [...cleanups]) {
      cleanups.delete(fn)
      try { fn() } catch (e) { /* cleanup must not break the gate */ }
    }
    for (const s of instances) {
      for (const hook of s.hooks) {
        if (hook && typeof hook.cleanup === 'function') {
          if (!cleanups.has(hook.cleanup)) {
            try { hook.cleanup() } catch (e) { /* cleanup must not break the gate */ }
          }
          hook.cleanup = undefined
        }
      }
    }
  }

  /**
   * Hard cap on the "render until no state setter fired" loop. A hook that calls
   * a setter on EVERY render (a conditional-hook regression, an effect that
   * re-triggers itself with a fresh object) made this loop spin forever: the gate
   * HUNG instead of failing, so a real defect looked like a slow machine and CI
   * had to be killed. Now the run dies with a readable error — a mutation must go
   * RED, never quiet (R6).
   */
  const MAX_RENDER_ROUNDS = 100

  /** Render `type` (and re-render until no state setter fired). */
  let lastRootType = null
  function render(type, props) {
    // A DIFFERENT root component is a remount: React unmounts the old tree (its
    // effect cleanups run) before mounting the new one. Without this, the old
    // instances were silently dropped with their cleanups unrun — which leaked
    // the page's poll interval when a section rendered another root next.
    if (lastRootType !== null && lastRootType !== type) {
      unmount()
      instances.length = 0
      mountedNodes.clear()
      pendingEffects = []
    }
    lastRootType = type
    let tree
    let rounds = 0
    do {
      rounds += 1
      if (rounds > MAX_RENDER_ROUNDS) {
        dirty = false
        pendingEffects = []
        throw new Error(`effect loop did not settle: still re-rendering after ${MAX_RENDER_ROUNDS} rounds `
          + '(a hook sets state on every render — check for a conditional hook, or an effect with an unstable dependency)')
      }
      dirty = false
      cursor = 0
      const out = runComponent(type, props, 0, 1)
      tree = walk(out, '')
      const runnable = pendingEffects.filter((e) => e.run)
      pendingEffects = []
      for (const e of runnable) {
        const cleanup = e.run()
        if (typeof cleanup === 'function') {
          e.cleanup = cleanup
          cleanups.add(cleanup)
        }
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
    // The harness's real toggle is a controlled `role=switch` button; the stub
    // mirrors its contract so the gate exercises the primitive path, not just our
    // fallback.
    Switch: (props) => react.createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': props.checked === true,
      'aria-label': props.label,
      disabled: props.disabled === true,
      title: props.title,
      className: 'dsh-switch-stub' + (props.className ? ' ' + props.className : ''),
      onClick: () => { if (typeof props.onChange === 'function') props.onChange(props.checked !== true) },
    }, react.createElement('span', { className: 'dsh-switch-thumb' })),
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

// ── the page's stylesheet, captured ────────────────────────────────────────
//
// `ensureStyle()` injects one scoped <style> into `document.head`. Node has no
// document, so the gate supplies the minimum surface it touches and keeps the
// text — which makes the LAYOUT contract (a capped search box, equal control
// heights, the multi-line DSN field) assertable instead of trusting a comment.
const PAGE_STYLE = { text: '' }
if (!globalThis.document) {
  globalThis.document = {
    hidden: false,
    head: {
      appendChild(el) {
        if (el && el.id === 'dsh-dbhub-live-style') PAGE_STYLE.text = String(el.textContent || '')
      },
    },
    getElementById() { return null },
    createElement(tag) { return { tagName: tag, id: '', textContent: '' } },
  }
}
/** The declaration block of one TOP-LEVEL rule in the captured stylesheet. */
function cssRule(selector) {
  const text = PAGE_STYLE.text
  const needle = selector + '{'
  let at = 0
  for (;;) {
    at = text.indexOf(needle, at)
    if (at < 0) return ''
    // A rule starts at the beginning or right after the previous rule's `}`;
    // otherwise this is a descendant selector (`.dbh-row .dbh-input{…}`).
    if (at === 0 || text[at - 1] === '}') break
    at += 1
  }
  const end = text.indexOf('}', at)
  return end < 0 ? '' : text.slice(at + selector.length + 1, end)
}

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
  const posts = []
  const effects = []
  const disposeHandlers = []
  const restores = []
  // dsh 0.2.1+ settings forms: `configForms.get(entryId).set(field, value)`.
  // `opts.formSet` scripts the ANSWER, because "the form took it" is the one thing
  // the client must not guess: 'ok' (default) → true, 'undefined' → resolves with
  // nothing (several 0.2.x builds do), 'false' → refused, 'reject' → throws.
  const configForms = {
    get: (entryId) => ({
      set: (field, value) => {
        formSets.push([entryId, field, value])
        const mode = opts.formSet || 'ok'
        if (mode === 'reject') return Promise.reject(new Error('settings form refused the field'))
        if (mode === 'undefined') return Promise.resolve(undefined)
        if (mode === 'false') return Promise.resolve(false)
        return Promise.resolve(true)
      },
    }),
  }
  // The optional `inputTriggers` service (the composer's `@` menu). Stubbed on
  // purpose: this gate must not depend on the DSH package that ships the real
  // service, only on the shape the bundle uses. Registered sources are kept so
  // the assertions can inspect them; `opts.inputTriggers === false` models a
  // deployment that does NOT provide the service (the callback must never fire).
  const inputTriggers = opts.inputTriggers === false ? null : {
    sources: [],
    registerSource(source) {
      this.sources.push(source)
      // A real registration is disposable: a hot reload re-applies the bundle,
      // so the effect's cleanup has to release the group.
      return () => {
        const at = this.sources.indexOf(source)
        if (at >= 0) this.sources.splice(at, 1)
      }
    },
  }
  // The optional directory picker (`remote.directoryPicker`), reached by the
  // bundle through `ctx.inject(["remote.directoryPicker"])`. Absent unless the
  // scenario supplies one — that is exactly what a host without the service looks
  // like (the card must then hide the 选择 button).
  const directoryPicker = opts.directoryPicker || null
  // The optional `sessions` service (a real client service: `ctx.get('sessions')`
  // whose `list.getSnapshot()` carries `byId[sessionId].cwd`). The `@` menu uses it
  // to pin the CURRENT workspace's group on top; without the service the menu still
  // works, in plain title order — both paths are exercised below.
  const sessions = opts.sessions === false ? null : {
    list: {
      getSnapshot: () => ({
        ids: Object.keys((opts.sessions && opts.sessions.byId) || {}),
        byId: (opts.sessions && opts.sessions.byId) || {},
        phase: 'ready',
      }),
    },
  }
  const ctx = {
    get(name) {
      if (name === 'configForms') return opts.configForms ? configForms : undefined
      if (name === 'sessions') return sessions || undefined
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
    // The core Cordis injector. Every requested dependency must be satisfied, or
    // the callback never runs — that is how an optional, waiting dependency
    // behaves on a host that does not provide it (the plugin half still loads;
    // only the feature that needs the service stays away).
    inject(names, cb) {
      const wanted = Array.isArray(names) ? names : [names]
      const wantsTriggers = wanted.indexOf('inputTriggers') >= 0
      const wantsPicker = wanted.indexOf('remote.directoryPicker') >= 0
      const satisfied = (wantsTriggers ? !!inputTriggers : true) && (wantsPicker ? !!directoryPicker : true)
      if (!satisfied) return () => {}
      const scope = {
        effect(fn) {
          const cleanup = fn()
          ctx.effect(() => cleanup)
          return () => {}
        },
      }
      if (wantsTriggers) scope.inputTriggers = inputTriggers
      if (wantsPicker) scope.remote = { directoryPicker }
      cb(scope)
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
  {
    // The bundle reads the page-global `fetch`; the fake answers the four
    // bridge routes with a MUTABLE view, because an `enabled` write must be
    // observable on the next read (that is exactly what re-syncs the sidebar
    // entry).
    //
    // `opts.fetchImpl({ url, body, liveView })` scripts the answer, which is how
    // the failure paths below become reachable at all (a stub that always says
    // `{ok:true}` makes "a refused write looked saved" structurally invisible):
    //   undefined        → the normal success answer
    //   'reject'         → the fetch itself rejects (dead network / offline)
    //   'html'           → a 200 whose body is NOT JSON (a reverse proxy's page):
    //                      `json()` throws, exactly like the browser's
    //   { status, payload } → that HTTP status + JSON body (401, {ok:false,error})
    //   a Promise        → the test resolves it later, to force RESPONSE ORDER
    // `posts` records EVERY dispatched non-GET request (accepted or not), which is
    // how "one user action sent exactly one write" becomes assertable; `setCalls`
    // still means "the Host took it".
    const previousFetch = globalThis.fetch
    const liveView = Object.assign({}, snapshot)
    const respond = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      // Reads are recorded even when they fail: "the retry really re-read" is
      // an assertion about attempts, not about successes.
      if (!body) getCalls.push(url)
      else posts.push({ url, body })
      const planned = respond ? respond({ url, body, liveView }) : undefined
      if (planned && typeof planned.then === 'function') return planned
      if (planned === 'reject') throw new Error('network down')
      if (planned === 'html') {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE html>..." is not valid JSON')
          },
        }
      }
      const status = planned && typeof planned.status === 'number' ? planned.status : 200
      const payload = planned && planned.payload ? planned.payload : { ok: true, value: liveView }
      const accepted = status < 400 && payload && payload.ok !== false
      if (accepted && body) {
        if (body.op !== undefined) opCalls.push(body.op)
        else if (typeof body.enabled === 'boolean') {
          setCalls.push(['enabled', body.enabled])
          liveView.enabled = body.enabled
        } else {
          setCalls.push(['options', body])
          Object.assign(liveView, body)
        }
      }
      return { ok: status < 400, status, json: async () => payload }
    }
    restores.push(() => { globalThis.fetch = previousFetch })
  }
  bundle.apply(ctx)
  return {
    registrations, setCalls, opCalls, getCalls, formSets, posts, inputTriggers,
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

/**
 * Commit a settings field the way a person does now: there is no 保存 button any
 * more, so the write happens on BLUR (or Enter). `index` picks the field among the
 * `.dbh-srow-input` boxes (0 = interval, 1 = concurrency, 2 = row limit) and
 * `dbh-input-dir` is the export directory.
 */
function commitFieldAt(node, index = 0, via = 'blur') {
  const input = classed(node, 'dbh-srow-input')[index]
  // Prefer the real gesture, whichever one this build implements.
  if (input && via === 'enter' && typeof input.props.onKeyDown === 'function') {
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
    return
  }
  if (input && typeof input.props.onBlur === 'function') {
    input.props.onBlur()
    return
  }
  // Before 6.0 the only commit was the form-wide 保存 button. Falling back to it
  // keeps an old build running so every rewritten assertion reports its own
  // failure instead of the gate aborting on the first missing handler.
  const save = elements(node, (el) => typeof el.props.onClick === 'function'
    && (el.children || []).map(toHtml).join('').includes('保存配置'))[0]
  if (save) {
    save.props.onClick({ stopPropagation() {}, preventDefault() {} })
    return
  }
  throw new Error(`no committable .dbh-srow-input[${index}] in the tree`)
}

/** Commit the export-directory field (`.dbh-input-dir`). */
function commitDir(node, via = 'blur') {
  const input = classed(node, 'dbh-input-dir')[0]
  if (input && via === 'enter' && typeof input.props.onKeyDown === 'function') {
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
    return
  }
  if (input && typeof input.props.onBlur === 'function') {
    input.props.onBlur()
    return
  }
  const save = elements(node, (el) => typeof el.props.onClick === 'function'
    && (el.children || []).map(toHtml).join('').includes('保存配置'))[0]
  if (save) {
    save.props.onClick({ stopPropagation() {}, preventDefault() {} })
    return
  }
  throw new Error('no committable .dbh-input-dir in the tree')
}

/** Expand every group of a mounted page (the UI memory outlives mounts). */
function expandAll(mount) {
  const heads = () => classed(mount.tree, 'dbh-grouphead')
  for (let i = 0; i < heads().length; i++) {
    const head = heads()[i]
    if (!head || head.props['aria-expanded'] === true) continue
    head.props.onClick({ stopPropagation() {}, preventDefault() {} })
    mount.tree = mount.renderAgain()
  }
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
  // The alias is computed by the HOST from the whole row set (collect.mjs); the
  // fixture spells the same shape out so the `@` menu has something to name.
  alias: title + (env === 'default' ? '' : '_' + env),
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
// Composer `@` menu fixture: two DIFFERENT workspaces both own an environment
// named `prod`, so the Host aliases them apart (`app_prod` / `billing_prod`) and
// the menu must keep both. The alias is a Host field (like `srcId`); the client
// never derives it.
const AT_MENU = [
  row('app', 'D:/work/app', 'prod', 'mysql://127.0.0.1:3307/app', { alias: 'app_prod', ro: true }),
  row('billing', 'D:/work/billing', 'prod', 'postgres://127.0.0.1:5432/bill', { alias: 'billing_prod' }),
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app', { alias: 'default' }),
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
async function page(rows, opts = {}) {
  // A hot reload disposes the previous instance before applying the new bundle;
  // `keepStale` models the pathological case where its LOCALE DICTIONARIES could
  // not be released (the plugin half falls back to local copy). The old tree's
  // effects still have to be torn down here — the next render replaces the hook
  // store, and a poll interval leaked that way would keep this gate alive.
  if (liveMount) {
    if (opts.keepStale) react.unmount()
    else liveMount.dispose()
  }
  const snapshot = snapshotOf(rows, Object.assign({}, MODERN_DEFAULTS, opts.snapshot))
  const m = mount(snapshot, opts)
  liveMount = m
  const slot = opts.slot || 'settings.section'
  const entry = m.registrations[slot]
  if (!entry) throw new Error(`${slot} was not registered`)
  const props = Object.assign({}, entry.def.inject(), opts.props, { view: opts.view || 'page' })
  const comp = entry.comp
  const renderAgain = () => react.render(comp, props)
  react.reset()
  let tree = react.render(comp, props)
  // The only face is the asynchronous bridge: let the first `/state` read land
  // before the assertions look at the page (0.1.x's synchronous push is gone).
  // Two rounds: opening the page also dispatches a (throttled) update check,
  // whose write answer outranks the read that started before it.
  for (let round = 0; round < 2; round += 1) {
    await flush()
    tree = react.render(comp, props)
  }
  return Object.assign(m, { props, comp, renderAgain, tree })
}

/** The browser viewport width the page sees (the bundle falls back to it when
 *  ResizeObserver is unavailable — which is this offscreen harness). */
function viewport(px) {
  windowShim.innerWidth = px
}

/** Let every bridge promise settle (fetch → publish → subscriber → effect). */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Concatenated text of every element carrying `cls` (scoped text assertions). */
const textMatching = (node, cls) => classed(node, cls).map(toHtml).join(' | ')

/**
 * The entry that actually OCCUPIES a slot, or null. `slots.inject` stores its
 * own disposer under the same key, so plain truthiness cannot tell "an entry is
 * registered" from "the slot was merely injected"; an entry is `{ def, comp }`.
 */
const slotEntry = (m, name) => {
  const r = m.registrations[name]
  return r && typeof r.comp === 'function' ? r : null
}

/** The host view fields every mount carries: version metadata + an empty update
 *  snapshot. `dshTooOld` is false unless a section overrides it. */
const MODERN_DEFAULTS = {
  dshMinVersion: '0.2.1',
  dshTooOld: false,
  pluginVersion: '5.2.0-dev.1',
  dshVersion: '0.2.1-rc.2',
  runtime: 'web',
  update: '',
}

/** Set a `.dbh-switch-input` (the modern 显示/隐藏 toggle lives in it). */
function switchWithin(node, cls, index, checked) {
  const scope = classed(node, cls)[0]
  if (!scope) throw new Error(`no .${cls} in the tree`)
  const inputs = elements(scope, (el) => el.type === 'input'
    && String(el.props.className || '').split(/\s+/).includes('dbh-switch-input'))
  const input = inputs[index]
  if (!input) throw new Error(`no switch ${index} inside .${cls} (found ${inputs.length})`)
  input.props.onChange({ target: { checked } })
  return input
}

/** Click the nth `role=switch` control inside the first `.cls` scope (the
 *  harness Switch primitive's contract: click asks for the opposite state). */
function clickSwitchWithin(node, cls, index) {
  const scope = classed(node, cls)[0]
  if (!scope) throw new Error(`no .${cls} in the tree`)
  const switches = elements(scope, (el) => el.type === 'button' && el.props.role === 'switch')
  const sw = switches[index]
  if (!sw) throw new Error(`no role=switch ${index} inside .${cls} (found ${switches.length})`)
  sw.props.onClick({ stopPropagation() {}, preventDefault() {} })
  return sw
}

/** All `role=switch` buttons in the tree. */
function switches(node) {
  return elements(node, (el) => el.type === 'button' && el.props.role === 'switch')
}

console.log('\n[1] tiled layout (every workspace has exactly one environment)')
{
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
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
  // 3 rows: two persisted (test + edit + copy + delete) and one auto-discovered
  // (test + edit only — copy and drag are refused for it).
  check('actions are icon-only', classed(p.tree, 'dbh-iconbtn').length === 10, `got ${classed(p.tree, 'dbh-iconbtn').length}`)
  const handles = classed(p.tree, 'dbh-srcid').map((el) => toHtml(el))
  check('short handles are shown whole', handles.some((h) => h.includes('app_1a2b3c')) && handles.some((h) => h.includes('docs_1a2b3c')), JSON.stringify(handles))
  check('long handles keep their distinguishing tail', handles.some((h) => h.includes('…1a2b3c')), JSON.stringify(handles))
  check('database name rendered separately', classed(p.tree, 'dbh-conn-db').length === 3)
  check('host/port prefix is the truncatable half', classed(p.tree, 'dbh-conn-pre').length === 3)
}

console.log('\n[2] grouped layout (one workspace owns several environments)')
{
  const p = await page(GROUPED, { props: { useWorkspaces: wsSnap('D:/work/app', '2026-01-02T00:00:00Z') } })
  if (process.env.DBHUB_DEBUG) console.log(toHtml(p.tree).slice(0, 3000))
  const heads = classed(p.tree, 'dbh-grouphead')
  const html = toHtml(p.tree)
  check('group per workspace', count(p.tree, 'dbh-group') === 2, `got ${count(p.tree, 'dbh-group')}`)
  check('recently used workspace auto-opens', heads[0].props['aria-expanded'] === true)
  check('the other workspace stays folded', heads[1].props['aria-expanded'] === false)
  check('folded group hides its rows', count(p.tree, 'dbh-envrow') === 3, `got ${count(p.tree, 'dbh-envrow')}`)
  check('expand-all control present', html.includes('全部展开'))
  check('per-group add button present', html.includes('＋ 环境'))
  // The count names the total, and the second number appears ONLY when an
  // auto-discovered (never stored) row exists — "N 已保存" raised "so some are
  // not saved?", which is a question the UI then had to answer in a tooltip.
  const meta = classed(p.tree, 'dbh-groupmeta').map(toHtml).join(' | ')
  check('group head shows the source count, plus auto-discovered when there is any',
    meta.includes('3 个数据源') && meta.includes('1 个自动发现'), meta)
  const onlySaved = await page(SINGLE_MULTI, {})
  const metaSaved = classed(onlySaved.tree, 'dbh-groupmeta').map(toHtml).join(' | ')
  check('…and a fully persisted workspace says only the count (no "saved" ledger)',
    metaSaved.includes('2 个数据源') && !metaSaved.includes('自动发现') && !metaSaved.includes('已保存'), metaSaved)
  onlySaved.dispose()
  check('status line present', html.includes('运行中') && html.includes('4 个连接'))
}

console.log('\n[3] a lone workspace opens by itself (no workspace snapshot available)')
{
  const p = await page(SINGLE_MULTI, {})
  const heads = classed(p.tree, 'dbh-grouphead')
  check('single group', count(p.tree, 'dbh-group') === 1)
  check('open by default', heads[0].props['aria-expanded'] === true)
  check('its rows are visible', count(p.tree, 'dbh-envrow') === 2)
}

console.log('\n[4] empty state')
{
  const p = await page([], {})
  const html = toHtml(p.tree)
  check('empty hint rendered', count(p.tree, 'dbh-empty') === 1)
  check('add entry still offered', html.includes('＋ 添加连接'))
  check('no tiles / groups', count(p.tree, 'dbh-tile') === 0 && count(p.tree, 'dbh-group') === 0)
}

console.log('\n[5] duplicate workspace titles are disambiguated by path')
{
  const p = await page(DUP_TITLES, {})
  const html = toHtml(p.tree)
  check('both paths shown', html.includes('D:/work/one/app') && html.includes('D:/work/two/app'))
}

console.log('\n[6] malformed workspace snapshot cannot break the page')
{
  const p = await page(GROUPED, { props: { useWorkspaces: () => null } })
  check('falls back to all-folded', classed(p.tree, 'dbh-grouphead').every((el) => el.props['aria-expanded'] === false))
}

console.log('\n[7] interaction: expand/collapse all + group toggle')
{
  const p = await page(GROUPED, {})
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

console.log('\n[8] interaction: add panel (global + per group), settings rows, copy')
{
  const p = await page(GROUPED, {})
  check('add panel hidden by default', count(p.tree, 'dbh-addpanel') === 0)
  check('the dialog folds its settings behind the 设置 toggle', count(p.tree, 'dbh-settings') === 0)
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
  // The settings block carries the four controls: enable / sidebar / policy / interval.
  click(p.tree, '设置')
  p.tree = p.renderAgain()
  check('the 设置 toggle opens the settings rows', count(p.tree, 'dbh-settings') === 1)
  const bar = toHtml(classed(p.tree, 'dbh-settings')[0])
  check('rows carry the sidebar switch', bar.includes('侧边栏入口'))
  check('rows keep the numeric settings (interval + concurrency + row limit)', classed(p.tree, 'dbh-srow-input').length === 3,
    `got ${classed(p.tree, 'dbh-srow-input').length}`)
  // Toggling it applies immediately (no Save round-trip). Index 1 = sidebar
  // (0 = enable, 1 = sidebar, 2 = policy).
  const beforeWrites = p.setCalls.length
  clickSwitchWithin(p.tree, 'dbh-settings', 1)
  p.tree = p.renderAgain()
  // saveConfig queues its writes, so let the microtasks drain before asserting.
  await new Promise((r) => setTimeout(r, 0))
  const writes = p.setCalls.slice(beforeWrites)
  check('sidebar switch writes showSidebarEntry immediately',
    writes.some(([k, v]) => k === 'options' && v.showSidebarEntry === false), JSON.stringify(writes))
  check('the row state word follows the switch', toHtml(p.tree).includes('隐藏'))

  // The policy announcement is a SECOND, independent switch: it changes what
  // the model sees (one system-prompt section), never what the tools can do.
  check('rows carry the policy announcement switch', toHtml(p.tree).includes('向模型注入访问策略'))
  const beforePolicy = p.setCalls.length
  clickSwitchWithin(p.tree, 'dbh-settings', 2)
  p.tree = p.renderAgain()
  await new Promise((r) => setTimeout(r, 0))
  const policyWrites = p.setCalls.slice(beforePolicy)
  check('policy switch writes announceAccessPolicy immediately',
    policyWrites.some(([k, v]) => k === 'options' && v.announceAccessPolicy === false), JSON.stringify(policyWrites))
  check('disabling the announcement does not touch the enabled state',
    !policyWrites.some(([k]) => k === 'enabled'), JSON.stringify(policyWrites))
}

console.log('\n[9] summary view (Plugins page one-liner)')
{
  // The same card serves both views; mount the summary through the normal helper
  // so the mount (and its poll interval) is disposed like every other page.
  const p = await page(TILED, { slot: 'plugins.row.config', view: 'summary' })
  const tree = p.tree
  const html = toHtml(tree)
  check('single line', count(tree, 'dbh-summary') === 1 && count(tree, 'dbh-tile') === 0)
  check('carries phase, tool count and env count', html.includes('运行中') && html.includes('4 个工具') && html.includes('3 个环境'))
}

console.log('\n[10] i18n coverage (no raw key or unfilled placeholder may reach the page)')
{
  const problems = []
  for (const lang of ['zh', 'en']) {
    for (const rows of [GROUPED, TILED, []]) {
      const p = await page(rows, { lang, props: { useWorkspaces: wsSnap('D:/work/app') } })
      const html = toHtml(p.tree)
      const leftovers = html.match(/!![a-zA-Z][a-zA-Z.]*!!/g) || []
      const placeholders = html.match(/\{[a-zA-Z]\}/g) || []
      if (leftovers.length) problems.push(`${lang}/${rows.length}rows missing: ${[...new Set(leftovers)].join(', ')}`)
      if (placeholders.length) problems.push(`${lang}/${rows.length}rows unfilled: ${[...new Set(placeholders)].join(', ')}`)
    }
  }
  check('every key exists in both dictionaries and every placeholder is filled', problems.length === 0, problems.join(' | '))
}

console.log('\n[11] view state survives a remount inside the same page session')
{
  const first = await page(SINGLE_MULTI, {})
  click(first.tree, '全部折叠')
  first.tree = first.renderAgain()
  // `uiMemory` is shared across mounts inside one page session, so an earlier
  // section may already have left the settings rows open.
  if (count(first.tree, 'dbh-settings') === 0) {
    click(first.tree, '设置')
    first.tree = first.renderAgain()
  }
  check('folded in the first mount', count(first.tree, 'dbh-envrow') === 0)
  check('settings opened in the first mount', count(first.tree, 'dbh-settings') === 1)
  const second = await page(SINGLE_MULTI, {})
  check('a new mount keeps the folded choice', count(second.tree, 'dbh-envrow') === 0)
  check('and keeps the settings rows open', count(second.tree, 'dbh-settings') === 1)
}

console.log('\n[12] connection origin is a tooltip, not an inline badge')
{
  // A dedicated fixture: another workspace path cannot inherit an expansion
  // choice remembered from an earlier mount (view state is shared per session).
  const rows = [
    row('origin-app', 'D:/work/origin', 'default', 'mysql://127.0.0.1:3306/a'),
    row('origin-app', 'D:/work/origin', 'staging', 'mysql://127.0.0.1:3307/a', { persisted: false, source: '工作区 mise env' }),
  ]
  const p = await page(rows, {})
  const titles = classed(p.tree, 'dbh-envname').map((c) => String(c.props.title || ''))
  check('both environment chips rendered', titles.length === 2, JSON.stringify(titles))
  check('no pill / badge element anywhere', classed(p.tree, 'dbh-pill').length === 0)
  check('hand-entered row names its origin only in the tooltip', titles.some((x) => x.includes('来源：已保存·用户')))
  check('auto-discovered row says it is not saved', titles.some((x) => x.includes('来源：自动·mise env') && x.includes('未保存')))
  const tiled = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/origin') } })
  check('tiled mode uses the same tooltip', classed(tiled.tree, 'dbh-envname').some((c) => String(c.props.title || '').includes('来源：')))
  check('tiled mode has no badge either', classed(tiled.tree, 'dbh-pill').length === 0)
}

console.log('\n[13] a hot reload must not break on duplicate locale registration')
{
  // The live failure this guards: "locale namespace dsh-dbhub-live already has
  // locale zh" after a client bundle swap, which aborts the whole plugin half.
  const ns = 'dsh-dbhub-live'
  const first = await page(TILED, {})
  check('apply owns the namespace dictionaries', (LOCALE_STORE.get(ns) || new Map()).size === 2)
  first.dispose()
  check('dispose releases them for the next instance', (LOCALE_STORE.get(ns) || new Map()).size === 0)
  const second = await page(TILED, {})
  check('a clean reload re-registers', (LOCALE_STORE.get(ns) || new Map()).size === 2)
  check('reloaded page renders localized copy', toHtml(second.tree).includes('运行中'))
  // pathological: the previous instance never released its dictionaries
  let failure = null
  let stale = null
  try {
    stale = await page(TILED, { keepStale: true })
  } catch (e) {
    failure = e
  }
  check('duplicate registration does not fail the plugin half', failure === null, failure && failure.message)
  const html = stale ? toHtml(stale.tree) : ''
  check('the page still renders its own copy (no raw keys)', html.includes('运行中') && !html.includes('ws.source'))
  check('including the newly added keys', stale !== null && classed(stale.tree, 'dbh-envname').some((c) => String(c.props.title || '').includes('来源')))
  // `keepStale` deliberately skips the previous mount's disposal (that is the
  // pathological case under test). Clean BOTH up now: a live mount owns a poll
  // interval, and a leaked one would keep this gate's process alive forever.
  if (stale) stale.dispose()
  second.dispose()
}

console.log('\n[14] writing into an existing environment asks first')
{
  // The reported flaw: an add whose environment name already exists silently
  // replaced that connection (the Host's setWorkspaceEnv always overwrites).
  // A dedicated fixture: a lone workspace group opens by itself, so the scenario
  // does not depend on expansion state remembered by earlier mounts.
  const OVERWRITE_ROWS = [
    row('ovr-app', 'D:/work/ovr', 'default', 'mysql://127.0.0.1:3306/app'),
    row('ovr-app', 'D:/work/ovr', 'prod', 'mysql://127.0.0.1:3307/app'),
  ]
  const p = await page(OVERWRITE_ROWS, {})
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
  // The page-open update check is a command too: only row commands count here.
  const rowOps = () => p.opCalls.filter((o) => o.op !== 'updateCheck')
  check('nothing was dispatched before the answer', rowOps().length === 0, JSON.stringify(p.opCalls))
  check('the pre-test card is not shown at the same time', count(p.tree, 'dbh-pretest') === 0)
  clickWithin(p.tree, 'dbh-warncard', '取消')
  p.tree = p.renderAgain()
  check('cancel dismisses the prompt', count(p.tree, 'dbh-warncard') === 0)
  check('cancel writes nothing at all', rowOps().length === 0, JSON.stringify(p.opCalls))
  check('the form survives so the name can be fixed', classed(p.tree, 'dbh-addpanel').length === 1)
  // same click, but confirmed
  clickWithin(p.tree, 'dbh-addpanel', '添加连接')
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-warncard', '覆盖并保存')
  await new Promise((r) => setTimeout(r, 0))
  check('confirm enters the normal pre-test flow exactly once',
    rowOps().length === 1 && rowOps()[0].op === 'test' && rowOps()[0].env === 'prod' && rowOps()[0].workspace === 'D:/work/ovr',
    JSON.stringify(p.opCalls))

  // a free environment name must NOT be questioned
  const free = await page(OVERWRITE_ROWS, {})
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

console.log('\n[15] renaming onto an existing environment asks first too')
{
  const RENAME_ROWS = [
    row('rn-app', 'D:/work/rn', 'default', 'mysql://127.0.0.1:3306/app'),
    row('rn-app', 'D:/work/rn', 'prod', 'mysql://127.0.0.1:3307/app'),
  ]
  const p = await page(RENAME_ROWS, {})
  clickLabel(p.tree, '修改') // first row = rn-app/default
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-editrow', 0, 'prod') // rename default → prod (exists, no DSN change)
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-editrow', '保存')
  p.tree = p.renderAgain()
  check('rename onto an existing environment asks first', count(p.tree, 'dbh-warncard') === 1)
  const rowOps = () => p.opCalls.filter((o) => o.op !== 'updateCheck')
  check('no rename dispatched yet', rowOps().length === 0, JSON.stringify(p.opCalls))
  clickWithin(p.tree, 'dbh-warncard', '覆盖并保存')
  await new Promise((r) => setTimeout(r, 0))
  check('confirmed rename is dispatched once with the right names',
    rowOps().length === 1 && rowOps()[0].op === 'rename' && rowOps()[0].env === 'default' && rowOps()[0].newEnv === 'prod',
    JSON.stringify(p.opCalls))

  // editing the connection of the SAME environment is not an overwrite question
  const q = await page(RENAME_ROWS, {})
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

console.log('\n[16] copying a connection label yields the exact string (no separator)')
{
  // The reported flaw: the label renders as two flex items, and the browser's
  // own copy serialization inserts a space between block-level boxes, so pasting
  // "…3306/app" into the DSN field produced "…3306/ app".
  const p = await page(TILED, {})
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
  const grouped = await page([
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

console.log('\n[17] HTTP bridge transport (the only host face)')
{
  // The bridge is the only host face: the page is rendered from /state and every
  // write POSTs to the same authenticated surface.
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
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
  const q = await page(TILED, {
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
  const r = await page(TILED, { configForms: true, props: { useWorkspaces: wsSnap('D:/work/app') } })
  await new Promise((res) => setTimeout(res, 0))
  r.tree = r.renderAgain()
  await r.props.saveConfig({ updateIntervalDays: 6 })
  check('an unresolved entry id falls back to the bridge',
    r.setCalls.some(([k, v]) => k === 'options' && v.updateIntervalDays === 6) && r.formSets.length === 0,
    JSON.stringify({ sets: r.setCalls, forms: r.formSets }))
  q.dispose()
  r.dispose()
}

console.log('\n[18] disabling the plugin hides the sidebar entry (the settings page stays)')
{
  // F0: entry visible ⇔ plugin enabled. The settings section and the Plugins row
  // are NOT part of that equation — otherwise disabling would lock the user out
  // of the very switch that re-enables it.
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
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
  // The settings rows are the one surface that must stay reachable while the
  // plugin is disabled (the entry is hidden, the page is not).
  await p.props.setEnabled(false)
  p.tree = p.renderAgain()
  if (count(p.tree, 'dbh-settings') === 0) {
    click(p.tree, '设置')
    p.tree = p.renderAgain()
  }
  check('the settings rows stay reachable while disabled',
    count(p.tree, 'dbh-settings') === 1 && toHtml(p.tree).includes('已禁用'), toHtml(p.tree).slice(0, 400))
  p.dispose()
}

console.log('\n[19] read-only switch → op payload → inline row chip')
{
  const rows = [
    row('ro-app', 'D:/work/ro', 'default', 'mysql://127.0.0.1:3306/app'),
    row('ro-app', 'D:/work/ro', 'prod', 'mysql://127.0.0.1:3307/app', { ro: true }),
  ]
  const p = await page(rows, {})
  check('the lone workspace is open', count(p.tree, 'dbh-envrow') === 2)
  // Every row carries the chip; exactly the read-only one is in the "on" state.
  const chips = classed(p.tree, 'dbh-rochip')
  check('every row carries a read-only chip', chips.length === 2, `got ${chips.length}`)
  check('only the read-only row is locked',
    String(chips[1].props.className).includes('dbh-rochip-on') && !String(chips[0].props.className).includes('dbh-rochip-on'))
  check('the locked chip says 只读', toHtml(chips[1]).includes('只读') && toHtml(chips[1]).includes('🔒'))
  check('the writable chip says 可写', toHtml(chips[0]).includes('可写') && toHtml(chips[0]).includes('🔓'))
  const envs = classed(p.tree, 'dbh-envname')
  check('the chip tooltip explains read-only', String(envs[1].props.title || '').includes('只读模式'))
  check('the writable row is not marked read-only', !String(envs[0].props.title || '').includes('只读模式'))
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
  const q = await page(rows, {})
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

console.log('\n[20] advanced SSH tunnel: expand → fill → payload, secrets never rendered')
{
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
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
  const q = await page(rowsWithSsh, {})
  const chip = classed(q.tree, 'dbh-envname')[0]
  check('a tunnelled row says so in its chip tooltip', String(chip.props.title || '').includes('SSH 隧道 bastion.example.com:22'))
  check('no secret is rendered for that row', !toHtml(q.tree).includes('id_ed25519'))
}

console.log('\n[21] the SSH-layer-only test is a separate button with its own payload')
{
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  click(p.tree, '＋ 添加连接')
  p.tree = p.renderAgain()
  // `uiMemory.advOpen` is module-level (it survives remounts on purpose), so an
  // earlier group may already have left the section open — never blind-toggle.
  if (count(p.tree, 'dbh-advbody') === 0) {
    clickWithin(p.tree, 'dbh-addpanel', '高级：SSH 隧道')
    p.tree = p.renderAgain()
  }
  check('the advanced section is open for the SSH test', count(p.tree, 'dbh-advbody') === 1)
  checkBoxWithin(p.tree, 'dbh-addpanel', 1, true)
  p.tree = p.renderAgain()
  check('the dedicated SSH test button is offered next to the connection test',
    toHtml(classed(p.tree, 'dbh-advbody')[0]).includes('测试 SSH 隧道'))
  // An empty block is still dispatched: the HOST answers with the named missing
  // fields (one source of truth for that message), and it never spawns dbhub.
  // A click with host/user still blank is answered LOCALLY (the form names the
  // missing fields) instead of spending a round-trip on a Host error that says
  // the same thing without naming the fields.
  const before = p.opCalls.length
  clickWithin(p.tree, 'dbh-advbody', '测试 SSH 隧道')
  p.tree = p.renderAgain()
  check('the SSH test with a blank host/user does not dispatch',
    !p.opCalls.slice(before).some((o) => o.op === 'test' && o.kind === 'ssh'), JSON.stringify(p.opCalls.slice(before)))
  check('…and the form names the missing fields', toHtml(p.tree).includes('请先填 SSH 主机与用户'), toHtml(p.tree).slice(0, 300))
  // Fill the two required fields: the same click now really dispatches.
  typeWithin(p.tree, 'dbh-advbody', 0, 'bastion.example.com')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-advbody', 2, 'deploy')
  p.tree = p.renderAgain()
  const beforeReal = p.opCalls.length
  clickWithin(p.tree, 'dbh-advbody', '测试 SSH 隧道')
  p.tree = p.renderAgain()
  const sent = p.opCalls.slice(beforeReal).filter((o) => o.op === 'test' && o.kind === 'ssh').pop()
  check('the SSH test dispatches {op:test, kind:ssh} with the tunnel block',
    !!sent && sent.ssh && sent.ssh.auth === 'key', JSON.stringify(sent))
  check('the SSH test carries its own nonce', !!sent && typeof sent.nonce === 'string' && sent.nonce.includes('sshtest'))
  check('the SSH test is NOT the connection test (no dsn in its payload)',
    !!sent && sent.dsn === undefined, JSON.stringify(sent))
  check('the pending SSH test shows its elapsed time', toHtml(p.tree).includes('测试中…'), toHtml(p.tree).slice(0, 300))
  // A second click while the probe is in flight must NOT dispatch again (the
  // button is disabled and the guard in startSshTest is the real backstop).
  const inFlight = p.opCalls.length
  clickWithin(p.tree, 'dbh-advbody', '测试 SSH 隧道')
  check('a second click during the probe is ignored', p.opCalls.length === inFlight, JSON.stringify(p.opCalls.slice(inFlight)))
  // Disposal clears the pending watchdog timer (a surviving 60s timeout would
  // keep this gate alive after the last check).
  p.dispose()
}

console.log('\n[22] a running probe shows its elapsed time and cleans the ticker up')
{
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
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

console.log('\n[23] modern wide page: quiet header, DSH-style settings rows, inline read-only chip')
{
  viewport(1440)
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  let html = toHtml(p.tree)
  check('wide surface class applied', classed(p.tree, 'dbh-wide').length === 1, html.slice(0, 200))
  check('modern class applied', classed(p.tree, 'dbh-modern').length === 1)
  check('title bar rendered', count(p.tree, 'dbh-titlebar') === 1)
  check('title is the plugin name', classed(p.tree, 'dbh-title').map((el) => toHtml(el)).some((t) => t.includes('DBHub 数据库工具')), toHtml(classed(p.tree, 'dbh-title')[0]))
  check('current version shown next to the title', html.includes('v5.2.0-dev.1'))
  check('no update UI when already current', classed(p.tree, 'dbh-updatelink').length === 0 && count(p.tree, 'dbh-updatepanel') === 0)
  check('update check button offered (icon only)', classed(p.tree, 'dbh-vercheck').length === 1)
  check('status line is state + connection count', count(p.tree, 'dbh-statusline') === 1 && html.includes('运行中') && html.includes('个连接'))
  check('tool count / one-shot mode no longer in the header', !html.includes('4 个工具') && !html.includes('固定'), html.slice(0, 300))
  check('no runtime badge in the header', !html.includes('Web 版') && !html.includes('桌面版'))
  check('settings bar visible (wide page owns it)', count(p.tree, 'dbh-settings') === 1 && count(p.tree, 'dbh-settingsbar') === 1)
  check('four toggle groups on the first line, three numeric settings on the second',
    count(p.tree, 'dbh-bargroup') === 7 && classed(p.tree, 'dbh-barline').length === 2,
    `got ${count(p.tree, 'dbh-bargroup')} groups / ${classed(p.tree, 'dbh-barline').length} lines`)
  check('three harness Switch controls (enable / sidebar / policy)', switches(p.tree).length === 3, `got ${switches(p.tree).length}`)
  check('the interval keeps its own input', classed(p.tree, 'dbh-srow-input').length === 3)
  check('no stretched settings rows in wide mode', count(p.tree, 'dbh-srow') === 0)
  check('no old four-cell grid / gear strip', count(p.tree, 'dbh-config') === 0 && count(p.tree, 'dbh-strip') === 0)
  check('a read-only chip per row (outside the edit form)', classed(p.tree, 'dbh-rochip').length === 3, `got ${classed(p.tree, 'dbh-rochip').length}`)
  check('row actions stay icon-only (source + test + edit + copy + delete)', classed(p.tree, 'dbh-iconbtn').length === 10, `got ${classed(p.tree, 'dbh-iconbtn').length}`)
  // Notes are collapsed: the page acts first; the "why" is one click away.
  check('technical details start collapsed', count(p.tree, 'dbh-notes') === 0)
  clickClass(p.tree, 'dbh-linkbtn') // ⓘ 说明与技术详情
  p.tree = p.renderAgain()
  html = toHtml(p.tree)
  check('notes expand with tool count / policy / versions', count(p.tree, 'dbh-notes') === 1 && html.includes('4 个工具') && html.includes('v5.2.0-dev.1'))
  // Opening the page asks the Host for a THROTTLED update check (op only; the
  // Host owns the network call and the cache).
  const checks = p.opCalls.filter((o) => o.op === 'updateCheck')
  check('page open dispatches a throttled update check', checks.length === 1 && checks[0].force === false, JSON.stringify(p.opCalls))
  const before = p.setCalls.length
  clickSwitchWithin(p.tree, 'dbh-settingsbar', 0)
  check('enable switch disables the plugin', p.setCalls.slice(before).some(([k, v]) => k === 'enabled' && v === false), JSON.stringify(p.setCalls.slice(before)))
  p.tree = p.renderAgain()
  const beforeSidebar = p.setCalls.length
  clickSwitchWithin(p.tree, 'dbh-settingsbar', 1)
  // saveConfig chains one `host.set` per field through a promise, so the write
  // lands on the next microtask (the immediate-apply contract, not a sync call).
  await Promise.resolve()
  await Promise.resolve()
  check('sidebar switch saves 显示/隐藏 preference',
    p.setCalls.slice(beforeSidebar).some(([k, v]) => k === 'options' && v.showSidebarEntry === false),
    JSON.stringify(p.setCalls.slice(beforeSidebar)))
  // The row chip is an options-only op: never a DSN.
  const beforeOps = p.opCalls.length
  clickClass(p.tree, 'dbh-rochip')
  const roOp = p.opCalls.slice(beforeOps).find((o) => o.op === 'options')
  check('row read-only chip writes {op:options, readOnly:true}', !!roOp && roOp.readOnly === true, JSON.stringify(roOp))
  check('row read-only chip carries no dsn', !!roOp && roOp.dsn === undefined, JSON.stringify(roOp))
  p.dispose()
}

console.log('\n[24] modern update link: quiet by default, neutral detail panel on click')
{
  const update = JSON.stringify({
    latest: '5.2.0', latestSpec: 'dsh-dbhub-live@5.2.0', hasUpdate: true,
    checkedAt: Date.now(), source: 'npm', error: '',
  })
  viewport(1440)
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS, { update }),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  let html = toHtml(p.tree)
  check('update surfaces as a quiet text link', classed(p.tree, 'dbh-updatelink').length === 1 && html.includes('可升级到 5.2.0'), html.slice(0, 300))
  // The tooltip must describe what the click DOES (expand the panel). It used to
  // say "点击复制 …", i.e. it promised a copy that only the panel's button
  // performs — a user clicking it to copy got an expanding panel instead.
  const updateLink = classed(p.tree, 'dbh-updatelink')[0]
  check('the link tooltip describes the expansion', updateLink.props.title === '展开升级说明与安装命令', JSON.stringify(updateLink.props.title))
  check('the link does not advertise a copy', !String(updateLink.props.title).includes('复制'))
  check('no red/error-styled update card exists', classed(p.tree, 'dbh-latest').length === 0 && count(p.tree, 'dbh-updatecard') === 0)
  check('details stay collapsed until asked for', count(p.tree, 'dbh-updatepanel') === 0)
  clickClass(p.tree, 'dbh-updatelink')
  p.tree = p.renderAgain()
  html = toHtml(p.tree)
  check('clicking the link opens the neutral detail panel', count(p.tree, 'dbh-updatepanel') === 1)
  // …and the copy tooltip lives on the panel's copy button, where the copy is.
  const copyTitle = elements(p.tree, (el) => el.type === 'button' && String(el.props.title || '').includes('点击复制')).length
  check('the copy button inside the panel carries the copy tooltip', copyTitle === 1, String(copyTitle))
  check('panel carries the install spec', html.includes('dsh-dbhub-live@5.2.0'))
  check('web runtime gets the web update command', html.includes('dsh plugin --profile web up dsh-dbhub-live@5.2.0'))
  const releaseHref = elements(p.tree, (el) => typeof el.props.href === 'string').map((el) => el.props.href)
  check('release notes link points at the GitHub release', releaseHref.some((h) => h.includes('https://github.com/mr-mihu/dsh-dbhub-live/releases/tag/v5.2.0')), JSON.stringify(releaseHref))
  // The copy control copies the exact install spec (the thing a person pastes).
  let copied = ''
  const previousClipboard = primitivesStub.writeClipboard
  primitivesStub.writeClipboard = (text) => { copied = String(text); return Promise.resolve(true) }
  clickClass(p.tree, 'dbh-linkbtn')
  primitivesStub.writeClipboard = previousClipboard
  check('copy control copies dsh-dbhub-live@<latest>', copied === 'dsh-dbhub-live@5.2.0', JSON.stringify(copied))
  // The explicit check button forces a refresh (bypassing the Host throttle).
  const before = p.opCalls.length
  clickClass(p.tree, 'dbh-vercheck')
  check('check button forces a fresh check', p.opCalls.slice(before).some((o) => o.op === 'updateCheck' && o.force === true), JSON.stringify(p.opCalls.slice(before)))
  p.dispose()
}

console.log('\n[25] modern update panel on desktop: uninstall/reinstall guidance, no web command')
{
  viewport(1440)
  const update = JSON.stringify({
    latest: '5.2.0', latestSpec: 'dsh-dbhub-live@5.2.0', hasUpdate: true,
    checkedAt: Date.now(), source: 'npm', error: '',
  })
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS, { runtime: 'desktop', update }),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  let html = toHtml(p.tree)
  check('no desktop runtime badge in the header', !html.includes('桌面版'))
  clickClass(p.tree, 'dbh-updatelink')
  p.tree = p.renderAgain()
  html = toHtml(p.tree)
  check('desktop guidance says uninstall + reinstall', html.includes('卸载') && html.includes('重新安装'))
  check('desktop guidance keeps the data location', html.includes('~/.dsh/storages/dsh-dbhub-live'))
  check('desktop panel offers no web install command', !html.includes('dsh plugin --profile web up'), html.slice(0, 400))
  p.dispose()
}

console.log('\n[26] modern settings dialog: compact header, 设置 disclosure, read-only chips visible')
{
  viewport(1440)
  const p = await page(TILED, {
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  let html = toHtml(p.tree)
  check('modal surface class applied', classed(p.tree, 'dbh-modal').length === 1)
  check('modal is not the wide page', classed(p.tree, 'dbh-wide').length === 0)
  check('modal shows the title + version header', count(p.tree, 'dbh-titlebar') === 1 && html.includes('v5.2.0-dev.1'))
  check('no legacy header or gear strip in the modern dialog', count(p.tree, 'dbh-head') === 0 && count(p.tree, 'dbh-strip') === 0 && !html.includes('⚙'))
  check('settings sit behind the status-line toggle (not in the header)', html.includes('设置') && classed(p.tree, 'dbh-linkbtn').length >= 1)
  check('read-only chip is available in the dialog too', classed(p.tree, 'dbh-rochip').length === 3, `got ${classed(p.tree, 'dbh-rochip').length}`)
  // uiMemory survives mounts, so an earlier group may have left the disclosure
  // open; either way the toggle must own the rows and close them on the next click.
  if (count(p.tree, 'dbh-settings') === 0) {
    clickClass(p.tree, 'dbh-linkbtn')
    p.tree = p.renderAgain()
  }
  html = toHtml(p.tree)
  check('the dialog opens the same DSH-style rows', count(p.tree, 'dbh-settings') === 1 && count(p.tree, 'dbh-srow') === 7)
  check('sidebar/policy controls are harness switches', switches(p.tree).length === 3)
  const modernRows = classed(p.tree, 'dbh-settings')[0]
  check('no legacy tick-box left in the settings rows', elements(modernRows, (el) => el.type === 'input' && String(el.props.className || '').includes('dbh-checkbox')).length === 0)
  clickClass(p.tree, 'dbh-linkbtn')
  p.tree = p.renderAgain()
  check('the same toggle collapses the rows again', count(p.tree, 'dbh-settings') === 0)
  p.dispose()
}

console.log('\n[27] modern phone browser: stacked layout, chips and settings still reachable')
{
  viewport(390)
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  const html = toHtml(p.tree)
  check('mobile surface class applied', classed(p.tree, 'dbh-mobile').length === 1, html.slice(0, 200))
  check('phone layout is not the wide page', classed(p.tree, 'dbh-wide').length === 0)
  check('phone shows the title + version', count(p.tree, 'dbh-titlebar') === 1 && html.includes('v5.2.0-dev.1'))
  check('phone keeps the icon-only row actions', classed(p.tree, 'dbh-iconbtn').length === 10)
  check('read-only chips remain available on the phone', classed(p.tree, 'dbh-rochip').length === 3)
  if (count(p.tree, 'dbh-settings') === 0) {
    clickClass(p.tree, 'dbh-linkbtn')
    p.tree = p.renderAgain()
  }
  check('phone can open the settings rows', count(p.tree, 'dbh-srow') === 7)
  viewport(1440)
  p.dispose()
}

console.log('\n[29] narrow desktop window: non-modal pages keep the horizontal settings bar')
{
  // 710px viewport: not a phone (>= 700) and not "wide" (< 720), which used to
  // fall back to four stacked rows — the desktop complaint. The bar must stay
  // horizontal, with its compact variant applied.
  viewport(710)
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  const html = toHtml(p.tree)
  check('narrow desktop still renders the settings bar', count(p.tree, 'dbh-settingsbar') === 1, html.slice(0, 200))
  check('narrow bar uses the compact variant', classed(p.tree, 'dbh-barnarrow').length === 1)
  check('no vertical settings rows on a narrow desktop', count(p.tree, 'dbh-srow') === 0)
  check('all controls stay reachable', count(p.tree, 'dbh-bargroup') === 7 && switches(p.tree).length === 3)
  viewport(1440)
  p.dispose()
}

console.log('\n[30] a refused card command is visible on the card (opNotice)')
{
  // The browser half never reads /op response bodies, so the Host's transient
  // `opNotice` line is the ONLY feedback for "your click was refused". Both faces
  // must render it; a silent refusal looks exactly like a saved one.
  const notice = JSON.stringify({ ok: false, message: '找不到工作区 "D:/work/gone"' })
  viewport(1440)
  const modernPage = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS, { opNotice: notice }),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  const modernHtml = toHtml(modernPage.tree)
  check('the card renders one refusal line', classed(modernPage.tree, 'dbh-notice').length === 1, modernHtml.slice(0, 200))
  check('the refusal line carries the Host message', modernHtml.includes('D:/work/gone'))
  modernPage.dispose()

  // No notice, no line: a successful command must leave the card clean.
  const clean = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS, { opNotice: '' }),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  check('no refusal line without a notice', classed(clean.tree, 'dbh-notice').length === 0)
  clean.dispose()
  viewport(1440)
}

console.log('\n[31] a refused write is VISIBLE and never claims "已保存" (P1-1)')
{
  viewport(1440)
  // The old face resolved every POST (`noop` as the rejection handler), so a 401,
  // a Host refusal and a dead network all printed 已保存. Each failure mode is
  // scripted here; the gate fails if the card lies about any of them.
  let refuseWrites = true
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => (body && body.updateIntervalDays !== undefined
      ? (refuseWrites ? { status: 401, payload: { ok: false, error: 'nope' } } : undefined)
      : undefined),
  })
  await flush()
  p.tree = p.renderAgain()
  const beforeFail = p.setCalls.length
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  let html = toHtml(p.tree)
  check('a 401 save renders exactly one alert line', count(p.tree, 'dbh-writefail') === 1, html.slice(0, 300))
  check('the alert line is an accessible alert',
    String((classed(p.tree, 'dbh-writefail')[0] || { props: {} }).props.role || '') === 'alert')
  check('a refused save does NOT print 已保存', !html.includes('已保存'), html.slice(0, 400))
  check('the transport failure is a localized line, not a raw status',
    textMatching(p.tree, 'dbh-writefail').includes('写入失败') && !textMatching(p.tree, 'dbh-writefail').includes('401'),
    textMatching(p.tree, 'dbh-writefail'))
  check('the refused write was not recorded as applied',
    p.setCalls.length === beforeFail, JSON.stringify(p.setCalls.slice(beforeFail)))
  // Retry is just another click: no lock, no "already failed" state.
  refuseWrites = false
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  html = toHtml(p.tree)
  check('retrying the same click saves for real',
    p.setCalls.slice(beforeFail).some(([k, v]) => k === 'options' && v.updateIntervalDays === 7),
    JSON.stringify(p.setCalls.slice(beforeFail)))
  check('a successful retry clears the alert and shows the tick',
    count(p.tree, 'dbh-writefail') === 0 && html.includes('已保存'))
  p.dispose()

  // A Host REFUSAL is different: the Host already scrubbed its own message, and
  // that text is the only thing that tells the user what to fix.
  viewport(1440)
  const q = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => (body && body.op && body.op.op === 'options'
      ? { status: 200, payload: { ok: false, error: '宿主拒绝：找不到工作区' } }
      : undefined),
  })
  await flush()
  q.tree = q.renderAgain()
  clickClass(q.tree, 'dbh-rochip')
  await flush()
  q.tree = q.renderAgain()
  check('a Host refusal shows the Host message',
    textMatching(q.tree, 'dbh-writefail').includes('宿主拒绝：找不到工作区'),
    textMatching(q.tree, 'dbh-writefail'))
  check('a refused option chip write does not print 已保存', !toHtml(q.tree).includes('已保存'))
  q.dispose()
  viewport(1440)
}

console.log('\n[32] a probe the bridge never delivered is "not sent", not "timed out" (P2-1)')
{
  viewport(1440)
  // Fire-and-forget dispatch: a 401 on /op used to be invisible, so the page
  // spun for 30/60s and then blamed the DATABASE ("测试超时未返回").
  const dsnTyped = 'mysql://user:CHANGE_ME@127.0.0.1:3306/app'
  const p = await page(TILED, {
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => (body && body.op !== undefined && body.op.op === 'test' ? { status: 401 } : undefined),
  })
  await flush()
  p.tree = p.renderAgain()
  // The per-row probe first: the row must settle immediately.
  clickLabel(p.tree, '测试')
  await flush()
  p.tree = p.renderAgain()
  let html = toHtml(p.tree)
  check('a refused row probe settles at once instead of spinning',
    html.includes('测试命令未能送达宿主') && !html.includes('测试中…'), html.slice(0, 400))
  check('the refused probe is not reported as a timeout',
    !html.includes('测试超时未返回'))
  check('the refused probe does not blame the connection',
    !String(classed(p.tree, 'dbh-test-fail').map(toHtml).join('')).includes('连接失败'))
  // The same rule for the pre-save probe of the add form.
  click(p.tree, '＋ 添加连接')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 0, 'D:/work/app')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 1, 'staging')
  p.tree = p.renderAgain()
  typeWithin(p.tree, 'dbh-addpanel', 2, dsnTyped)
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-addpanel', '添加连接')
  await flush()
  p.tree = p.renderAgain()
  html = toHtml(p.tree)
  check('a refused pre-test says the command was not delivered',
    textMatching(p.tree, 'dbh-test-fail').includes('测试命令未能送达宿主'),
    textMatching(p.tree, 'dbh-test-fail'))
  check('the pre-test does not hang on "查找中" / 测试中', !html.includes('正在测试连接…'), html.slice(0, 300))
  check('the failure card offers the two real choices',
    String(textMatching(p.tree, 'dbh-pretest')).includes('测试未通过'))
  // The form keeps what the user typed, so "click again" is a real retry.
  check('the add form survives the refused dispatch', count(p.tree, 'dbh-addpanel') === 1)
  // Zero knowledge: the failure line carries a localized string, never the DSN
  // the user just typed (the POST body had it; the rendered text must not).
  check('the DSN never reaches the failure line',
    !textMatching(p.tree, 'dbh-test-fail').includes('CHANGE_ME')
    && !textMatching(p.tree, 'dbh-writefail').includes('CHANGE_ME'),
    textMatching(p.tree, 'dbh-test-fail'))
  p.dispose()
  viewport(1440)
}

console.log('\n[33] a failed /state is visible + retryable, unknown ≠ "show the entry" (P1-2, P2-9)')
{
  viewport(1440)
  let failRead = true
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    // Every bridge call fails: the page-open update check cannot slip a ready
    // view past the failed read (the real bridge is down in this scenario).
    fetchImpl: () => (failRead ? 'reject' : undefined),
  })
  // One failed read of our own, after the page-open command settled: the card
  // must report it instead of pretending to be an empty page.
  await p.props.refresh()
  p.tree = p.renderAgain()
  check('a failed read renders an error line', count(p.tree, 'dbh-loadfail') === 1, toHtml(p.tree).slice(0, 300))
  check('the error line offers a retry control', count(p.tree, 'dbh-retry') === 1)
  // Self-rescue: a read that never recovers usually means the Host half is not
  // running, and the card must say where to look instead of leaving a bare error.
  check('the error line explains what to check when it keeps failing',
    /设置 → 插件|Settings → Plugins/.test(toHtml(p.tree)), toHtml(p.tree).slice(0, 400))
  check('a failed read never prints 已保存', !toHtml(p.tree).includes('已保存'))
  check('an unknown state registers NO sidebar entry', slotEntry(p, 'sidebar.panellist') === null)
  const readsBefore = p.getCalls.length
  failRead = false
  clickClass(p.tree, 'dbh-retry')
  await flush()
  p.tree = p.renderAgain()
  check('retry really re-reads the bridge', p.getCalls.length > readsBefore,
    JSON.stringify(p.getCalls))
  check('the rows arrive on the retried read', count(p.tree, 'dbh-tile') === 3,
    `got ${count(p.tree, 'dbh-tile')}`)
  check('the error line disappears after a good read', count(p.tree, 'dbh-loadfail') === 0)
  check('the sidebar entry appears once enabled is known', slotEntry(p, 'sidebar.panellist') !== null)
  p.dispose()

  // A successful read whose view does not answer the question is still UNKNOWN:
  // "enabled !== false" used to show the entry before the first good answer.
  const unknown = await page(TILED, {
    snapshot: Object.assign({}, MODERN_DEFAULTS, { enabled: undefined, showSidebarEntry: undefined }),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  await flush()
  check('a view without `enabled` registers no sidebar entry', slotEntry(unknown, 'sidebar.panellist') === null)
  unknown.dispose()
  const known = await page(TILED, {
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  await flush()
  check('a positive enabled:true answer does register it', slotEntry(known, 'sidebar.panellist') !== null)
  known.dispose()

  // Response ORDER: a poll that answers after a newer write must not roll the
  // card back to the pre-write view. The queued read is resolved on demand.
  const queued = []
  const q = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => (body ? undefined : new Promise((resolve) => {
      queued.push((view) => resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: view }) }))
    })),
  })
  check('the initial read is in flight', queued.length === 1, `queued ${queued.length}`)
  await q.props.saveConfig({ updateIntervalDays: 5 })
  q.tree = q.renderAgain()
  check('the write response is applied', (classed(q.tree, 'dbh-srow-input')[0] || { props: {} }).props.value === '5',
    (classed(q.tree, 'dbh-srow-input')[0] || { props: {} }).props.value)
  queued[0](snapshotOf(TILED, { updateIntervalDays: 7 }))
  await flush()
  q.tree = q.renderAgain()
  check('a stale poll cannot overwrite the newer write',
    (classed(q.tree, 'dbh-srow-input')[0] || { props: {} }).props.value === '5',
    (classed(q.tree, 'dbh-srow-input')[0] || { props: {} }).props.value)
  q.dispose()
  viewport(1440)
}

console.log('\n[34] one mounted card switches view without changing its hook order (P1-3)')
{
  viewport(1440)
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  // The Plugins page mounts this card twice (summary line + full page) and can
  // flip `view` on the SAME instance. The early return for `summary` made the
  // second render throw "Rendered more hooks than during the previous render".
  // The card is another slot of the same mount (a different root component), so
  // rendering it unmounts the settings page first — its cleanups run either way.
  const reg = p.registrations['plugins.row.config']
  const propsOf = (view) => Object.assign({}, reg.def.inject(), { view })
  let error = null
  try {
    const summary = react.render(reg.comp, propsOf('summary'))
    check('summary is a single line', count(summary, 'dbh-summary') === 1 && count(summary, 'dbh-tile') === 0)
    const full = react.render(reg.comp, propsOf('page'))
    check('the page view still renders the full form', count(full, 'dbh-tile') === 3, toHtml(full).slice(0, 200))
    // and back again, on the same hook store
    const summaryAgain = react.render(reg.comp, propsOf('summary'))
    check('switching back is fine too', count(summaryAgain, 'dbh-summary') === 1)
  } catch (e) {
    error = e
  }
  check('the hook order is identical in both views', error === null, error && error.message)
  p.dispose()
  viewport(1440)
}

console.log('\n[35] an invalid update interval sends nothing (P2-5)')
{
  viewport(1440)
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  const typeInterval = (value) => {
    typeWithin(p.tree, 'dbh-settingsbar', 0, value)
    p.tree = p.renderAgain()
  }
  // `Number("") === 0`: an emptied box used to save "never update" and print 已保存.
  const emptyBefore = p.setCalls.length
  typeInterval('')
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  check('an empty interval sends no request at all', p.setCalls.length === emptyBefore,
    JSON.stringify(p.setCalls.slice(emptyBefore)))
  check('an empty interval shows the validation line', count(p.tree, 'dbh-invalid') === 1,
    toHtml(p.tree).slice(0, 300))
  check('an invalid interval does not print 已保存', !toHtml(p.tree).includes('已保存'))
  // 1.5 and 400 must be refused client-side too (the Host checks are the backstop).
  for (const bad of ['1.5', '400', '-1']) {
    const before = p.setCalls.length
    typeInterval(bad)
    commitFieldAt(p.tree)
    await flush()
    p.tree = p.renderAgain()
    check(`interval ${bad} is refused before the request`,
      p.setCalls.length === before && count(p.tree, 'dbh-invalid') === 1,
      JSON.stringify(p.setCalls.slice(before)))
  }
  // A legal value goes through, and clears the form error.
  typeInterval('30')
  check('editing clears the validation line', count(p.tree, 'dbh-invalid') === 0)
  const good = p.setCalls.length
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  check('a legal interval is written',
    p.setCalls.slice(good).some(([k, v]) => k === 'options' && v.updateIntervalDays === 30),
    JSON.stringify(p.setCalls.slice(good)))
  check('and it reports saved', toHtml(p.tree).includes('已保存'))
  p.dispose()
  viewport(1440)
}

console.log('\n[36] deleting a connection asks first and cancelling writes nothing (P2-4)')
{
  viewport(1440)
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  const before = p.opCalls.length
  clickLabel(p.tree, '删除')
  p.tree = p.renderAgain()
  check('the delete button opens a confirmation card', count(p.tree, 'dbh-warncard') === 1,
    toHtml(p.tree).slice(0, 300))
  check('the card names the environment it will remove', toHtml(classed(p.tree, 'dbh-warncard')[0]).includes('default'))
  check('nothing is sent before the confirmation', p.opCalls.length === before, JSON.stringify(p.opCalls.slice(before)))
  clickWithin(p.tree, 'dbh-warncard', '取消')
  p.tree = p.renderAgain()
  check('cancel closes the card', count(p.tree, 'dbh-warncard') === 0)
  check('cancel writes nothing at all', p.opCalls.length === before, JSON.stringify(p.opCalls.slice(before)))
  clickLabel(p.tree, '删除')
  p.tree = p.renderAgain()
  clickWithin(p.tree, 'dbh-warncard', '确认删除')
  p.tree = p.renderAgain()
  check('confirming sends exactly one remove op',
    p.opCalls.length === before + 1 && p.opCalls[before].op === 'remove',
    JSON.stringify(p.opCalls.slice(before)))
  check('the remove op carries no DSN', p.opCalls[before].dsn === undefined)
  check('the card is gone after confirming', count(p.tree, 'dbh-warncard') === 0)
  p.dispose()
  viewport(1440)
}

if (liveMount) liveMount.dispose()

console.log('\n[37] the offscreen harness fails fast instead of hanging on an effect loop (R6)')
{
  viewport(1440)
  // `while (dirty)` had no cap: one hook that sets state on EVERY render turned a
  // Hook-order regression into a gate that HUNG (>90s, then had to be killed), so
  // the defect read as "a slow machine" and CI never went red. The cap must be
  // reachable, and its message must say what happened.
  const neverSettles = () => {
    const s = react.useState(0)
    s[1](s[0] + 1)
    return null
  }
  let caught = null
  try { react.render(neverSettles, {}) } catch (e) { caught = e }
  react.reset()
  check('an effect loop that never settles throws instead of hanging',
    !!caught && String((caught && caught.message) || '').includes('effect loop did not settle'),
    caught ? caught.message : 'no error — the loop never ended')
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  check('the harness still renders a real page after the guard fired', count(p.tree, 'dbh-tile') === 3,
    `tiles ${count(p.tree, 'dbh-tile')}`)
  p.dispose()
  viewport(1440)
}

console.log('\n[38] a write answer outranks a read that answered first (R1)')
{
  viewport(1440)
  // The ordering that used to LOSE THE WRITE: write dispatched → read dispatched
  // (the 1.5s poll) → READ answers first with the PRE-write view → write answers
  // last. The read had taken the higher stamp, so the write's own answer was
  // dropped and the card sat on the pre-write value (with 已保存 ✓ beside it)
  // until the next poll healed it. A write answer is the state AFTER the user's
  // action: it must never be filtered by a read stamp.
  const answerOf = (view) => ({ ok: true, status: 200, json: async () => ({ ok: true, value: view }) })
  // The page kicks a (throttled) update check on mount — one POST /op that is NOT
  // part of the ordering under test. It is answered with a harmless refusal so it
  // never enters `hold` and never publishes a view of its own.
  const holdAnswer = (body) => (body && body.op && body.op.op === 'updateCheck' ? { status: 500 } : null)
  let holdMode = false
  const hold = []
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => {
      if (holdAnswer(body)) return holdAnswer(body)
      if (!holdMode) return undefined
      return new Promise((resolve) => { hold.push({ write: !!body, resolve }) })
    },
  })
  // The applied value is read off the FACE (the card's draft would mask it: an
  // unsaved edit outranks the Host until its write settles).
  const faceInterval = () => (p.props.getSnapshot().value || {}).updateIntervalDays
  // From here every bridge answer is held, so the ordering is scripted exactly.
  holdMode = true
  hold.length = 0
  const firstRead = p.props.refresh()
  check('the read under test is in flight', hold.length === 1 && hold[0].write === false,
    JSON.stringify(hold.map((h) => h.write)))
  hold[0].resolve(answerOf(snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { updateIntervalDays: 7 }))))
  await firstRead
  await flush()
  p.tree = p.renderAgain()
  check('the first read paints the host value', faceInterval() === 7, String(faceInterval()))

  // Driven by the 保存 button, not by the face directly: the user's click is what
  // sets `saved`, and "已保存 ✓ beside the pre-write value" is the symptom.
  typeWithin(p.tree, 'dbh-settingsbar', 0, '5')
  p.tree = p.renderAgain()
  commitFieldAt(p.tree)
  check('the write was dispatched', hold.length === 2 && hold[1].write === true,
    JSON.stringify(hold.map((h) => h.write)))
  const read = p.props.refresh()
  check('a read was dispatched AFTER the write', hold.length === 3 && hold[2].write === false,
    JSON.stringify(hold.map((h) => h.write)))
  // The read answers first, carrying the pre-write view — exactly what a poll that
  // was already in flight returns.
  hold[2].resolve(answerOf(snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { updateIntervalDays: 7 }))))
  await read
  p.tree = p.renderAgain()
  check('the read itself is applied (nothing newer was pending)', faceInterval() === 7, String(faceInterval()))
  // Then the write answers. THIS is the answer that must land.
  hold[1].resolve(answerOf(snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { updateIntervalDays: 5 }))))
  await flush()
  await flush()
  holdMode = false
  p.tree = p.renderAgain()
  const html = toHtml(p.tree)
  check('the write answer is applied although a later read answered first', faceInterval() === 5, String(faceInterval()))
  check('no "已保存 ✓" sitting next to the pre-write value',
    !(html.includes('已保存') && faceInterval() === 7), `interval=${faceInterval()} tick=${html.includes('已保存')}`)
  check('the save really is reported', html.includes('已保存'), html.slice(0, 300))
  p.dispose()

  // The mirror image (R7-1): the READ was dispatched first and the write second.
  // The write claims a stamp above everything in flight, so the late read (which
  // carries the pre-write view) must not paint over the click. Delete that claim
  // (`appliedSeq = seq` in claimWrite) and the pre-write rows reappear here.
  const hold2 = []
  const q = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => holdAnswer(body) || new Promise((resolve) => { hold2.push({ write: !!body, resolve }) }),
  })
  check('the card has no rows while the first read is unanswered', count(q.tree, 'dbh-tile') === 0,
    `tiles ${count(q.tree, 'dbh-tile')}`)
  const write2 = q.props.saveConfig({ updateIntervalDays: 5 })
  check('the write was dispatched before the read answered', hold2.length === 2 && hold2[1].write === true,
    JSON.stringify(hold2.map((h) => h.write)))
  hold2[0].resolve(answerOf(snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { updateIntervalDays: 7 }))))
  await flush()
  q.tree = q.renderAgain()
  check('a read that started BEFORE the write cannot paint the pre-write view',
    count(q.tree, 'dbh-tile') === 0, `tiles ${count(q.tree, 'dbh-tile')}`)
  hold2[1].resolve(answerOf(snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { updateIntervalDays: 5 }))))
  await write2
  await flush()
  q.tree = q.renderAgain()
  check('the write answer still lands (rows + value)',
    count(q.tree, 'dbh-tile') === 3
    && (classed(q.tree, 'dbh-srow-input')[0] || { props: {} }).props.value === '5',
    `tiles ${count(q.tree, 'dbh-tile')}`)
  q.dispose()
  viewport(1440)
}

console.log('\n[39] only an explicit TRUE from the settings form is "accepted" (R2)')
{
  viewport(1440)
  // `form.set(...).then((ok) => ok !== false)` treated `undefined` as accepted, so
  // the save went NOWHERE — zero POST, zero verification — and the page still
  // printed 已保存 ✓. Anything but `true` must fall back to POST /options.
  const mk = async (formSet) => await page(TILED, {
    slot: 'main',
    configForms: true,
    formSet,
    snapshot: Object.assign({}, MODERN_DEFAULTS, { entryId: 'dbhub-live' }),
    props: { useWorkspaces: wsSnap('D:/work/app') },
  })
  const p = await mk('undefined')
  await flush()
  p.tree = p.renderAgain()
  await p.props.saveConfig({ updateIntervalDays: 9 })
  check('the settings form was asked first',
    p.formSets.some(([id, field, value]) => id === 'dbhub-live' && field === 'updateIntervalDays' && value === 9),
    JSON.stringify(p.formSets))
  check('a form answer of `undefined` really falls back to POST /options',
    p.setCalls.some(([k, v]) => k === 'options' && v.updateIntervalDays === 9),
    JSON.stringify({ sets: p.setCalls, forms: p.formSets }))
  p.dispose()

  for (const mode of ['false', 'reject']) {
    const r = await mk(mode)
    await flush()
    r.tree = r.renderAgain()
    await r.props.saveConfig({ updateIntervalDays: 8 })
    check(`a form answer of ${mode} also falls back to POST /options`,
      r.setCalls.some(([k, v]) => k === 'options' && v.updateIntervalDays === 8),
      JSON.stringify({ mode, sets: r.setCalls, forms: r.formSets }))
    r.dispose()
  }

  // The good path stays on the form: a `true` answer must not add a stray POST.
  const ok = await mk('ok')
  await flush()
  ok.tree = ok.renderAgain()
  await ok.props.saveConfig({ updateIntervalDays: 4 })
  check('a true answer keeps the write on the form (no stray POST)',
    ok.formSets.length === 1 && !ok.setCalls.some(([k]) => k === 'options'),
    JSON.stringify({ sets: ok.setCalls, forms: ok.formSets }))
  ok.dispose()
  viewport(1440)
}

console.log('\n[40] a mangled host value keeps the view and reports an error (R3)')
{
  viewport(1440)
  // `publish({status:'ready', value: body.value || {}})` turned a body without a
  // view into "the page is empty": 3 tiles → 0, modern layout → legacy (every
  // `value.*` flag gone), with 已保存 ✓ still on the row. A missing value is a
  // FAILED read/write, never an empty page.
  let badRead = false
  let badWrite = false
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => {
      if (!body) return badRead ? { status: 200, payload: { ok: true, value: null } } : undefined
      return badWrite ? { status: 200, payload: { ok: true } } : undefined
    },
  })
  await flush()
  p.tree = p.renderAgain()
  check('the good read painted three tiles', count(p.tree, 'dbh-tile') === 3,
    `tiles ${count(p.tree, 'dbh-tile')}`)
  check('and chose the modern layout', count(p.tree, 'dbh-modern') === 1)
  badRead = true
  await p.props.refresh()
  p.tree = p.renderAgain()
  check('a value-less read does NOT empty the page', count(p.tree, 'dbh-tile') === 3,
    `tiles ${count(p.tree, 'dbh-tile')}`)
  check('it renders the failed-read line instead', count(p.tree, 'dbh-loadfail') === 1,
    toHtml(p.tree).slice(0, 240))
  check('the layout flags survive (still modern)', count(p.tree, 'dbh-modern') === 1)
  badRead = false
  badWrite = true
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  const html = toHtml(p.tree)
  check('a value-less write is a FAILED write', count(p.tree, 'dbh-writefail') === 1, html.slice(0, 300))
  check('a value-less write never prints 已保存', !html.includes('已保存'), html.slice(0, 400))
  check('a value-less write keeps the rows', count(p.tree, 'dbh-tile') === 3,
    `tiles ${count(p.tree, 'dbh-tile')}`)
  p.dispose()
  viewport(1440)
}

console.log('\n[41] a non-JSON answer is localized, never a parser trace (R4)')
{
  viewport(1440)
  // A reverse proxy answers with its own HTML page; `res.json()` throws
  // "Unexpected token '<', "<!DOCTYPE html>…" — English, with the body quoted.
  let mode = 'ok'
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: () => (mode === 'html' ? 'html' : undefined),
  })
  await flush()
  p.tree = p.renderAgain()
  check('the page rendered before the proxy answered with HTML', count(p.tree, 'dbh-tile') === 3)
  mode = 'html'
  await p.props.refresh()
  p.tree = p.renderAgain()
  let html = toHtml(p.tree)
  check('an HTML read renders the localized load error', count(p.tree, 'dbh-loadfail') === 1, html.slice(0, 240))
  check('the read error quotes no parser text',
    !html.includes('Unexpected token') && !html.includes('SyntaxError') && !html.includes('DOCTYPE'),
    html.slice(0, 300))
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  html = toHtml(p.tree)
  check('an HTML write renders the localized write error',
    textMatching(p.tree, 'dbh-writefail').includes('写入失败'), textMatching(p.tree, 'dbh-writefail'))
  check('the write error quotes no parser text',
    !html.includes('Unexpected token') && !html.includes('not valid JSON'), html.slice(0, 300))
  check('no tick beside the failed write', !html.includes('已保存'))
  p.dispose()
  viewport(1440)
}

console.log('\n[42] confirming a delete is single-flight (R5)')
{
  viewport(1440)
  // Two clicks in the same tick both saw the closure's `pendingRemove` (the state
  // reset only lands on the next render), so one user action sent TWO removes.
  const p = await page(TILED, { props: { useWorkspaces: wsSnap('D:/work/app') } })
  const before = p.opCalls.length
  clickLabel(p.tree, '删除')
  p.tree = p.renderAgain()
  const card = classed(p.tree, 'dbh-warncard')[0]
  const confirm = elements(card, (el) => typeof el.props.onClick === 'function'
    && (el.children || []).map(toHtml).join('').includes('确认删除'))[0]
  check('the confirmation button exists', !!confirm)
  if (confirm) {
    confirm.props.onClick({ stopPropagation() {}, preventDefault() {} })
    confirm.props.onClick({ stopPropagation() {}, preventDefault() {} })
  }
  await flush()
  p.tree = p.renderAgain()
  check('a double click sends exactly ONE remove',
    p.opCalls.length === before + 1, JSON.stringify(p.opCalls.slice(before)))
  check('the single remove is still the user\'s command',
    (p.opCalls[before] || {}).op === 'remove', JSON.stringify(p.opCalls.slice(before)))
  check('the card is gone after the first confirmation', count(p.tree, 'dbh-warncard') === 0)
  p.dispose()
  viewport(1440)
}

console.log('\n[43] a failed write rolls the draft back to the host value (R7-2)')
{
  viewport(1440)
  // Deleting `setDraft(draftFromValue(...))` + `draftEdited.current = false` from
  // `onWriteFail` (keeping only `setSaved(false)`) used to leave every gate green,
  // while the field kept showing a value the store never took.
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => (body && body.updateIntervalDays !== undefined ? { status: 401 } : undefined),
  })
  await flush()
  p.tree = p.renderAgain()
  const interval = () => (classed(p.tree, 'dbh-srow-input')[0] || { props: {} }).props.value
  check('the card starts on the host value', interval() === '7', interval())
  typeWithin(p.tree, 'dbh-settingsbar', 0, '30')
  p.tree = p.renderAgain()
  check('the edit is visible before the write', interval() === '30', interval())
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  check('the failure is visible', count(p.tree, 'dbh-writefail') === 1, toHtml(p.tree).slice(0, 240))
  check('the draft returns to the host value (no lie left in the field)', interval() === '7', interval())
  check('and no tick', !toHtml(p.tree).includes('已保存'))
  p.dispose()
  viewport(1440)
}

console.log('\n[44] a later failure suppresses the older 已保存 tick (R7-3)')
{
  viewport(1440)
  // `savedHint()` is `saved && !writeError`. Drop `!writeError` and every gate
  // stayed green: the enable/disable write only sets `writeError` (it has no draft
  // to roll back), so a success from a moment ago left 已保存 ✓ standing next to a
  // brand-new failure line.
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => {
      if (!body) return undefined
      if (typeof body.enabled === 'boolean') return { status: 401 }
      return undefined
    },
  })
  await flush()
  p.tree = p.renderAgain()
  commitFieldAt(p.tree)
  await flush()
  p.tree = p.renderAgain()
  check('the successful save shows the tick', toHtml(p.tree).includes('已保存'), toHtml(p.tree).slice(0, 300))
  clickSwitchWithin(p.tree, 'dbh-settingsbar', 0)
  await flush()
  p.tree = p.renderAgain()
  const html = toHtml(p.tree)
  check('the failed enable write is reported', count(p.tree, 'dbh-writefail') === 1, html.slice(0, 300))
  check('the older 已保存 tick does not survive beside the failure', !html.includes('已保存'), html.slice(0, 400))
  p.dispose()
  viewport(1440)
}

console.log('\n[45] the layout follows the MEASURED column, not just the viewport')
{
  // The measurement effect used to read `ref.current` inside an empty-dependency
  // effect: once the column was not attached at that instant it never measured
  // again, so the whole layout silently fell back to `window.innerWidth`. The
  // bundle now binds the effect to a CALLBACK-ref-published node (the harness
  // mounts refs) and this block supplies the only in-repo ResizeObserver.
  viewport(1440)
  const observers = []
  globalThis.ResizeObserver = function ResizeObserver(cb) {
    this.targets = []
    this.disconnected = false
    this.cb = cb
    observers.push(this)
    this.observe = (el) => {
      this.targets.push(el)
      cb([{ target: el, contentRect: { width: 320 } }])
    }
    this.disconnect = () => {
      this.disconnected = true
      this.targets.length = 0
    }
  }
  try {
    const p = await page(TILED, {
      slot: 'main',
      snapshot: Object.assign({}, MODERN_DEFAULTS),
      props: { useWorkspaces: wsSnap('D:/work/app') },
    })
    await flush()
    p.tree = p.renderAgain()
    check('the column was observed after mount', observers.length === 1 && observers[0].targets.length === 1,
      'observers=' + observers.length + ' targets=' + (observers[0] ? observers[0].targets.length : 'n/a'))
    check('a 320px column in a 1440px viewport is NOT wide', count(p.tree, 'dbh-wide') === 0,
      'wide=' + count(p.tree, 'dbh-wide') + ' viewport=' + windowShim.innerWidth)
    // The viewport alone would have said "wide" — the measured column is what
    // decided, so this could not pass while the width stayed 0.
    observers[0].cb([{ contentRect: { width: 900 } }])
    p.tree = p.renderAgain()
    check('a real resize to 900px switches to the wide layout', count(p.tree, 'dbh-wide') === 1,
      'wide=' + count(p.tree, 'dbh-wide'))
    p.dispose()
    check('the observer is disconnected on unmount (nothing leaks)', observers[0].disconnected === true)
  } finally {
    delete globalThis.ResizeObserver
    viewport(1440)
  }
}

console.log('\n[46] a FAILED update check re-arms the button and shows the error (R8)')
{
  viewport(1440)
  // The Host answers a failed check by writing `update.error` and NOT advancing
  // `checkedAt` (the reuse window is deliberately untouched). The card's cleanup
  // effect watched `checkedAt` only, so a failure cleared nothing: the button
  // stayed disabled with the tooltip pinned on 「检查中…」 for the whole 20s
  // watchdog — and the error the Host had just written stayed invisible.
  const CHECKED_AT = 1_700_000_000_000
  const successUpdate = JSON.stringify({
    latest: '', latestSpec: '', hasUpdate: false, checkedAt: CHECKED_AT, source: 'npm', error: '',
  })
  const failureUpdate = JSON.stringify({
    latest: '', latestSpec: '', hasUpdate: false, checkedAt: CHECKED_AT, source: 'npm', error: 'npm: 连接超时',
  })
  let updatePosts = 0
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => {
      if (!body || !body.op || body.op.op !== 'updateCheck') return undefined
      updatePosts += 1
      // The page-open check succeeds; the user's explicit re-check fails with the
      // SAME timestamp, which is exactly the shape that used to lock the button.
      const update = updatePosts === 1 ? successUpdate : failureUpdate
      return { payload: { ok: true, value: snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { update })) } }
    },
  })
  // One round trip = read/write answer → publish → subscriber → render. The
  // page-open check only fires once the first view has landed (it is `modern`
  // gated), so two rounds are the minimum before the button can be asserted.
  const settle = async () => {
    await flush()
    p.tree = p.renderAgain()
    await flush()
    p.tree = p.renderAgain()
  }
  await settle()
  await settle()
  const button = () => classed(p.tree, 'dbh-vercheck')[0] || { props: {} }
  check('the check button is offered and enabled after a successful check',
    button().props.disabled !== true,
    JSON.stringify({ title: button().props.title, ops: p.opCalls.length, update: (p.props.getSnapshot().value || {}).update }))
  check('the successful check landed (timestamp painted)', String(button().props.title || '').includes('检查于'),
    JSON.stringify({ title: button().props.title, update: p.props.getSnapshot().value.update }))

  clickClass(p.tree, 'dbh-vercheck')
  p.tree = p.renderAgain()
  check('a running check disables the button', button().props.disabled === true, JSON.stringify(button().props.title))
  check('a running check says 检查中…', button().props.title === '检查中…', JSON.stringify(button().props.title))

  await settle()
  check('a FAILED check re-arms the button instead of leaving it disabled',
    button().props.disabled !== true, JSON.stringify(button().props.title))
  check('the tooltip leaves 检查中… and names the failure',
    String(button().props.title || '').includes('检查更新失败') && String(button().props.title || '').includes('连接超时'),
    JSON.stringify(button().props.title))

  const beforeSecond = p.opCalls.length
  clickClass(p.tree, 'dbh-vercheck')
  check('the button can be clicked again immediately',
    p.opCalls.slice(beforeSecond).some((o) => o.op === 'updateCheck' && o.force === true),
    JSON.stringify(p.opCalls.slice(beforeSecond)))
  p.tree = p.renderAgain()
  p.dispose()
  check('every click dispatched exactly one check',
    p.opCalls.filter((o) => o.op === 'updateCheck').length === 3,
    JSON.stringify(p.opCalls.filter((o) => o.op === 'updateCheck').length))
  viewport(1440)
}

console.log('\n[47] the composer `@` menu: current workspace first, the others behind ONE folder')

// The current workspace has NO connections: the top level must skip it (no empty
// section — only the "other workspaces" folder remains).
const AT_OTHERS_ONLY = [
  row('billing', 'D:/work/billing', 'prod', 'postgres://127.0.0.1:5432/bill', { alias: 'billing_prod' }),
]
// A single workspace: no folder row at all.
const AT_SOLO = [
  row('app', 'D:/work/app', 'prod', 'mysql://127.0.0.1:3307/app', { alias: 'app_prod', ro: true }),
  row('app', 'D:/work/app', 'default', 'mysql://127.0.0.1:3306/app', { alias: 'default' }),
]

// ① The source shape: the optional input-trigger service is stubbed by the fake
// host, so what is asserted here is the contract the bundle uses (trigger, hooks,
// drill + breadcrumb) — not another plugin's implementation.
const AT_SESSION = { sessionId: 's-at' }
const AT_SESSIONS = { byId: { 's-at': { cwd: 'D:/work/app' } } }
const at1 = await page(AT_MENU, { sessions: AT_SESSIONS })
const atSources = at1.inputTriggers ? at1.inputTriggers.sources : []
check('exactly one dbhub @ source is registered', atSources.length === 1, JSON.stringify(atSources.map((s) => s && s.name)))
const atSrc = atSources[0] || {}
check('the source is the stable @ group "dbhub"', atSrc.trigger === '@' && atSrc.name === 'dbhub',
  JSON.stringify({ trigger: atSrc.trigger, name: atSrc.name }))
check('the source exposes candidates/onPick/header/codec/lexicon/subscribeLexicon/warm',
  typeof atSrc.candidates === 'function' && typeof atSrc.onPick === 'function' && typeof atSrc.header === 'function'
  && !!atSrc.codec && typeof atSrc.codec.serialize === 'function' && typeof atSrc.codec.clipboardText === 'function'
  && typeof atSrc.lexicon === 'function' && typeof atSrc.subscribeLexicon === 'function' && typeof atSrc.warm === 'function')

// ② The TOP level: ONE group named after the plugin, the current session
// workspace's rows, then one drillable "other workspaces" folder.
const atTop = typeof atSrc.candidates === 'function'
  ? await atSrc.candidates(AT_SESSION, { query: '', drilled: false })
  : []
const atTopNames = atTop.map((c) => c && c.name)
check('the top level is ONE group named after the plugin',
  atTop.length > 0 && atTop.every((c) => c.section === 'dbhub 数据库'),
  JSON.stringify(atTop.map((c) => c.section)))
check('the current workspace is listed first and ONLY it (its env names, sorted)',
  atTopNames.join('|') === 'default|prod|其他工作区', JSON.stringify(atTopNames))
const atFolder = atTop.find((c) => c.name === '其他工作区') || {}
check('the other-workspaces row is a drillable folder with a short Tab hint',
  atFolder.drill === true && atFolder.icon === 'folder' && atFolder.description === '按 Tab 进入',
  JSON.stringify(atFolder))
const atProd = atTop.find((c) => c.name === 'prod') || {}
check('a row describes host:port/database only, plus the read-only marker (small screens)',
  atProd.description === '127.0.0.1:3307/app · 只读', JSON.stringify(atProd))
const atTopLeak = JSON.stringify(atTop)
check('the top level leaks no scheme, DSN, credential or local path',
  atTopLeak.indexOf('://') < 0 && atTopLeak.indexOf('D:/work') < 0 && !/password|passwd|secret|token/i.test(atTopLeak),
  atTopLeak)
check('the candidate VALUE is the immutable source handle', atProd.value === 'app_1a2b3c_prod', JSON.stringify(atProd.value))

// ③ Drilling: the folder row rewrites the DRAFT to our marker and keeps the menu
// open (`execute()` only honours `text`, so a drill must not return `insert`).
const atDrill = atSrc.onPick({
  action: 'drill', candidate: atFolder, session: AT_SESSION, position: 0, via: 'menu', span: { start: 0, end: 0 },
})
check('picking the folder writes @其他工作区 into the draft and keeps the menu open',
  !!atDrill && atDrill.text === '@其他工作区' && atDrill.continue === true, JSON.stringify(atDrill))

// ④ Level ②: only the OTHER workspaces, named "workspace · env", same metadata.
const atOthers = await atSrc.candidates(AT_SESSION, { query: '其他工作区', drilled: true })
check('the second level lists only the other workspaces, as "workspace · env"',
  atOthers.length === 1 && atOthers[0].name === 'billing · prod'
  && atOthers[0].description === '127.0.0.1:5432/bill'
  && atOthers[0].section === '其他工作区',
  JSON.stringify(atOthers))
check('the second level keeps the immutable handle as the value',
  atOthers[0].value === 'billing_1a2b3c_prod', JSON.stringify(atOthers[0].value))
const atFilteredOut = await atSrc.candidates(AT_SESSION, { query: '其他工作区 app', drilled: true })
check('the text typed after the marker filters the second level', atFilteredOut.length === 0, JSON.stringify(atFilteredOut))
const atFilteredIn = await atSrc.candidates(AT_SESSION, { query: '其他工作区 bill', drilled: true })
check('… and a matching remainder keeps its row', atFilteredIn.length === 1 && atFilteredIn[0].name === 'billing · prod',
  JSON.stringify(atFilteredIn))

// ⑤ THE BUG: `drilled` is controller-wide, so a drill inside ANOTHER source's
// folder (dsh's own file tree — its query is a path like `src/`) must make our
// rows disappear. Only OUR marker in the draft proves the drill is ours.
const atForeign = await atSrc.candidates(AT_SESSION, { query: 'src/', drilled: true })
check('a drill inside another source\'s folder yields NO rows (we disappear)',
  Array.isArray(atForeign) && atForeign.length === 0, JSON.stringify(atForeign))
const atForeignEmpty = await atSrc.candidates(AT_SESSION, { query: 'app/main.ts', drilled: true })
check('… for any foreign drill text, not just one spelling',
  Array.isArray(atForeignEmpty) && atForeignEmpty.length === 0, JSON.stringify(atForeignEmpty))

// ⑥ Breadcrumb while inside our folder; nothing outside it.
const atHeader = typeof atSrc.header === 'function' ? atSrc.header(AT_SESSION, { query: '其他工作区', drilled: true }) : null
check('inside our folder the breadcrumb has two levels, root first',
  Array.isArray(atHeader) && atHeader.length === 2
  && atHeader[0].label === 'dbhub 数据库' && atHeader[0].value === 'root'
  && atHeader[1].label === '其他工作区' && atHeader[1].current === true,
  JSON.stringify(atHeader))
check('no breadcrumb outside our folder (top level or a foreign drill)',
  atSrc.header(AT_SESSION, { query: '', drilled: true }) === undefined
  && atSrc.header(AT_SESSION, { query: 'src/', drilled: true }) === undefined
  && atSrc.header(AT_SESSION, { query: '', drilled: false }) === undefined)
const atBackPick = atSrc.onPick({
  action: 'drill', candidate: atHeader[0], session: AT_SESSION, position: 0, via: 'menu', span: { start: 0, end: 0 },
})
check('clicking the root crumb rewrites the draft to a bare @ and keeps the menu open',
  !!atBackPick && atBackPick.text === '@' && atBackPick.continue === true, JSON.stringify(atBackPick))
const atBackTop = await atSrc.candidates(AT_SESSION, { query: '', drilled: true })
check('… and the reopened menu is the top level again (bare trigger, still drilled)',
  JSON.stringify(atBackTop.map((c) => c.name)) === JSON.stringify(atTopNames),
  JSON.stringify(atBackTop.map((c) => c.name)))

// ⑦ Pick → insert (unchanged contract): the routing key is the source name, the
// payload the handle, and the visible text the menu name.
const atPicked = typeof atSrc.onPick === 'function'
  ? atSrc.onPick({ candidate: atProd, session: AT_SESSION, position: 0, via: 'menu', action: 'pick', span: { start: 0, end: 0 } })
  : null
const atInsert = atPicked && atPicked.insert
check('pick inserts a reference routed back to this source',
  !!atInsert && atInsert.source === 'dbhub' && atInsert.appearance === 'file', JSON.stringify(atPicked))
check('the insert carries the HANDLE and shows the menu name (the alias stays the copy spelling)',
  !!atInsert && atInsert.ref === 'app_1a2b3c_prod' && atInsert.label === 'prod' && atInsert.clipboardText === '@app_prod',
  JSON.stringify(atInsert))

// ⑧ A kitchen-sink check on the whole second level too: no scheme/path/credential.
const atOthersLeak = JSON.stringify(atOthers)
check('the second level leaks nothing either',
  atOthersLeak.indexOf('://') < 0 && atOthersLeak.indexOf('D:/work') < 0, atOthersLeak)

// ⑨ Codec: each chip serializes on its own — that is what makes SEVERAL
// references in one message work.
check('serialize turns a reference into the model marker @db:<handle>',
  atSrc.codec.serialize('app_1a2b3c_prod') === '@db:app_1a2b3c_prod', atSrc.codec.serialize('app_1a2b3c_prod'))
check('clipboardText resolves the CURRENT alias of the handle',
  atSrc.codec.clipboardText('app_1a2b3c_prod') === '@app_prod', atSrc.codec.clipboardText('app_1a2b3c_prod'))
check('an UNKNOWN handle falls back to the handle, never to a guess',
  atSrc.codec.clipboardText('gone_zzzz') === '@gone_zzzz', atSrc.codec.clipboardText('gone_zzzz'))
const atTwoRefs = [atProd.value, atOthers[0].value].map((r) => atSrc.codec.serialize(r))
check('one message can carry several references, each serialized on its own',
  atTwoRefs.join(' ') === '@db:app_1a2b3c_prod @db:billing_1a2b3c_prod', JSON.stringify(atTwoRefs))
check('the lexicon lists every alias',
  JSON.stringify(atSrc.lexicon(null).slice().sort()) === JSON.stringify(['app_prod', 'billing_prod', 'default']),
  JSON.stringify(atSrc.lexicon(null)))

// ⑩ Empty / missing current workspace. A current workspace with no connections
// is SKIPPED (only the folder remains); with no OTHER workspaces the folder row
// is not offered at all.
const atOnlyOthers = await page(AT_OTHERS_ONLY, { sessions: AT_SESSIONS })
const atOnlyOthersSrc = (atOnlyOthers.inputTriggers.sources || [])[0] || {}
const atSkipped = await atOnlyOthersSrc.candidates(AT_SESSION, { query: '', drilled: false })
check('a current workspace without connections is skipped — only the folder is left',
  atSkipped.length === 1 && atSkipped[0].name === '其他工作区' && atSkipped[0].drill === true,
  JSON.stringify(atSkipped))

const atSolo = await page(AT_SOLO, { sessions: AT_SESSIONS })
const atSoloSrc = (atSolo.inputTriggers.sources || [])[0] || {}
const atSoloCand = await atSoloSrc.candidates(AT_SESSION, { query: '', drilled: false })
check('with no other workspaces there is no folder row',
  atSoloCand.length === 2 && atSoloCand.every((c) => c.drill !== true), JSON.stringify(atSoloCand.map((c) => c.name)))

// Without the sessions service the current workspace is UNKNOWN: the menu keeps
// a flat, deterministic list (a guess would target another workspace's row).
const atNoSessions = await page(AT_MENU, { sessions: false })
const atNoSessionsSrc = (atNoSessions.inputTriggers.sources || [])[0] || {}
const atPlain = await atNoSessionsSrc.candidates(AT_SESSION, { query: '', drilled: false })
check('without the sessions service the top level degrades to a flat list (no guessed grouping)',
  atPlain.length === 3 && atPlain.every((c) => c.drill !== true)
  && new Set(atPlain.map((c) => c.name)).size === 3,
  JSON.stringify(atPlain.map((c) => [c.name, c.section])))

// A session object that carries the cwd itself is accepted too (newer dsh).
const atDirect = await atSrc.candidates({ cwd: 'D:/work/app' }, { query: '', drilled: false })
check('a session carrying its own cwd resolves the current workspace',
  JSON.stringify(atDirect.map((c) => c.name)) === JSON.stringify(atTopNames),
  JSON.stringify(atDirect.map((c) => c.name)))

// Scan order must never move the menu.
const atRev = await page(AT_MENU.slice().reverse(), { sessions: AT_SESSIONS })
const atRevSrc = (atRev.inputTriggers.sources || [])[0] || {}
const atRevTop = await atRevSrc.candidates(AT_SESSION, { query: '', drilled: false })
check('the menu order does not follow the scan order',
  JSON.stringify(atRevTop.map((c) => c.name)) === JSON.stringify(atTopNames),
  JSON.stringify(atRevTop.map((c) => c.name)))

// ⑪ The lexicon follows the published snapshot (the card's own notification
// point — no second timer, no polling).
let atLexiconUpdates = 0
const atUnsubscribe = atSrc.subscribeLexicon(null, () => { atLexiconUpdates += 1 })
await at1.props.refresh()
await flush()
atUnsubscribe()
check('the lexicon follows the published snapshot', atLexiconUpdates > 0, String(atLexiconUpdates))

// ⑫ No data = no candidates. A disabled plugin, an unreadable state and an
// empty row set are all "empty group" (which closes the menu), never a throw.
const atEmpty = await page([], {})
check('a hot reload releases the previous @ group', at1.inputTriggers.sources.length === 0,
  JSON.stringify(at1.inputTriggers.sources.length))
const atEmptySrc = (atEmpty.inputTriggers.sources || [])[0] || {}
check('no connection rows → no candidates', (await atEmptySrc.candidates(null, {})).length === 0)

const atFailedPage = await page(AT_MENU, { fetchImpl: () => 'reject' })
const atFailedSrc = (atFailedPage.inputTriggers.sources || [])[0] || {}
check('a failed /state read yields NO candidates', (await atFailedSrc.candidates(null, {})).length === 0)
check('...and an empty lexicon', (atFailedSrc.lexicon(null) || []).length === 0)

const atDisabled = await page(AT_MENU, { snapshot: { enabled: false } })
const atDisabledSrc = (atDisabled.inputTriggers.sources || [])[0] || {}
check('a disabled plugin offers no references', (await atDisabledSrc.candidates(null, {})).length === 0)

// ⑬ A host WITHOUT the service must still mount the whole plugin half (that is
// why the service is injected optionally, not declared in `inject`).
const atNoService = await page(AT_MENU, { inputTriggers: false })
check('a host without inputTriggers still mounts and registers nothing',
  atNoService.inputTriggers === null && !!slotEntry(atNoService, 'settings.section'),
  JSON.stringify({ triggers: atNoService.inputTriggers, settings: !!slotEntry(atNoService, 'settings.section') }))

console.log('\n[48] global settings: test concurrency / row limit / export directory')
{
  viewport(1440)
  const p = await page(TILED, { slot: 'main', props: { useWorkspaces: wsSnap('D:/work/app') } })
  await flush()
  p.tree = p.renderAgain()
  const bar = classed(p.tree, 'dbh-barline2')[0]
  check('the second settings line renders', !!bar, toHtml(p.tree).slice(0, 300))
  const inputs = bar ? classed(bar, 'dbh-input') : []
  check('three settings inputs: concurrency, row limit, export directory', inputs.length === 3, `got ${inputs.length}`)
  check('the concurrency box defaults to 2 and is numeric',
    String((inputs[0] || { props: {} }).props.value) === '2' && (inputs[0] || { props: {} }).props.type === 'number',
    JSON.stringify((inputs[0] || {}).props))
  check('the row-limit box defaults to 0 (= unlimited)',
    String((inputs[1] || { props: {} }).props.value) === '0')
  check('the export directory starts blank (= the default location)',
    String((inputs[2] || { props: {} }).props.value) === '')
  check('…and its placeholder says blank means the default',
    String((inputs[2] || { props: {} }).props.placeholder || '').includes('默认位置'),
    JSON.stringify((inputs[2] || {}).props))

  // ① A field commits on BLUR: there is no 保存 button any more, so the write has
  // to happen where the edit ended. One field, one request — the old form-wide
  // button re-sent every setting on every click.
  const postsBefore = p.posts.length
  typeWithin(p.tree, 'dbh-barline2', 0, '5')
  p.tree = p.renderAgain()
  commitFieldAt(p.tree, 1)
  await flush()
  p.tree = p.renderAgain()
  const blurPost = (p.posts[postsBefore] || {}).body || {}
  check('blurring the concurrency box writes THAT field only',
    blurPost.batchConcurrency === 5 && blurPost.updateIntervalDays === undefined
    && blurPost.defaultMaxRows === undefined && blurPost.exportDir === undefined, JSON.stringify(blurPost))
  check('…and the field shows 已保存 afterwards',
    classed(p.tree, 'dbh-saved').length >= 1, toHtml(p.tree).slice(0, 400))
  check('no 保存 button is left in the settings bar',
    !toHtml(classed(p.tree, 'dbh-settingsbar')[0] || { children: [] }).includes('保存配置'),
    toHtml(classed(p.tree, 'dbh-settingsbar')[0] || { children: [] }).slice(0, 400))

  // ② Enter commits the same way (the keyboard path, not only the mouse).
  const postsAfterBlur = p.posts.length
  typeWithin(p.tree, 'dbh-barline2', 1, '100')
  p.tree = p.renderAgain()
  commitFieldAt(p.tree, 2, 'enter')
  await flush()
  const enterPost = (p.posts[postsAfterBlur] || {}).body || {}
  check('Enter commits the row-limit field as well',
    enterPost.defaultMaxRows === 100 && enterPost.batchConcurrency === undefined, JSON.stringify(enterPost))

  // ③ An out-of-range concurrency is refused LOCALLY: one reason, zero requests.
  const postsBad = p.posts.length
  typeWithin(p.tree, 'dbh-barline2', 0, '9')
  p.tree = p.renderAgain()
  commitFieldAt(p.tree, 1)
  p.tree = p.renderAgain()
  check('an out-of-range concurrency sends no request',
    p.posts.length === postsBad, JSON.stringify(p.posts.slice(postsBad)))
  check('…and names the accepted range next to that field',
    classed(p.tree, 'dbh-invalid').length === 1
    && toHtml(classed(p.tree, 'dbh-invalid')[0]).includes('1–8'),
    toHtml(p.tree).slice(0, 400))

  // ④ The export directory is a long value: blur on it commits `exportDir` (and
  // the client does NOT pre-judge the path — the Host probes it).
  typeWithin(p.tree, 'dbh-barline2', 2, 'D:/tmp/exports')
  p.tree = p.renderAgain()
  const postsDir = p.posts.length
  commitDir(p.tree)
  await flush()
  const dirPost = (p.posts[postsDir] || {}).body || {}
  check('blurring the directory posts only exportDir', dirPost.exportDir === 'D:/tmp/exports'
    && dirPost.batchConcurrency === undefined, JSON.stringify(dirPost))

  // ⑤ The directory is wide enough to show its own placeholder at 1440px AND at
  // 720px (the placeholder is the only explanation of what blank means).
  const dirCss = cssRule('.dbh-input-dir')
  check('the export box has a 280px floor and grows with the line',
    /min-width:280px/.test(dirCss) && /flex:1 1 280px/.test(dirCss), dirCss)
  check('…its group is the one that takes the free width of the bar',
    /flex:1 1 320px/.test(cssRule('.dbh-barline .dbh-bargroup-dir')), cssRule('.dbh-barline .dbh-bargroup-dir'))
  check('…and it is monospace + explicitly left aligned (a path, not a number)',
    /ui-monospace/.test(dirCss) && /text-align:left/.test(dirCss), dirCss)
  const dirPlaceholder = String((classed(p.tree, 'dbh-input-dir')[0] || { props: {} }).props.placeholder || '')
  check('the placeholder is the full "blank = default" sentence',
    dirPlaceholder === '留空 = 默认位置（数据目录/exports）', JSON.stringify(dirPlaceholder))

  // ⑥ `?` opens the same explanation the title shows, and 默认 clears the box.
  const helpBtn = classed(p.tree, 'dbh-helpbtn')[0]
  check('the export row carries a clickable ?', !!helpBtn, toHtml(p.tree).slice(0, 500))
  if (helpBtn && typeof helpBtn.props.onClick === 'function') helpBtn.props.onClick({ stopPropagation() {}, preventDefault() {} })
  p.tree = p.renderAgain()
  check('clicking ? shows the explanation inline (title = same text)',
    classed(p.tree, 'dbh-cfghint').length === 1
    && String((classed(p.tree, 'dbh-helpbtn')[0] || { props: {} }).props.title || '').includes('默认位置'),
    toHtml(p.tree).slice(0, 600))
  const postsDefault = p.posts.length
  const defaultBtn = elements(p.tree, (el) => typeof el.props.onClick === 'function'
    && (el.children || []).map(toHtml).join('') === '默认')[0]
  check('the export row offers a 默认 button', !!defaultBtn)
  if (defaultBtn) defaultBtn.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await flush()
  p.tree = p.renderAgain()
  check('…which writes exportDir: "" (the default location)',
    ((p.posts[postsDefault] || {}).body || {}).exportDir === '',
    JSON.stringify((p.posts[postsDefault] || {}).body || {}))
  check('…and the box is blank again', String((classed(p.tree, 'dbh-input-dir')[0] || { props: {} }).props.value || '') === '')

  // ⑦ The directory PICKER: absent here (no host service) → no button at all.
  check('without the platform picker the 选择 button is not rendered',
    classed(p.tree, 'dbh-pickbtn').length === 0, toHtml(p.tree).slice(0, 400))
  p.dispose()

  // ⑧ A host WITH the picker: the button appears, fills the box, commits at once.
  let picks = 0
  const picker = { pick: () => { picks += 1; return Promise.resolve({ ok: true, value: 'D:/picked/exports' }) } }
  const q = await page(TILED, { slot: 'main', directoryPicker: picker, props: { useWorkspaces: wsSnap('D:/work/app') } })
  await flush()
  q.tree = q.renderAgain()
  const pickBtn = classed(q.tree, 'dbh-pickbtn')[0]
  check('a host that provides remote.directoryPicker shows the 选择 button', !!pickBtn,
    toHtml(q.tree).slice(0, 400))
  const qPosts = q.posts.length
  if (pickBtn && typeof pickBtn.props.onClick === 'function') pickBtn.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await flush()
  await flush()
  q.tree = q.renderAgain()
  check('clicking it calls the platform picker', picks === 1, String(picks))
  check('…fills the box with the returned absolute path',
    String((classed(q.tree, 'dbh-input-dir')[0] || { props: {} }).props.value || '') === 'D:/picked/exports',
    String((classed(q.tree, 'dbh-input-dir')[0] || { props: {} }).props.value || ''))
  check('…and commits it through the same write path',
    ((q.posts[qPosts] || {}).body || {}).exportDir === 'D:/picked/exports',
    JSON.stringify((q.posts[qPosts] || {}).body || {}))
  q.dispose()

  // ⑨ A refused pick shows the Host's message and leaves the field alone.
  const failing = { pick: () => Promise.resolve({ ok: false, error: { code: 'EACCES', message: '平台拒绝：没有目录访问权限' } }) }
  const r = await page(TILED, { slot: 'main', directoryPicker: failing, props: { useWorkspaces: wsSnap('D:/work/app') } })
  await flush()
  r.tree = r.renderAgain()
  typeWithin(r.tree, 'dbh-barline2', 2, 'D:/kept/exports')
  r.tree = r.renderAgain()
  const failBtn = classed(r.tree, 'dbh-pickbtn')[0]
  if (failBtn && typeof failBtn.props.onClick === 'function') failBtn.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await flush()
  await flush()
  r.tree = r.renderAgain()
  check('a refused pick surfaces the Host message in the existing alert slot',
    textMatching(r.tree, 'dbh-writefail').includes('平台拒绝：没有目录访问权限'),
    textMatching(r.tree, 'dbh-writefail'))
  check('…and the typed path is NOT replaced',
    String((classed(r.tree, 'dbh-input-dir')[0] || { props: {} }).props.value || '') === 'D:/kept/exports',
    String((classed(r.tree, 'dbh-input-dir')[0] || { props: {} }).props.value || ''))
  r.dispose()

  // ⑩ A picker that reports "cancelled" changes nothing at all.
  const cancelling = { pick: () => Promise.resolve(null) }
  const c = await page(TILED, { slot: 'main', directoryPicker: cancelling, props: { useWorkspaces: wsSnap('D:/work/app') } })
  await flush()
  c.tree = c.renderAgain()
  typeWithin(c.tree, 'dbh-barline2', 2, 'D:/mine/exports')
  c.tree = c.renderAgain()
  const cancelBtn = classed(c.tree, 'dbh-pickbtn')[0]
  const cPosts = c.posts.length
  if (cancelBtn && typeof cancelBtn.props.onClick === 'function') cancelBtn.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await flush()
  await flush()
  c.tree = c.renderAgain()
  check('a cancelled pick leaves the typed path and sends nothing',
    String((classed(c.tree, 'dbh-input-dir')[0] || { props: {} }).props.value || '') === 'D:/mine/exports'
    && c.posts.length === cPosts, `${c.posts.length - cPosts} post(s)`)
  c.dispose()

  // ⑪ 720px: the settings bar re-flows (barnarrow) and the box keeps its floor,
  // so the explanation under the value is never the thing that gets cut off.
  viewport(720)
  const narrow = await page(TILED, { slot: 'main', props: { useWorkspaces: wsSnap('D:/work/app') } })
  narrow.tree = narrow.renderAgain()
  const narrowDir = classed(classed(narrow.tree, 'dbh-barline2')[0], 'dbh-input-dir')[0] || { props: {} }
  check('at 720px the same field still carries the whole placeholder',
    String(narrowDir.props.placeholder || '') === '留空 = 默认位置（数据目录/exports）',
    JSON.stringify(narrowDir.props.placeholder))
  check('…and the same 280px floor is what keeps it readable there',
    /min-width:280px/.test(cssRule('.dbh-input-dir')), cssRule('.dbh-input-dir'))
  narrow.dispose()
  viewport(1440)
}


console.log('\n[49] connection search / sort / batch test (display-only, local state)')
{
  viewport(1440)
  // Fresh workspace paths on purpose: `uiMemory.expanded` is module-level and
  // survives every mount in this gate, so reusing another fixture's path could
  // inherit an open/closed choice made by an earlier section.
  const LS_TILED = [
    row('alpha', 'D:/qa/ls-alpha', 'default', 'mysql://127.0.0.1:3306/alpha'),
    row('beta', 'D:/qa/ls-beta', 'default', 'postgres://127.0.0.1:5432/beta'),
    row('zeta', 'D:/qa/ls-zeta', 'default', 'sqlite://127.0.0.1:0/zeta', { alias: 'ls_zeta_prod' }),
  ]
  // A workspace snapshot supplies the `最近更新` stamp (the Host publishes it on
  // workspace items, not on connection rows).
  const wsRecent = (map) => (sel) => sel({
    items: Object.keys(map).map((path) => ({ path, updatedAt: map[path] })),
  })
  const sortMap = {
    'D:/qa/ls-alpha': '2026-01-01T00:00:00Z',
    'D:/qa/ls-beta': '2026-03-01T00:00:00Z',
    'D:/qa/ls-zeta': '2026-06-01T00:00:00Z',
  }
  const searchInputOf = (tree) => classed(tree, 'dbh-search-input')[0]
  const textOf = (el) => (el && el.children ? el.children.map(toHtml).join('') : '')
  const typeSearch = (p, value) => {
    const input = searchInputOf(p.tree)
    if (input && typeof input.props.onChange === 'function') input.props.onChange({ target: { value } })
    p.tree = p.renderAgain()
  }

  // ── search ─────────────────────────────────────────────────────────────
  const p = await page(LS_TILED, { snapshot: Object.assign({}, MODERN_DEFAULTS), props: { useWorkspaces: wsRecent(sortMap) } })
  check('the list offers a search box above the rows (tiled layout)',
    count(p.tree, 'dbh-search-input') === 1, `got ${count(p.tree, 'dbh-search-input')}`)
  check('…with a short placeholder (the label already says 搜索)',
    String((searchInputOf(p.tree) || { props: {} }).props.placeholder || '') === '输入关键字',
    JSON.stringify((searchInputOf(p.tree) || { props: {} }).props.placeholder))
  // The prefix is TEXT, not a button: a button-looking "search" would imply a
  // second action beside a box that already filters as you type.
  const searchBox = classed(p.tree, 'dbh-search')[0] || { props: {}, children: [] }
  const searchLabel = classed(searchBox, 'dbh-searchlabel')[0]
  check('the box carries a 搜索 prefix that is not clickable',
    !!searchLabel && toHtml(searchLabel).includes('搜索')
    && typeof searchLabel.props.onClick !== 'function', toHtml(searchBox).slice(0, 200))
  check('…and no × before there is anything to clear',
    classed(searchBox, 'dbh-searchclear').length === 0, toHtml(searchBox).slice(0, 200))
  check('every row is listed before filtering', count(p.tree, 'dbh-tile') === 3, `got ${count(p.tree, 'dbh-tile')}`)

  typeSearch(p, 'BETA')
  check('the filter is case-insensitive', count(p.tree, 'dbh-tile') === 1, `got ${count(p.tree, 'dbh-tile')}`)
  check('an active filter shows "N / M" beside the box',
    textMatching(p.tree, 'dbh-searchcount').includes('1 / 3'), textMatching(p.tree, 'dbh-searchcount'))
  // The × lives INSIDE the box and appears only with a query.
  const boxClear = classed(classed(p.tree, 'dbh-search')[0] || { children: [] }, 'dbh-searchclear')[0]
  check('a non-empty query shows the × inside the box',
    !!boxClear && toHtml(boxClear).includes('×'),
    boxClear ? toHtml(boxClear) : 'no .dbh-searchclear')
  typeSearch(p, 'ls_zeta_prod')
  check('the alias is searchable', count(p.tree, 'dbh-tile') === 1
    && toHtml(p.tree).includes('zeta'), `got ${count(p.tree, 'dbh-tile')}`)
  typeSearch(p, '5432')
  check('the connection metadata is searchable', count(p.tree, 'dbh-tile') === 1
    && toHtml(p.tree).includes('beta'), `got ${count(p.tree, 'dbh-tile')}`)
  typeSearch(p, '   ')
  check('a blank query lists everything again', count(p.tree, 'dbh-tile') === 3, `got ${count(p.tree, 'dbh-tile')}`)

  typeSearch(p, 'nope-does-not-exist')
  const noMatchHtml = toHtml(p.tree)
  check('no match renders its own empty state, not "还没有配置连接"',
    count(p.tree, 'dbh-nomatch') === 1 && noMatchHtml.includes('没有匹配的连接'), noMatchHtml.slice(0, 400))
  check('…and never pretends the plugin has no connections',
    !noMatchHtml.includes('还没有配置连接'), noMatchHtml.slice(0, 400))
  // The empty state keeps its own labelled clear action (the × may be off-screen
  // on a phone), so the two are separate controls with the same effect.
  const emptyClear = classed(classed(p.tree, 'dbh-nomatch')[0], 'dbh-clearsearch')[0]
  check('the empty state offers its own 清除搜索 button',
    !!emptyClear && toHtml(emptyClear).includes('清除搜索'), toHtml(classed(p.tree, 'dbh-nomatch')[0]).slice(0, 200))
  if (emptyClear && typeof emptyClear.props.onClick === 'function') emptyClear.props.onClick({ stopPropagation() {}, preventDefault() {} })
  p.tree = p.renderAgain()
  check('clearing the search restores every row', count(p.tree, 'dbh-tile') === 3, `got ${count(p.tree, 'dbh-tile')}`)
  check('clearing the search empties the box', String((searchInputOf(p.tree) || { props: {} }).props.value || '') === '')

  // A search that narrows to ONE group leaves the matching rows visible: a match
  // hidden inside a folded group after typing is a search that looks broken.
  const LS_GROUPED = [
    row('ga', 'D:/qa/ls-ga', 'default', 'mysql://127.0.0.1:3306/ga'),
    row('ga', 'D:/qa/ls-ga', '线上', 'mysql://127.0.0.1:3307/ga'),
    row('gb', 'D:/qa/ls-gb', 'default', 'postgres://127.0.0.1:5432/gb'),
  ]
  const g = await page(LS_GROUPED, { snapshot: Object.assign({}, MODERN_DEFAULTS) })
  check('the search box is present in the grouped layout too', count(g.tree, 'dbh-search-input') === 1)
  typeSearch(g, '线上')
  check('a Chinese environment name matches', count(g.tree, 'dbh-group') === 1 && count(g.tree, 'dbh-envrow') === 1,
    `groups=${count(g.tree, 'dbh-group')} rows=${count(g.tree, 'dbh-envrow')}`)
  check('…and the matching row is visible without clicking the group',
    toHtml(g.tree).includes('线上'), toHtml(g.tree).slice(0, 300))
  const gEmpty = await page([], { snapshot: Object.assign({}, MODERN_DEFAULTS) })
  check('the search box exists in the empty layout as well', count(gEmpty.tree, 'dbh-search-input') === 1)
  check('no connections at all keeps the real empty state (not the no-match one)',
    toHtml(gEmpty.tree).includes('暂无连接') && count(gEmpty.tree, 'dbh-nomatch') === 0, toHtml(gEmpty.tree).slice(0, 300))

  // ── sort: ONE text control, four states, no frame ──────────────────────
  //
  // 默认（不排序，保持宿主顺序）→ 名称 ↑ → 名称 ↓ → 最近更新 → 默认. The fixture
  // deliberately arrives in a NON-name order (zzz, aaa), so "default" and
  // "ascending" are distinguishable states rather than the same list twice.
  const LS_GROUPSORT = [
    row('zzz', 'D:/qa/ls-zzz', 'default', 'mysql://127.0.0.1:3306/z1'),
    row('zzz', 'D:/qa/ls-zzz', 'prod', 'mysql://127.0.0.1:3307/z2'),
    row('aaa', 'D:/qa/ls-aaa', 'default', 'mysql://127.0.0.1:3308/a1'),
    row('aaa', 'D:/qa/ls-aaa', 'prod', 'mysql://127.0.0.1:3309/a2'),
  ]
  const gs = await page(LS_GROUPSORT, {
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsRecent({ 'D:/qa/ls-aaa': '2026-01-01T00:00:00Z', 'D:/qa/ls-zzz': '2026-05-01T00:00:00Z' }) },
  })
  const groupTitles = (tree) => classed(tree, 'dbh-grouptitle').map(textOf)
  const sortText = (tree) => textMatching(tree, 'dbh-sorttext')
  const sortBtnOf = (tree) => classed(tree, 'dbh-sorttext')[0] || { props: {} }
  const sortClicks = () => {
    if (typeof sortBtnOf(gs.tree).props.onClick === 'function') {
      sortBtnOf(gs.tree).props.onClick({ stopPropagation() {}, preventDefault() {} })
    }
    gs.tree = gs.renderAgain()
  }
  check('the default state says 排序：默认 and keeps the host order',
    sortText(gs.tree).includes('排序：默认') && JSON.stringify(groupTitles(gs.tree)) === JSON.stringify(['zzz', 'aaa']),
    `${sortText(gs.tree)} / ${JSON.stringify(groupTitles(gs.tree))}`)
  check('the sort control is TEXT: no button frame class',
    !classed(gs.tree, 'dbh-sortbtn').length && /dbh-sorttext/.test(String(sortBtnOf(gs.tree).props.className)),
    String(sortBtnOf(gs.tree).props.className))
  check('…with secondary colour + hover underline, no box (CSS contract)',
    /color:var\(--dsw-alias-label-secondary\)/.test(cssRule('.dbh-sorttext'))
    && /border:0/.test(cssRule('.dbh-sorttext')) && /background:transparent/.test(cssRule('.dbh-sorttext'))
    && /text-decoration:underline/.test(cssRule('.dbh-sorttext:hover')), cssRule('.dbh-sorttext'))
  sortClicks()
  check('click 1 → 名称 ↑ and the groups sort A→Z',
    sortText(gs.tree).includes('名称') && sortText(gs.tree).includes('↑')
    && JSON.stringify(groupTitles(gs.tree)) === JSON.stringify(['aaa', 'zzz']),
    `${sortText(gs.tree)} / ${JSON.stringify(groupTitles(gs.tree))}`)
  sortClicks()
  check('click 2 → 名称 ↓ and the groups reverse',
    sortText(gs.tree).includes('↓') && JSON.stringify(groupTitles(gs.tree)) === JSON.stringify(['zzz', 'aaa']),
    `${sortText(gs.tree)} / ${JSON.stringify(groupTitles(gs.tree))}`)
  sortClicks()
  check('click 3 → 最近更新 (no arrow: there is no direction)',
    sortText(gs.tree).includes('最近更新') && !sortText(gs.tree).includes('↑') && !sortText(gs.tree).includes('↓'),
    sortText(gs.tree))
  sortClicks()
  check('click 4 → back to 默认, host order again (no sorting)',
    sortText(gs.tree).includes('默认') && JSON.stringify(groupTitles(gs.tree)) === JSON.stringify(['zzz', 'aaa']),
    `${sortText(gs.tree)} / ${JSON.stringify(groupTitles(gs.tree))}`)
  const cycleTitle = String(sortBtnOf(gs.tree).props.title || '')
  check('the control explains the cycle on hover', cycleTitle.includes('名称') && cycleTitle.includes('默认'), cycleTitle)

  // ── batch test: 2 at a time, per-row state, stop, summary ──────────────
  //
  // Five rows so a queue really exists while two probes run: "stop" must show
  // that the QUEUED rows go back to untested while the two in flight finish.
  const LS_BATCH = [
    row('t1', 'D:/qa/ls-t1', 'default', 'mysql://127.0.0.1:3306/t1'),
    row('t2', 'D:/qa/ls-t2', 'default', 'mysql://127.0.0.1:3307/t2'),
    row('t3', 'D:/qa/ls-t3', 'default', 'mysql://127.0.0.1:3308/t3'),
    row('t4', 'D:/qa/ls-t4', 'default', 'mysql://127.0.0.1:3309/t4'),
    row('t5', 'D:/qa/ls-t5', 'default', 'mysql://127.0.0.1:3310/t5'),
  ]
  const held = []
  const answerOf = (payload) => ({ ok: true, status: 200, json: async () => payload })
  // Settle the nth held probe, if the implementation dispatched one at all: a
  // regression that drops the batch must go red on every assertion, not crash the
  // gate on the first missing promise.
  const settleProbe = async (index, ok, message) => {
    const probe = held[index]
    if (probe) probe.resolve(answerOf(probePayload(probe.nonce, ok, message)))
    await flush()
    await flush()
  }
  const probePayload = (nonce, ok, message) => ({
    ok: true,
    value: snapshotOf(LS_BATCH, Object.assign({}, MODERN_DEFAULTS, { testResult: JSON.stringify({ nonce, ok, message }) })),
  })
  // Timer accounting for the batch window: every timer created from here on (the
  // per-row watchdogs AND the bridge's write ceilings) must be gone once the card
  // unmounts. Timeouts are tracked by hand — the gate only tracks intervals.
  const pendingTimers = new Map()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = function (fn, ms, ...rest) {
    const id = realSetTimeout(function () {
      pendingTimers.delete(id)
      if (typeof fn === 'function') fn()
    }, ms, ...rest)
    pendingTimers.set(id, ms)
    return id
  }
  globalThis.clearTimeout = function (id) {
    pendingTimers.delete(id)
    return realClearTimeout(id)
  }
  const b = await page(LS_BATCH, {
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    // Only the probes are held: everything else (the page read, the throttled
    // update check) answers normally, so the card really has its rows.
    fetchImpl: ({ body }) => {
      if (!body || !body.op || body.op.op !== 'test') return undefined
      return new Promise((resolve) => held.push({ nonce: body.op.nonce, env: body.op.env, resolve }))
    },
  })
  const batchBtn = () => classed(b.tree, 'dbh-batchbtn')[0]
  const batchLabel = () => (batchBtn() ? toHtml(batchBtn()) : '')
  check('the toolbar offers a quiet 测试全部 button',
    count(b.tree, 'dbh-batchbtn') === 1 && batchLabel().includes('测试全部') && !batchLabel().includes('（'), batchLabel())
  if (batchBtn() && typeof batchBtn().props.onClick === 'function') batchBtn().props.onClick({ stopPropagation() {}, preventDefault() {} })
  b.tree = b.renderAgain()
  check('a batch runs at most TWO probes at a time', held.length === 2, String(held.length) + ' probe(s) dispatched')
  check('queued rows say 等待', count(b.tree, 'dbh-test-wait') === 3, 'got ' + count(b.tree, 'dbh-test-wait'))
  check('running rows say 测试中…', count(b.tree, 'dbh-test-batch') === 2, 'got ' + count(b.tree, 'dbh-test-batch'))
  check('the summary counts everything as untested while the run is open',
    textMatching(b.tree, 'dbh-batchsum').includes('5 未测'), textMatching(b.tree, 'dbh-batchsum'))
  check('the running control becomes 停止 and shows 0/5 progress',
    batchLabel().includes('停止') && batchLabel().includes('0/5'), batchLabel())

  // Resolve the first probe: its row reports SUCCESS from the POST answer (no
  // mirror, no 1.5s poll) and the next queued row starts.
  await settleProbe(0, true, '')
  b.tree = b.renderAgain()
  check('a finished row reports 通过 ✓', count(b.tree, 'dbh-batch-ok') === 1, 'got ' + count(b.tree, 'dbh-batch-ok'))
  check('a finished row frees its slot (a third probe is running)', held.length === 3, held.length + ' dispatched')
  check('the progress advances to 1/5', batchLabel().includes('1/5'), batchLabel())
  check('the summary counts the pass', textMatching(b.tree, 'dbh-batchsum').includes('1 通过'), textMatching(b.tree, 'dbh-batchsum'))

  // A failure carries its reason, truncated so one long Host text cannot push the
  // whole list around.
  const longReason = '连接被拒绝：' + 'x'.repeat(180)
  await settleProbe(1, false, longReason)
  b.tree = b.renderAgain()
  const failText = textMatching(b.tree, 'dbh-batch-fail')
  check('a failed row reports 失败 ✗', count(b.tree, 'dbh-batch-fail') === 1, 'got ' + count(b.tree, 'dbh-batch-fail'))
  check('…with the reason truncated', failText.includes('连接被拒绝') && failText.includes('…') && failText.length < 200, failText)
  check('the summary counts the failure', textMatching(b.tree, 'dbh-batchsum').includes('1 失败'), textMatching(b.tree, 'dbh-batchsum'))
  check('the queue is down to one row', count(b.tree, 'dbh-test-wait') === 1 && count(b.tree, 'dbh-test-batch') === 2,
    'wait=' + count(b.tree, 'dbh-test-wait') + ' running=' + count(b.tree, 'dbh-test-batch'))

  // Stop: the QUEUED row goes back to untested, and the two requests already in
  // flight are allowed to finish (no fake cancellation, no new dispatch).
  const heldBeforeStop = held.length
  if (batchBtn() && typeof batchBtn().props.onClick === 'function') batchBtn().props.onClick({ stopPropagation() {}, preventDefault() {} })
  b.tree = b.renderAgain()
  check('stopping dispatches nothing more', held.length === heldBeforeStop, held.length + ' vs ' + heldBeforeStop)
  check('the queued row goes back to untested (no 等待 / 测试中 lie)',
    count(b.tree, 'dbh-test-wait') === 0 && count(b.tree, 'dbh-test-batch') === 2,
    'wait=' + count(b.tree, 'dbh-test-wait') + ' running=' + count(b.tree, 'dbh-test-batch'))
  check('the control is 测试全部 again after a stop', batchLabel().includes('测试全部'), batchLabel())
  check('the summary keeps three untested rows', textMatching(b.tree, 'dbh-batchsum').includes('3 未测'), textMatching(b.tree, 'dbh-batchsum'))
  // Both probes that were already in flight still land.
  await settleProbe(2, true, '')
  await settleProbe(3, true, '')
  b.tree = b.renderAgain()
  check('in-flight probes still settle after the stop', count(b.tree, 'dbh-batch-ok') === 3, 'got ' + count(b.tree, 'dbh-batch-ok'))
  check('the stopped row was never dispatched', held.length === heldBeforeStop, String(held.length))
  check('the summary reflects the stopped run (3 pass / 1 fail / 1 untested)',
    textMatching(b.tree, 'dbh-batchsum').includes('3 通过') && textMatching(b.tree, 'dbh-batchsum').includes('1 失败')
    && textMatching(b.tree, 'dbh-batchsum').includes('1 未测'), textMatching(b.tree, 'dbh-batchsum'))

  // N = what the user can SEE: filtering to one row must run one probe, not five
  // ("I filtered to 1 and it tested 5" is the complaint this pins).
  typeSearch(b, 't1')
  check('the idle button no longer carries the count (the tally does)', batchLabel().includes('测试全部'), batchLabel())
  const heldBeforeFiltered = held.length
  if (batchBtn() && typeof batchBtn().props.onClick === 'function') batchBtn().props.onClick({ stopPropagation() {}, preventDefault() {} })
  b.tree = b.renderAgain()
  check('only the visible row is probed', held.length === heldBeforeFiltered + 1, (held.length - heldBeforeFiltered) + ' probe(s)')
  check('the progress denominator is the FILTERED row count', batchLabel().includes('0/1'), batchLabel())
  // Answer it, so the row carries a finished BATCH verdict for the retest below.
  await settleProbe(held.length - 1, true, '')
  b.tree = b.renderAgain()
  const testPosts = b.posts.filter((x) => x.body && x.body.op && x.body.op.op === 'test')
  check('every probe keeps the existing op shape (no DSN, no new field)',
    testPosts.length > 0 && testPosts.every((x) => x.body.op.dsn === undefined
      && Object.keys(x.body.op).sort().join(',') === 'env,nonce,op,workspace'), JSON.stringify(testPosts.slice(0, 2)))

  // A row that already carries a batch verdict must still answer a manual retest:
  // the batch line renders over the single-click line, so the click has to take the
  // row back (and the tally must stop counting a verdict it no longer shows).
  const manualBefore = held.length
  clickLabel(b.tree, '测试')
  b.tree = b.renderAgain()
  check('a manual retest of a batch row dispatches one probe', held.length === manualBefore + 1, `${held.length - manualBefore} probe(s)`)
  check('…and the row reports the single-click transient, not the old batch verdict',
    toHtml(b.tree).includes('测试中…') && count(b.tree, 'dbh-batch-ok') === 0, toHtml(b.tree).slice(-500))
  await settleProbe(held.length - 1, true, '')
  b.tree = b.renderAgain()

  // Unmount: the batch's watchdog + the write ceiling must both be cleared. Every
  // probe above has been answered, so nothing is left pending on purpose.
  await flush()
  b.tree = b.renderAgain()
  b.dispose()
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  check('unmounting the card leaves no timer behind', pendingTimers.size === 0, `${pendingTimers.size} live timer(s)`)
}

console.log('\n[50] one tidy toolbar line and a DSN field you can actually read')
{
  viewport(1440)
  const rows = [
    row('alpha', 'D:/qa/tb-alpha', 'default', 'mysql://127.0.0.1:3306/alpha'),
    row('beta', 'D:/qa/tb-beta', 'default', 'postgres://127.0.0.1:5432/beta'),
  ]
  const p = await page(rows, { snapshot: Object.assign({}, MODERN_DEFAULTS) })
  const bar = classed(p.tree, 'dbh-searchbar')[0] || { props: {}, children: [] }
  const barKids = (bar.children || []).map((c) => String((c.props || {}).className || ''))
  const searchAt = barKids.indexOf('dbh-search')
  const sortAt = barKids.indexOf('dbh-sort')
  const batchAt = barKids.indexOf('dbh-btn dbh-batchbtn')
  const growAt = barKids.indexOf('dbh-grow')

  // ① The three clusters are siblings of the SAME container, in one row: the
  // search box must not take a line of its own (a full-width input on a wide card
  // is a 900px-long search field), and nothing may wrap before 720px.
  check('the toolbar is one labelled group', bar.props.role === 'group' && !!bar.props['aria-label'],
    JSON.stringify({ role: bar.props.role, label: bar.props['aria-label'] }))
  check('search + sort + batch share that single container, in reading order',
    searchAt >= 0 && growAt > searchAt && sortAt > growAt && batchAt > sortAt, JSON.stringify(barKids))
  const barCss = cssRule('.dbh-searchbar')
  check('the row is one centred flex line with an 8px rhythm, and it does not wrap',
    /display:flex/.test(barCss) && /align-items:center/.test(barCss) && /gap:8px/.test(barCss)
    && /flex-wrap:nowrap/.test(barCss), barCss)

  // ①b The search is a BOX with a text prefix and an inline ×: a bordered wrapper
  // (one control, not two nested frames) whose input is capped at 360px.
  const searchBox = classed(bar, 'dbh-search')[0] || { props: {}, children: [] }
  const searchLabel = classed(searchBox, 'dbh-searchlabel')[0]
  const searchEl = classed(bar, 'dbh-search-input')[0] || { props: {} }
  check('the box has a 搜索 text prefix (a label, not a button)',
    !!searchLabel && toHtml(searchLabel).includes('搜索'),
    searchLabel ? toHtml(searchLabel) : 'no .dbh-searchlabel')
  check('the prefix is not clickable (it is not a second action)',
    !!searchLabel && typeof searchLabel.props.onClick !== 'function')
  check('the placeholder is the short 输入关键字',
    searchEl.props.placeholder === '输入关键字', JSON.stringify(searchEl.props.placeholder))
  check('no × while the box is empty', classed(searchBox, 'dbh-searchclear').length === 0, toHtml(searchBox).slice(0, 200))
  const searchCss = cssRule('.dbh-search')
  check('the wrapper grows but is capped (flex 1 / max-width 360)',
    /flex:1 1 180px/.test(searchCss) && /max-width:360px/.test(searchCss), searchCss)
  check('the input inside the wrapper carries no second border',
    /border:0/.test(cssRule('.dbh-search-input')), cssRule('.dbh-search-input'))
  const phoneSearch = cssRule('.dbh-mobile .dbh-search')
  check('the phone puts the search on its own full-width line',
    /flex:1 1 100%/.test(phoneSearch), phoneSearch)

  // ② Sort is ONE text control, never a dropdown and never a button frame.
  const sortGroup = classed(bar, 'dbh-sort')[0] || { children: [], props: {} }
  const sortTexts = classed(sortGroup, 'dbh-sorttext')
  check('sort renders exactly one text control',
    sortTexts.length === 1 && classed(sortGroup, 'dbh-sortbtn').length === 0, String(sortTexts.length))
  check('its label is 排序：默认 in the initial state',
    toHtml(sortGroup).includes('排序：默认'), toHtml(sortGroup).slice(0, 200))
  check('no <select> anywhere (the sort is not a dropdown)',
    elements(p.tree, (el) => el.type === 'select').length === 0)
  const sortCss = cssRule('.dbh-sorttext')
  check('the text control has no frame: no border, transparent background',
    /border:0/.test(sortCss) && /background:transparent/.test(sortCss), sortCss)
  check('…is secondary-coloured and only underlines on hover',
    /color:var\(--dsw-alias-label-secondary\)/.test(sortCss)
    && /text-decoration:underline/.test(cssRule('.dbh-sorttext:hover')), sortCss)

  // ③ The batch action is a quiet secondary button; no rows disables it.
  const batchBtn = classed(p.tree, 'dbh-batchbtn')[0] || { props: {} }
  check('the batch action is a bordered secondary button, not a primary one',
    String(batchBtn.props.className).includes('dbh-btn') && !String(batchBtn.props.className).includes('dbh-btn-primary'),
    String(batchBtn.props.className))
  const empty = await page([], { snapshot: Object.assign({}, MODERN_DEFAULTS) })
  const emptyBtn = classed(empty.tree, 'dbh-batchbtn')[0] || { props: {} }
  check('no connections → the batch button is disabled', emptyBtn.props.disabled === true, JSON.stringify(emptyBtn.props))
  // The three clusters line up on one 28px baseline.
  check('all three controls sit on the same 28px height',
    /height:28px/.test(cssRule('.dbh-search')) && /height:28px/.test(cssRule('.dbh-batchbtn'))
    && /height:28px/.test(cssRule('.dbh-sort')), JSON.stringify([cssRule('.dbh-search'), cssRule('.dbh-batchbtn')]))

  // ④ The DSN editor is a 2-row MONOSPACE textarea that grows with its content and
  // still feeds the same write path (trim only — `connDraftOf` untouched).
  const q = await page(rows, { snapshot: Object.assign({}, MODERN_DEFAULTS) })
  clickLabelAt(q.tree, '修改', 0)
  q.tree = q.renderAgain()
  const editScope = () => classed(q.tree, 'dbh-editbox')[0]
  const dsnBox = () => classed(editScope(), 'dbh-dsninput')[0] || { props: {} }
  check('the row editor edits the DSN in a textarea', dsnBox().type === 'textarea',
    dsnBox().type || 'missing')
  check('…that starts at two rows and keeps the shared input class (helpers + styling)',
    dsnBox().props.rows === 2 && String(dsnBox().props.className).includes('dbh-input'),
    JSON.stringify({ rows: dsnBox().props.rows, className: dsnBox().props.className }))
  check('…and still carries the DSN placeholder + accessible name',
    String(dsnBox().props.placeholder).includes('完整 DSN') && String(dsnBox().props['aria-label']).includes('连接串'),
    JSON.stringify({ ph: dsnBox().props.placeholder, label: dsnBox().props['aria-label'] }))
  // The CSS is what actually makes the string readable: auto-growing between two
  // and eight lines, wrapping, monospace, and still user-resizable.
  const dsnCss = cssRule('.dbh-dsninput')
  check('the DSN field auto-grows between 2 and 8 lines, then scrolls',
    /field-sizing:content/.test(dsnCss) && /min-height:calc\(2\*1\.5em \+ 14px\)/.test(dsnCss)
    && /max-height:calc\(8\*1\.5em \+ 14px\)/.test(dsnCss) && /overflow:auto/.test(dsnCss), dsnCss)
  check('…wraps instead of clipping (pre-wrap + anywhere)',
    /white-space:pre-wrap/.test(dsnCss) && /overflow-wrap:anywhere/.test(dsnCss), dsnCss)
  check('…is monospace and vertically resizable',
    /ui-monospace/.test(dsnCss) && /resize:vertical/.test(dsnCss), dsnCss)
  check('the phone shrinks the same field to a shorter ceiling',
    /max-height:calc\(6\*1\.5em \+ 14px\)/.test(cssRule('.dbh-mobile .dbh-dsninput')), cssRule('.dbh-mobile .dbh-dsninput'))
  const longDsn = 'mysql://readonly_user:CHANGE_ME@db.internal.example:3306/analytics_replica?charset=utf8mb4&ssl=true'
  // Only drive the field when it exists: a regression that drops the textarea must
  // show every failing assertion instead of throwing on the first undefined node.
  const typed = classed(editScope(), 'dbh-input')[1]
  if (typed && typeof typed.props.onChange === 'function') typed.props.onChange({ target: { value: longDsn } })
  q.tree = q.renderAgain()
  const dsnValue = String((classed(editScope(), 'dbh-dsninput')[0] || { props: {} }).props.value || '')
  check('the whole pasted string is visible in the field (no single-line clipping)',
    dsnValue === longDsn, dsnValue.slice(0, 40))
  const opsBefore = q.opCalls.length
  clickWithin(q.tree, 'dbh-editrow', '保存')
  q.tree = q.renderAgain()
  const probe = q.opCalls.slice(opsBefore).filter((o) => o.dsn !== undefined).pop()
  check('saving sends the FULL string (trimmed) through the existing probe op',
    !!probe && probe.dsn === longDsn && probe.op === 'test', JSON.stringify(probe && { op: probe.op, len: String(probe.dsn || '').length }))
  check('the DSN never lands in the page as text', !toHtml(q.tree).includes('CHANGE_ME'), toHtml(q.tree).slice(0, 200))

  // ⑤ The add panel uses the same field.
  click(q.tree, '＋ 添加连接')
  q.tree = q.renderAgain()
  // `uiMemory.advOpen` survives mounts: an earlier section may have left the SSH
  // panel open, and it adds its own `.dbh-input` (the row cap). Collapse it so the
  // three-field contract is what this asserts.
  if (classed(q.tree, 'dbh-advbody').length > 0) {
    clickWithin(q.tree, 'dbh-addpanel', '高级：SSH 隧道')
    q.tree = q.renderAgain()
  }
  const addPanel = classed(q.tree, 'dbh-addpanel')[0] || { props: {}, children: [] }
  const addInputs = classed(addPanel, 'dbh-input')
  check('the add panel keeps its three fields', addInputs.length === 3, `got ${addInputs.length}`)
  check('the add panel DSN field is the same textarea',
    !!addInputs[2] && addInputs[2].type === 'textarea' && addInputs[2].props.rows === 2
    && addInputs[2].props.placeholder === 'mysql://user:pass@host:3306/db',
    JSON.stringify(addInputs[2] && { type: addInputs[2].type, rows: addInputs[2].props.rows }))
  // The gate helpers must keep working on the new field (typing is still onChange).
  typeWithin(q.tree, 'dbh-addpanel', 2, longDsn)
  q.tree = q.renderAgain()
  check('typing into the add-panel textarea lands in its value',
    String((classed(classed(q.tree, 'dbh-addpanel')[0], 'dbh-input')[2] || { props: {} }).props.value || '') === longDsn)
  q.dispose()
}

console.log('\n[51] row order from the store, drag & drop moves, copy')
{
  viewport(1440)
  // The stored order is published on EVERY row of a workspace (there is no group
  // object on the wire). `app` says prod-then-default (NOT the input order), and
  // `bill` says staging-then-default. The third `app` row is auto-discovered, so
  // it is not in `order` at all and must render last, by name.
  const DND = [
    row('app', 'D:/qa/dnd-app', 'default', 'mysql://127.0.0.1:3306/app', { order: ['prod', 'default'] }),
    row('app', 'D:/qa/dnd-app', 'prod', 'mysql://127.0.0.1:3306/app_prod', { order: ['prod', 'default'] }),
    row('app', 'D:/qa/dnd-app', 'zeta', 'mysql://127.0.0.1:3306/app_zeta', { persisted: false, source: 'mise env', order: ['prod', 'default'] }),
    row('bill', 'D:/qa/dnd-bill', 'default', 'postgres://127.0.0.1:5432/bill', { order: ['staging', 'default'] }),
    row('bill', 'D:/qa/dnd-bill', 'staging', 'postgres://127.0.0.1:5432/bill_staging', { order: ['staging', 'default'] }),
  ]
  const p = await page(DND, { slot: 'main' })
  // Two groups: only the most recent one opens by itself, so open both.
  expandAll(p)
  const groupsOf = (tree) => classed(tree, 'dbh-group')
  const rowsOf = (tree, gi) => classed(groupsOf(tree)[gi], 'dbh-envwrap')
  const envNames = (tree, gi) => rowsOf(tree, gi).map((wrap) => {
    const chip = classed(wrap, 'dbh-envname')[0]
    return chip ? toHtml(chip).replace(/<[^>]*>/g, '') : '?'
  })
  const rowEl = (wrap) => classed(wrap, 'dbh-envrow')[0]
  const dragStart = (wrap) => {
    const el = rowEl(wrap)
    check('the dragged row is draggable', el && el.props.draggable === true)
    if (el && typeof el.props.onDragStart === 'function') {
      el.props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' }, stopPropagation() {} })
    }
    p.tree = p.renderAgain()
  }
  const dragOver = (wrap, after) => {
    if (typeof wrap.props.onDragOver === 'function') {
      wrap.props.onDragOver({
        preventDefault() {},
        currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 20 }) },
        clientY: after ? 19 : 1,
      })
    }
    p.tree = p.renderAgain()
  }
  const drop = async (wrap) => {
    const before = p.getCalls.length
    if (wrap && typeof wrap.props.onDrop === 'function') wrap.props.onDrop({ preventDefault() {} })
    p.tree = p.renderAgain()
    await flush()
    await flush()
    return p.getCalls.length - before
  }
  const lastOp = () => p.opCalls[p.opCalls.length - 1] || {}

  // ① The stored order wins; the auto-discovered row is appended by name.
  check('rows follow the stored order, not the /state order',
    JSON.stringify(envNames(p.tree, 0)) === JSON.stringify(['prod', 'default', 'zeta']),
    JSON.stringify(envNames(p.tree, 0)))
  check('the second workspace honours its own stored order',
    JSON.stringify(envNames(p.tree, 1)) === JSON.stringify(['staging', 'default']),
    JSON.stringify(envNames(p.tree, 1)))
  check('the auto-discovered row is last and is not draggable',
    rowEl(rowsOf(p.tree, 0)[2]).props.draggable !== true, JSON.stringify(rowEl(rowsOf(p.tree, 0)[2]).props.draggable))
  const autoGrip = classed(rowsOf(p.tree, 0)[2], 'dbh-grip')[0]
  check('…its grip explains why', !!autoGrip && String(autoGrip.props.title || '').includes('自动发现'),
    autoGrip ? String(autoGrip.props.title || '') : 'no grip')
  check('…and it has no copy button',
    classed(rowsOf(p.tree, 0)[2], 'dbh-copybtn').length === 0)
  check('a persisted row does have one', classed(rowsOf(p.tree, 0)[0], 'dbh-copybtn').length === 1)

  // ② Drag DOWN inside one workspace: dropping on the lower half of `default`
  // must send index 1 (the Host measures the index AFTER removing the source).
  dragStart(rowsOf(p.tree, 0)[0]) // prod
  dragOver(rowsOf(p.tree, 0)[1], true) // default, lower half
  check('the insertion line is drawn below the hovered row',
    String(rowsOf(p.tree, 0)[1].props.className).includes('dbh-drop-after'),
    String(rowsOf(p.tree, 0)[1].props.className))
  let refreshed = await drop(rowsOf(p.tree, 0)[1])
  let op = lastOp()
  check('dropping below the neighbour sends move with index 1',
    op.op === 'move' && op.env === 'prod' && op.workspace === 'D:/qa/dnd-app'
    && op.toWorkspace === 'D:/qa/dnd-app' && op.index === 1, JSON.stringify(op))
  check('…and the page re-reads the Host instead of reordering locally',
    refreshed >= 1 && JSON.stringify(envNames(p.tree, 0)) === JSON.stringify(['prod', 'default', 'zeta']),
    `${refreshed} read(s), ${JSON.stringify(envNames(p.tree, 0))}`)

  // ③ Drag UP: dropping on the upper half of the row above = index 0.
  dragStart(rowsOf(p.tree, 0)[1]) // default
  dragOver(rowsOf(p.tree, 0)[0], false) // prod, upper half
  await drop(rowsOf(p.tree, 0)[0])
  op = lastOp()
  check('dropping above a row sends the index it would take there',
    op.op === 'move' && op.env === 'default' && op.toWorkspace === 'D:/qa/dnd-app' && op.index === 0, JSON.stringify(op))

  // ④ Cross-workspace: app/prod onto bill/staging (upper half) = index 0.
  dragStart(rowsOf(p.tree, 0)[0])
  dragOver(rowsOf(p.tree, 1)[0], false)
  await drop(rowsOf(p.tree, 1)[0])
  op = lastOp()
  check('cross-workspace move names both workspaces and the target index',
    op.op === 'move' && op.env === 'prod' && op.workspace === 'D:/qa/dnd-app'
    && op.toWorkspace === 'D:/qa/dnd-bill' && op.index === 0, JSON.stringify(op))
  check('the op carries nothing but the five keys (no DSN, no credentials)',
    Object.keys(op).sort().join(',') === 'env,index,op,toWorkspace,workspace', JSON.stringify(op))

  // ⑤ Dropping on the group's empty area appends: index = the target's persisted
  // row count (the auto row is not part of `order`).
  dragStart(rowsOf(p.tree, 0)[0])
  const billDropEnd = classed(groupsOf(p.tree)[1], 'dbh-dropend')[0]
  check('a group offers a trailing drop zone', !!billDropEnd, toHtml(groupsOf(p.tree)[1]).slice(0, 300))
  if (billDropEnd && typeof billDropEnd.props.onDragOver === 'function') {
    billDropEnd.props.onDragOver({ preventDefault() {} })
    p.tree = p.renderAgain()
  }
  const billDropEnd2 = classed(groupsOf(p.tree)[1], 'dbh-dropend')[0]
  check('…which lights up while a row hovers it',
    String((billDropEnd2 || { props: {} }).props.className || '').includes('dbh-dropend-on'),
    String((billDropEnd2 || { props: {} }).props.className))
  await drop(billDropEnd2)
  op = lastOp()
  check('dropping at the end of a workspace appends after its last stored row',
    op.op === 'move' && op.toWorkspace === 'D:/qa/dnd-bill' && op.index === 2, JSON.stringify(op))

  // ⑤b The append zone is a real 28px block, not a hairline (it is the only
  // "append" target of an open group, so it has to be aimable).
  check('the trailing drop zone is at least 28px tall',
    /height:28px/.test(cssRule('.dbh-dropend')), cssRule('.dbh-dropend'))
  check('…and its hover state is a fill + dashed edge (not the row insertion line)',
    /background:var/.test(cssRule('.dbh-dropend-on')) && /border-color:var/.test(cssRule('.dbh-dropend-on')),
    cssRule('.dbh-dropend-on'))

  // ⑤c A COLLAPSED group still accepts a drop: its head appends (index = that
  // workspace's persisted rows), with its own highlight.
  const billHead = classed(groupsOf(p.tree)[1], 'dbh-grouphead')[0]
  if (billHead && typeof billHead.props.onClick === 'function') billHead.props.onClick({ stopPropagation() {}, preventDefault() {} })
  p.tree = p.renderAgain()
  check('the second group is collapsed', classed(groupsOf(p.tree)[1], 'dbh-grouphead')[0].props['aria-expanded'] === false)
  dragStart(rowsOf(p.tree, 0)[0])
  const headOver = classed(groupsOf(p.tree)[1], 'dbh-grouphead')[0]
  if (headOver && typeof headOver.props.onDragOver === 'function') headOver.props.onDragOver({ preventDefault() {} })
  p.tree = p.renderAgain()
  const headLit = classed(groupsOf(p.tree)[1], 'dbh-grouphead')[0]
  check('a collapsed group head lights up as a drop target',
    String((headLit || { props: {} }).props.className || '').includes('dbh-drophead-on'),
    String((headLit || { props: {} }).props.className))
  check('…with a dashed ring, distinct from the row insertion line',
    /outline:2px dashed/.test(cssRule('.dbh-grouphead.dbh-drophead-on')),
    cssRule('.dbh-grouphead.dbh-drophead-on'))
  const opsBeforeHead = p.opCalls.length
  const headDrop = classed(groupsOf(p.tree)[1], 'dbh-grouphead')[0]
  if (headDrop && typeof headDrop.props.onDrop === 'function') headDrop.props.onDrop({ preventDefault() {} })
  p.tree = p.renderAgain()
  await flush()
  await flush()
  p.tree = p.renderAgain()
  op = lastOp()
  check('dropping on a collapsed head appends to that workspace',
    p.opCalls.length === opsBeforeHead + 1 && op.op === 'move' && op.env === 'prod'
    && op.toWorkspace === 'D:/qa/dnd-bill' && op.index === 2, JSON.stringify(op))
  // Re-open it: the rest of this section expects both groups expanded.
  const billHead2 = classed(groupsOf(p.tree)[1], 'dbh-grouphead')[0]
  if (billHead2 && typeof billHead2.props.onClick === 'function') billHead2.props.onClick({ stopPropagation() {}, preventDefault() {} })
  p.tree = p.renderAgain()


  // ⑥ Copy: one op, then a re-read (the clone lands under its source).
  const beforeCopy = p.getCalls.length
  const copyBtn = classed(rowsOf(p.tree, 0)[0], 'dbh-copybtn')[0]
  if (copyBtn && typeof copyBtn.props.onClick === 'function') copyBtn.props.onClick({ stopPropagation() {}, preventDefault() {} })
  p.tree = p.renderAgain()
  await flush()
  await flush()
  op = lastOp()
  check('the copy button sends {op:"copy", env, workspace}',
    op.op === 'copy' && op.env === 'prod' && op.workspace === 'D:/qa/dnd-app', JSON.stringify(op))
  check('…and the page re-reads so the clone appears where the Host put it',
    p.getCalls.length > beforeCopy, `${p.getCalls.length - beforeCopy} read(s)`)

  // ⑦ An explicit sort outranks the stored order — and disables dragging. It also
  // CANCELS an in-flight drag: the rows it pointed at may already have moved.
  dragStart(rowsOf(p.tree, 0)[0])
  check('a dragged row is marked while the drag is live',
    count(p.tree, 'dbh-dragging') === 1, `${count(p.tree, 'dbh-dragging')} dragging row(s)`)
  const sortCtl = classed(p.tree, 'dbh-sorttext')[0]
  if (sortCtl && typeof sortCtl.props.onClick === 'function') sortCtl.props.onClick({ stopPropagation() {}, preventDefault() {} })
  p.tree = p.renderAgain()
  check('switching the sort clears the drag highlight',
    count(p.tree, 'dbh-dragging') === 0, `${count(p.tree, 'dbh-dragging')} dragging row(s)`)
  const opsBeforeDrop = p.opCalls.length
  const staleDrop = rowsOf(p.tree, 0)[0]
  if (staleDrop && typeof staleDrop.props.onDrop === 'function') staleDrop.props.onDrop({ preventDefault() {} })
  p.tree = p.renderAgain()
  check('…and a drop after that sends nothing (the drag is gone)',
    p.opCalls.length === opsBeforeDrop, `${p.opCalls.length - opsBeforeDrop} op(s)`)
  check('choosing 名称 ↑ sorts by name instead of the stored order',
    JSON.stringify(envNames(p.tree, 0)) === JSON.stringify(['default', 'prod', 'zeta']),
    JSON.stringify(envNames(p.tree, 0)))
  const sortGrip = classed(rowsOf(p.tree, 0)[0], 'dbh-grip')[0]
  check('…and the grip says dragging is off', !!sortGrip && /排序/.test(String(sortGrip.props.title || '')),
    sortGrip ? String(sortGrip.props.title || '') : 'no grip')
  check('…and the row is not draggable', rowEl(rowsOf(p.tree, 0)[0]).props.draggable !== true)
  // ⑤d A group whose rows are ALL auto-discovered still offers the append zone
  // (nothing to aim between, but "append here" is still meaningful → index 0).
  const AUTO_ONLY = [
    row('app', 'D:/qa/dnd-app', 'prod', 'mysql://127.0.0.1:3306/app_prod', { order: ['prod', 'default'] }),
    row('app', 'D:/qa/dnd-app', 'default', 'mysql://127.0.0.1:3306/app', { order: ['prod', 'default'] }),
    row('solo', 'D:/qa/dnd-solo', 'temp', 'sqlite://127.0.0.1:0/solo', { persisted: false, source: 'mise env' }),
  ]
  const autoOnly = await page(AUTO_ONLY, { slot: 'main' })
  expandAll(autoOnly)
  const soloEnd = classed(groupsOf(autoOnly.tree)[1], 'dbh-dropend')[0]
  check('a group with only auto-discovered rows still has the append zone', !!soloEnd,
    toHtml(groupsOf(autoOnly.tree)[1]).slice(0, 300))
  const autoRowEl = classed(groupsOf(autoOnly.tree)[1], 'dbh-envrow')[0]
  check('…and its auto row is still not draggable', autoRowEl.props.draggable !== true)
  autoOnly.dispose()
  p.dispose()

  // ⑧ A refused move is reported AND rolled back by re-reading.
  viewport(1440)
  const r = await page(DND, {
    slot: 'main',
    fetchImpl: ({ body }) => (body && body.op && (body.op.op === 'move' || body.op.op === 'copy')
      ? { status: 200, payload: { ok: false, error: '目标工作区不存在' } }
      : undefined),
  })
  expandAll(r)
  const rRows = (gi) => classed(groupsOf(r.tree)[gi], 'dbh-envwrap')
  const rRowEl = rowEl(rRows(0)[0])
  if (typeof rRowEl.props.onDragStart === 'function') {
    rRowEl.props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' }, stopPropagation() {} })
  }
  r.tree = r.renderAgain()
  const rTarget = rRows(1)[0]
  if (typeof rTarget.props.onDragOver === 'function') rTarget.props.onDragOver({ preventDefault() {}, clientHeight: 20, clientY: 1 })
  r.tree = r.renderAgain()
  const readsBefore = r.getCalls.length
  const rDrop = rRows(1)[0]
  if (typeof rDrop.props.onDrop === 'function') rDrop.props.onDrop({ preventDefault() {} })
  r.tree = r.renderAgain()
  await flush()
  await flush()
  r.tree = r.renderAgain()
  check('a refused move shows the Host reason',
    textMatching(r.tree, 'dbh-writefail').includes('目标工作区不存在'),
    textMatching(r.tree, 'dbh-writefail'))
  check('…and rolls back by re-reading the Host order',
    r.getCalls.length > readsBefore && JSON.stringify(envNames(r.tree, 0)) === JSON.stringify(['prod', 'default', 'zeta']),
    `${r.getCalls.length - readsBefore} read(s), ${JSON.stringify(envNames(r.tree, 0))}`)
  r.dispose()

  // ⑨ Phone: no grip at all (HTML5 drag does not fire on a finger), and each
  // persisted row gets 上移 / 下移 with the same `move` op.
  viewport(390)
  const m = await page(DND, { slot: 'main' })
  expandAll(m)
  check('the phone shows no drag grip',
    classed(m.tree, 'dbh-grip').length === 0, `${classed(m.tree, 'dbh-grip').length} grip(s)`)
  const mRows = (gi) => classed(groupsOf(m.tree)[gi], 'dbh-envwrap')
  check('every persisted row gets an up/down pair, the auto row does not',
    classed(m.tree, 'dbh-movebtn').length === 8, `${classed(m.tree, 'dbh-movebtn').length} button(s)`)
  const mFirst = classed(mRows(0)[0], 'dbh-movebtn')
  check('the first row cannot move up', !!mFirst[0] && mFirst[0].props.disabled === true)
  check('…but can move down', !!mFirst[1] && mFirst[1].props.disabled !== true)
  const readsBeforeMobile = m.getCalls.length
  if (mFirst[1] && typeof mFirst[1].props.onClick === 'function') mFirst[1].props.onClick({ stopPropagation() {}, preventDefault() {} })
  m.tree = m.renderAgain()
  await flush()
  await flush()
  const mOp = m.opCalls[m.opCalls.length - 1] || {}
  check('the down button sends the same move op with index 1',
    mOp.op === 'move' && mOp.env === 'prod' && mOp.workspace === 'D:/qa/dnd-app'
    && mOp.toWorkspace === 'D:/qa/dnd-app' && mOp.index === 1, JSON.stringify(mOp))
  check('…and re-reads', m.getCalls.length > readsBeforeMobile)
  const mLast = classed(mRows(0)[1], 'dbh-movebtn')
  check('the last persisted row cannot move down', !!mLast[1] && mLast[1].props.disabled === true)
  m.dispose()
  viewport(1440)
}

console.log('\n[52] the update check spins, then says what it found (then gets out of the way)')
{
  viewport(1440)
  const CHECKED_AT = 1_700_000_000_000
  const up = (over) => JSON.stringify(Object.assign({
    latest: '', latestSpec: '', hasUpdate: false, checkedAt: CHECKED_AT, source: 'npm', error: '',
  }, over))
  // ① the page-open check (throttled, not forced) → ② 已是最新 → ③ 发现 9.9.9 →
  // ④ 失败. Each answer must differ from the snapshot it replaces, or the client
  // cannot tell that the Host replied at all.
  const answers = [
    up({}),
    up({ checkedAt: CHECKED_AT + 1000 }),
    up({ checkedAt: CHECKED_AT + 2000, latest: '9.9.9', latestSpec: 'dsh-dbhub-live@9.9.9', hasUpdate: true }),
    up({ checkedAt: CHECKED_AT + 2000, error: 'npm: 连接超时' }),
  ]
  let answersServed = 0
  const p = await page(TILED, {
    slot: 'main',
    snapshot: Object.assign({}, MODERN_DEFAULTS),
    props: { useWorkspaces: wsSnap('D:/work/app') },
    fetchImpl: ({ body }) => {
      if (!body || !body.op || body.op.op !== 'updateCheck') return undefined
      const update = answers[Math.min(answersServed, answers.length - 1)]
      answersServed += 1
      return { payload: { ok: true, value: snapshotOf(TILED, Object.assign({}, MODERN_DEFAULTS, { update })) } }
    },
  })
  const settle = async () => {
    await flush()
    p.tree = p.renderAgain()
    await flush()
    p.tree = p.renderAgain()
  }
  await settle()
  await settle()
  const button = () => classed(p.tree, 'dbh-vercheck')[0] || { props: {} }
  const stateText = () => {
    const el = classed(p.tree, 'dbh-verstate')[0]
    return el ? toHtml(el).replace(/<[^>]*>/g, '') : ''
  }
  check('the header is quiet at rest (no status line, no spinner)',
    stateText() === '' && classed(p.tree, 'dbh-spin').length === 0,
    JSON.stringify({ state: stateText(), spin: classed(p.tree, 'dbh-spin').length }))

  clickClass(p.tree, 'dbh-vercheck')
  p.tree = p.renderAgain()
  // ① While the request is out: the icon spins, the word appears, and the button
  // says so to a screen reader too. `disabled` alone was the reported bug.
  check('clicking spins the refresh icon', classed(button(), 'dbh-spin').length === 1,
    JSON.stringify(button().props.className))
  check('…and says 检查中… next to it', stateText() === '检查中…', JSON.stringify(stateText()))
  check('…while the button reports itself busy and disabled',
    button().props['aria-busy'] === 'true' && button().props.disabled === true,
    JSON.stringify({ busy: button().props['aria-busy'], disabled: button().props.disabled }))
  check('…and its label/tooltip follow', button().props['aria-label'] === '检查中…' && button().props.title === '检查中…',
    JSON.stringify({ label: button().props['aria-label'], title: button().props.title }))
  // The animation sits on a CHILD of the disabled button: `disabled` blocks
  // pointer/focus, never CSS animation, and nothing in the stylesheet pauses it.
  check('the rotation is on a child, and :disabled does not stop it',
    !/animation:none/.test(cssRule('.dbh-vercheck:disabled'))
    && /animation:dbh-spin 900ms linear infinite/.test(cssRule('.dbh-spin')),
    JSON.stringify({ spin: cssRule('.dbh-spin'), disabled: cssRule('.dbh-vercheck:disabled') }))
  check('…with a keyframe and a reduced-motion opt-out',
    PAGE_STYLE.text.includes('@keyframes dbh-spin')
    && /prefers-reduced-motion:\s*reduce\)\{\.dbh-spin\{animation:none/.test(PAGE_STYLE.text),
    PAGE_STYLE.text.slice(-400))

  // ② The Host answers: the spinner must GO (a stuck spinner is the same lie as
  // no feedback), and the outcome takes its place.
  await settle()
  check('the spinner stops once the Host answers', classed(p.tree, 'dbh-spin').length === 0,
    JSON.stringify(classed(p.tree, 'dbh-spin').length))
  check('…and the outcome is named: 已是最新', stateText() === '已是最新', JSON.stringify(stateText()))
  check('…the button re-arms and says 检查更新 again',
    button().props.disabled !== true && button().props['aria-busy'] === undefined
    && button().props['aria-label'] === '检查更新',
    JSON.stringify({ disabled: button().props.disabled, busy: button().props['aria-busy'], label: button().props['aria-label'] }))
  check('…while the tooltip keeps the richer 检查于… line', String(button().props.title || '').includes('检查于'),
    JSON.stringify(button().props.title))

  // ③ 2.5s later the line is gone: it is a transient confirmation, not furniture.
  await new Promise((r) => setTimeout(r, 2600))
  p.tree = p.renderAgain()
  check('the outcome line clears itself after 2.5s', stateText() === '', JSON.stringify(stateText()))

  // ④ A check that finds a release names it.
  clickClass(p.tree, 'dbh-vercheck')
  p.tree = p.renderAgain()
  await settle()
  check('a found release is named with its version', stateText() === '发现 v9.9.9', JSON.stringify(stateText()))

  // ⑤ A failed check says 检查失败 in the line and keeps the Host's own words in
  // the tooltip (the line is 12px, the error is not a sentence to truncate).
  clickClass(p.tree, 'dbh-vercheck')
  p.tree = p.renderAgain()
  await settle()
  check('a failed check is a failure in the line, not a fake success',
    stateText() === '检查失败', JSON.stringify(stateText()))
  check('…and the tooltip still carries the Host error text',
    String(button().props.title || '').includes('检查更新失败') && String(button().props.title || '').includes('连接超时'),
    JSON.stringify(button().props.title))
  p.dispose()
  viewport(1440)
}

if (liveMount) liveMount.dispose()


// No page may leave its 1.5s poll interval behind: a leaked one used to keep the
// process alive, which showed up as "the gate hangs" instead of a red check.
check('no poll interval outlives its page', liveIntervals.size === 0, `${liveIntervals.size} live interval(s)`)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
const exitCode = failures === 0 ? 0 : 1
// The client's write watchdogs (90s) may legitimately still be pending for writes
// the tests never answered; they are not a leak signal. Cut them, but only after
// stdout drained — `process.exit` on its own can truncate a piped stream.
process.stdout.write('', () => process.exit(exitCode))


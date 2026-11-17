// dsh-dbhub-live: the dsh-Go (Android app) native panel.
//
// Why this module exists: on a phone the plugin's own settings page is a web
// island (heavy, needs the bridge and a WebView), and dsh-Go's native surfaces
// are the cheap path. The app draws a panel from a JSON view tree plus a data
// model the Host pushes, and calls back into `panel(id, { actions })` when the
// user taps. Nothing here can carry a secret: the app's view protocol has no
// password component at all, so adding or editing a connection stays on the web
// page (which is exactly why dsh-Go shows 「在网页版设置」 for a plugin that
// registers `configure({ auto: false })`, which this plugin does).
//
// What the panel DOES do, and why each is safe:
//   · enable / disable the plugin — the one switch that a phone user needs when
//     the web page is out of reach, and it is reversible in one tap;
//   · change the five bounded settings that need no secret and no free text
//     (result row cap, parallel tests, update interval, sidebar entry, access
//     policy) — through the SAME validated write path the web card uses, so the
//     phone cannot invent a second one (see `commitOptionPatch` in index.mjs);
//   · probe a connection (`SELECT 1` through a throwaway dbhub, the same
//     machinery the card's ▶ uses) — read-only, zero side effects;
//   · show the effective options and every connection as METADATA.
//
// Two settings are deliberately NOT editable here: `exportDir` is free text
// whose save PROVES writability, and every connection field (DSN, username,
// password, SSH tunnel) is a secret. Both stay on the web page until dsh-Go
// gives a plugin a way to hand the app a secret-bearing field (it has none
// today: `role('secret')` is display-only and the view protocol has no password
// component) — the tracked request is in `.github/` of this repo's notes.
//
// Zero-knowledge is unchanged: the data model carries the alias, environment,
// workspace title, the `scheme://host:port/database` label (`connLabel`, whose
// whole userinfo section is already stripped), the read-only flag and the
// effective option values — never a DSN, a username or a password. The one
// identifier that travels with a tap (the workspace path) is already published
// to the browser half through `/state`.
//
// Dependency direction: this is a LEAF over `i18n.mjs` (both builtins-only).
// Everything else arrives through `deps`, so the module cannot form a cycle with
// mcp/config/index and stays unit-testable without a Host.

import { tFor } from './i18n.mjs'

/** The panel id. Also the `dshGo.contributes.panels[].id` in package.json. */
export const NATIVE_PANEL_ID = 'dbhub'

/**
 * Connection rows the view lists. The app truncates at 50 and the panel's byte
 * budget is 32 KiB; 20 keeps room for a "there are more" row and for long
 * workspace paths riding along in a row's tap arguments.
 */
export const MAX_ROWS = 20

/** Longest value a `keyValue` row shows before it is elided. */
const VALUE_CLIP = 48

/**
 * The settings this panel may CHANGE, as bounded choices.
 *
 * Every entry is a setting whose whole domain fits in eight options, so the v1
 * `options` component can express it as a tap (no text field, no secret, no
 * free-form path). The value a tap carries is the option value itself, encoded
 * as a string because that is what the component transports; `optionPatchOf`
 * decodes it back against this table, so an unknown value can never reach the
 * Host's validators.
 *
 * `labelKey`/`params` name the localized label of a choice; `text` is a literal
 * one (a bare number needs no translation).
 */
export const OPTION_CONTROLS = Object.freeze([
  {
    key: 'defaultMaxRows',
    labelKey: 'native.kMaxRows',
    choices: [
      { value: 0, labelKey: 'native.vUnlimited' },
      { value: 100, labelKey: 'native.vRows', params: { n: '100' } },
      { value: 500, labelKey: 'native.vRows', params: { n: '500' } },
      { value: 1000, labelKey: 'native.vRows', params: { n: '1,000' } },
      { value: 5000, labelKey: 'native.vRows', params: { n: '5,000' } },
    ],
  },
  {
    key: 'batchConcurrency',
    labelKey: 'native.kConcurrency',
    choices: [1, 2, 4, 8].map((value) => ({ value, text: String(value) })),
  },
  {
    key: 'updateIntervalDays',
    labelKey: 'native.kInterval',
    choices: [
      { value: 0, labelKey: 'native.vNever' },
      { value: 1, labelKey: 'native.vDays', params: { n: '1' } },
      { value: 3, labelKey: 'native.vDays', params: { n: '3' } },
      { value: 7, labelKey: 'native.vDays', params: { n: '7' } },
      { value: 14, labelKey: 'native.vDays', params: { n: '14' } },
      { value: 30, labelKey: 'native.vDays', params: { n: '30' } },
    ],
  },
  {
    key: 'showSidebarEntry',
    labelKey: 'native.kSidebar',
    choices: [
      { value: true, labelKey: 'native.vShown' },
      { value: false, labelKey: 'native.vHidden' },
    ],
  },
  {
    key: 'announceAccessPolicy',
    labelKey: 'native.kPolicy',
    choices: [
      { value: true, labelKey: 'native.vOn' },
      { value: false, labelKey: 'native.vOff' },
    ],
  },
])

/** The action id a control taps: `set.defaultMaxRows`. */
export function optionActionId(key) {
  return 'set.' + key
}

/** dsh-Go sends a BCP 47 tag (`zh-CN`, `en-US`); the dictionaries take `zh`/`en`. */
export function localeOf(caps) {
  const tag = caps && typeof caps.locale === 'string' ? caps.locale.toLowerCase() : ''
  return tag.startsWith('en') ? 'en' : 'zh'
}

function clip(text, max) {
  const s = String(text === undefined || text === null ? '' : text)
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function choiceLabel(t, choice) {
  if (typeof choice.text === 'string') return choice.text
  return t(choice.labelKey, choice.params)
}

/**
 * One connection as a `list` row.
 *
 * The tap tests the connection: it is the only action that needs no secret and
 * cannot change anything. The read-only flag is shown as TEXT (`trailing`), not
 * as colour alone — the app's icon set deliberately has no lock glyph, so a
 * colour-only distinction would read as noise.
 */
function rowOf(conn, t) {
  const alias = clip(conn.alias || conn.env || '', 40)
  const where = [conn.title, conn.conn].filter((x) => typeof x === 'string' && x.trim() !== '').join(' · ')
  // `ssh` in a summary row is the SECRET-FREE block (`{host,port,user,…}`) for a
  // tunnelled connection and `null` for a direct one — never a boolean.
  const viaSsh = !!conn.ssh && typeof conn.ssh === 'object'
  const subtitle = clip(viaSsh ? `${where} · ${t('native.viaSsh')}` : where, 120)
  const path = typeof conn.path === 'string' ? conn.path : ''
  const env = typeof conn.env === 'string' ? conn.env : ''
  const row = {
    title: alias,
    subtitle,
    trailing: conn.ro === true ? t('native.readonly') : t('native.writable'),
    icon: 'storage',
    ...(conn.ro === true ? { tone: 'good' } : {}),
  }
  // Only a connection the tap can actually address becomes tappable: a row whose
  // workspace cannot be named would invoke a probe that can never resolve.
  if (path) row.action = { id: 'test', args: { path, env } }
  return row
}

/**
 * The tapped choice for one setting, as a validated one-key patch.
 *
 * Returns `null` for anything that is not literally one of the choices this
 * module offered: the app transports a string, and a stale or forged value must
 * die here rather than reach `options.validatePatch` with a wrong type.
 */
export function optionPatchOf(key, raw) {
  const spec = OPTION_CONTROLS.find((c) => c.key === key)
  if (!spec) return null
  // The component transports a string; a number is tolerated because a Host-side
  // caller (a test, an older bridge) may hand one over. An ARRAY or an object
  // stringifies into a value it never offered (`[500]` → `'500'`), so the type
  // check comes first.
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const hit = spec.choices.find((c) => String(c.value) === String(raw))
  if (!hit) return null
  return { [spec.key]: hit.value }
}

/** The `selected` value per control: the matching choice, else '' (nothing lit). */
function selectionOf(source) {
  const sel = {}
  for (const spec of OPTION_CONTROLS) {
    const hit = spec.choices.find((c) => String(c.value) === String(source[spec.key]))
    // A stored value outside the offered set (an operator pinned 250, say) lights
    // nothing: pretending it is the nearest choice would misreport the state.
    sel[spec.key] = hit ? String(hit.value) : ''
  }
  return sel
}

/**
 * The panel's data model, already localised (each app locale gets its own feed,
 * so text never has to switch under a live view).
 *
 * @param input - `deps.snapshot()`: `state.snapshot()` + `options.snapshot()`
 *   FLATTENED (their key sets do not overlap), plus `rows` and `pluginVersion`.
 * @param locale - `'zh'` or `'en'`.
 * @returns a JSON-safe object the view binds to.
 */
export function panelData(input, locale) {
  const t = (key, params) => tFor(locale, key, params)
  const source = input && typeof input === 'object' ? input : {}
  const all = Array.isArray(source.rows) ? source.rows.filter((r) => r && typeof r === 'object') : []

  const rows = all.slice(0, MAX_ROWS).map((conn) => rowOf(conn, t))
  // An empty list renders the app's "no data yet" line, which does not say what
  // to do next. A single inert row is both the empty state and the overflow note,
  // so the view needs no conditional rendering (view v1 has none).
  if (rows.length === 0) {
    rows.push({ title: t('native.noConnections'), icon: 'storage', tone: 'muted' })
  } else if (all.length > MAX_ROWS) {
    rows.push({ title: t('native.moreConnections', { n: String(all.length - MAX_ROWS) }), tone: 'muted' })
  }

  const enabled = source.enabled === true
  const phase = typeof source.phase === 'string' ? source.phase : ''
  let statusText
  let statusTone
  if (!enabled) {
    statusText = t('native.statusDisabled')
    statusTone = 'warn'
  } else if (phase === 'error') {
    statusText = t('native.statusError', { msg: clip(source.lastError || '', 120) })
    statusTone = 'bad'
  } else {
    statusText = t('native.statusRunning', { n: String(all.length) })
    statusTone = 'info'
  }

  const exportDir = typeof source.exportDir === 'string' ? source.exportDir.trim() : ''
  // What is LEFT in the read-only block: the two settings the panel cannot own
  // (a probed directory path, the build) — the editable five are controls now.
  const settingRows = [
    [t('native.kExportDir'), exportDir ? clip(exportDir, VALUE_CLIP) : t('native.vDefaultDir')],
    [t('native.kVersion'), source.pluginVersion ? String(source.pluginVersion) : '—'],
  ]

  return {
    statusText,
    statusTone,
    rows,
    settingRows,
    sel: selectionOf(source),
    toggleLabel: enabled ? t('native.toggleDisable') : t('native.toggleEnable'),
  }
}

/**
 * The panel's view tree (protocol v1 components only — `stack`, `callout`,
 * `text`, `list`, `keyValue`, `options`, `actions` — so every app that draws a
 * panel at all draws this one).
 *
 * Structure only: every changing value is a binding into `panelData`, so a
 * connection appearing or a switch flipping is a small patch, not a new view.
 * The `options` choices are literal because the component requires an array —
 * their labels are localised here, at view() time, which is exactly once per
 * locale.
 */
export function panelView(scope, caps) {
  const locale = localeOf(caps)
  const t = (key, params) => tFor(locale, key, params)
  // The v1 `options` component has no label of its own (only the choice list), so
  // each setting's name travels as the `text` line directly above it.
  const controls = OPTION_CONTROLS.flatMap((spec) => [
    { type: 'text', text: t(spec.labelKey), tone: 'muted' },
    {
      type: 'options',
      id: optionActionId(spec.key),
      options: spec.choices.map((c) => ({ label: choiceLabel(t, c), value: String(c.value) })),
      selected: { $: 'data.sel.' + spec.key },
    },
  ])
  return {
    type: 'stack',
    title: t('native.panelTitle'),
    children: [
      { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
      { type: 'text', text: t('native.connections'), tone: 'muted' },
      { type: 'list', items: { $: 'data.rows' } },
      { type: 'text', text: t('native.settings'), tone: 'muted' },
      { type: 'keyValue', items: { $: 'data.settingRows' } },
      { type: 'text', text: t('native.editable'), tone: 'muted' },
      ...controls,
      { type: 'text', text: t('native.testHint'), tone: 'muted' },
      { type: 'text', text: t('native.webHint'), tone: 'muted' },
      {
        type: 'actions',
        items: [
          { label: { $: 'data.toggleLabel' }, icon: 'power', action: 'toggle' },
          { label: t('native.refresh'), icon: 'refresh', action: 'refresh' },
        ],
      },
    ],
  }
}

/**
 * The feed behind one open panel: emit immediately, walk only when nothing has
 * been discovered yet, then re-emit on every Host change (a state or option
 * write, or a finished discovery walk). Returns the cancel function the bridge
 * calls when the panel closes — no timer outlives it.
 */
export function panelFeed(scope, emit, caps, deps) {
  const locale = localeOf(caps)
  let stopped = false
  const push = () => {
    if (stopped) return
    try {
      emit(panelData(deps.snapshot(), locale))
    } catch (e) {
      // A throwing data function is a violation against the plugin; the panel
      // must instead keep the last good model and say nothing.
      logOnce('native-data', e)
    }
  }
  push()
  // The first open on a fresh Host has no connection rows yet; the cache marks
  // that state, so opening the panel triggers one walk instead of showing an
  // empty list forever. A DISABLED plugin is not walked: its tools are off, the
  // panel already says so, and a walk spawns `mise env` per workspace.
  try {
    const enabled = deps.snapshot().enabled === true
    if (enabled && typeof deps.hasRows === 'function' && deps.hasRows() !== true && typeof deps.refresh === 'function') {
      deps.refresh()
    }
  } catch (e) {
    /* a failed walk is reported through the state machine, not here */
  }
  let off = () => {}
  try {
    off = deps.subscribe(push) || off
  } catch (e) {
    logOnce('native-subscribe', e)
  }
  return () => {
    stopped = true
    try {
      off()
    } catch (e) {
      /* disposal is best effort */
    }
  }
}

// One warning per tag per process: a panel action that fails the same way on
// every tap must not flood the Host log.
const logged = new Set()

function logOnce(tag, error) {
  if (logged.has(tag)) return
  logged.add(tag)
  const message = String((error && error.message) || error || '')
  console.warn('[dsh-dbhub-live] dsh-Go 原生面板（' + tag + '）: ' + message.slice(0, 200))
}

/** Reset the once-per-tag log guard (unit tests). */
export function resetNativeLog() {
  logged.clear()
}

/**
 * Register the panel with the dsh-Go bridge.
 *
 * `ctx.inject(['dshGo'], …)` — never the top-level `inject` and never
 * `['dshGo?']`: the former keeps the plugin from starting on a Host without the
 * bridge, the latter is optional-dependency syntax cordis does not have, so the
 * callback would never run. On a Host without the bridge the injection simply
 * never fires and every other surface (tools, web card, HTTP bridge) works as
 * before.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ snapshot, subscribe, refresh, hasRows, setEnabled, setOption,
 *   testConnection }`.
 * @returns whether the panel was handed to the bridge.
 */
export function registerNativePanel(ctx, deps) {
  if (!ctx || typeof ctx.inject !== 'function') return false
  let registered = false
  try {
    ctx.inject(['dshGo'], (sctx) => {
      const go = sctx && sctx.dshGo
      if (!go || typeof go.panel !== 'function') return
      go.panel(NATIVE_PANEL_ID, {
        view: (scope, caps) => panelView(scope, caps),
        data: (scope, emit, caps) => panelFeed(scope, emit, caps, deps),
        actions: {
          toggle: (scope, event) => toggleAction(deps, event),
          refresh: (scope, event) => refreshAction(deps),
          test: (scope, event) => testAction(deps, event),
          // One action id per editable setting (`set.defaultMaxRows`, …): the v1
          // `options` component carries no static args, so the id is what names
          // the setting.
          ...Object.fromEntries(OPTION_CONTROLS.map((spec) => [
            optionActionId(spec.key),
            (scope, event) => optionAction(deps, spec.key, event),
          ])),
        },
      })
      registered = true
      console.log('[dsh-dbhub-live] dsh-Go 原生面板已注册: ' + NATIVE_PANEL_ID)
    })
  } catch (e) {
    // An injection that cannot be registered (a Host that predates the dshGo
    // service, a fiber that is not a plugin's) leaves every other surface alone.
    logOnce('native-register', e)
  }
  return registered
}

/** Flip the enable/disable toggle. Reversible in one tap; no secret involved. */
function toggleAction(deps, event) {
  const locale = localeOf({ locale: event && event.locale })
  const t = (key) => tFor(locale, key)
  try {
    const next = deps.snapshot().enabled !== true
    deps.setEnabled(next)
    return { toast: next ? t('native.enabledToast') : t('native.disabledToast') }
  } catch (e) {
    logOnce('native-toggle', e)
    return { toast: t('native.failedToast') }
  }
}

/** Re-walk the workspaces and let the app re-read the view. */
function refreshAction(deps) {
  try {
    if (typeof deps.refresh === 'function') deps.refresh()
  } catch (e) {
    logOnce('native-refresh', e)
  }
  return { refresh: true }
}

/**
 * Change one bounded setting from the phone.
 *
 * The write itself is the Host's (`deps.setOption`, which is the very function
 * `POST /options` calls: validate → apply → persist → push). This action only
 * decodes the tapped value and reports the truth: the app's `selected` state is
 * re-sent from the Host snapshot afterwards, so a refusal visibly snaps back
 * instead of leaving the phone claiming a value the Host never took.
 */
function optionAction(deps, key, event) {
  const locale = localeOf({ locale: event && event.locale })
  const t = (k, params) => tFor(locale, k, params)
  const value = event && event.value && typeof event.value === 'object' ? event.value.value : undefined
  // The app shows the tapped choice immediately (that is what `selected` means in
  // view v1), so EVERY exit — accepted or refused — re-sends the Host's real
  // selection. Without it a refused tap would leave the phone displaying a value
  // the Host never took.
  const selection = () => {
    try {
      return selectionOf(deps.snapshot() || {})
    } catch (e) {
      return undefined
    }
  }
  const patch = optionPatchOf(key, value)
  if (!patch) {
    logOnce('native-option-value', new Error('unknown value for ' + key))
    const sel = selection()
    return { ...(sel ? { patch: { sel } } : {}), toast: t('native.failedToast') }
  }
  let ok = false
  try {
    const res = typeof deps.setOption === 'function' ? deps.setOption(patch) : { ok: false }
    ok = res === undefined ? true : res.ok === true
    if (!ok && res && res.error) logOnce('native-option-write', new Error(String(res.error)))
  } catch (e) {
    logOnce('native-option-write', e)
  }
  const sel = selection()
  return {
    ...(sel ? { patch: { sel } } : {}),
    toast: ok ? t('native.savedToast') : t('native.failedToast'),
  }
}

/**
 * Probe one connection. A probe is a throwaway dbhub plus `SELECT 1`: it spawns
 * a process and can take tens of seconds on a tunnelled target, so it is a
 * DEFERRED effect (the app shows a pending state and executes the toast when the
 * result lands). Only data effects are allowed that late, and a toast is one.
 */
function testAction(deps, event) {
  const locale = localeOf({ locale: event && event.locale })
  const t = (key, params) => tFor(locale, key, params)
  const value = event && event.value && typeof event.value === 'object' ? event.value : {}
  const path = typeof value.path === 'string' ? value.path : ''
  const env = typeof value.env === 'string' ? value.env : ''
  if (!path) return { toast: t('native.testFail') }
  return {
    pending: { label: t('native.testing'), timeoutMs: 60000 },
    result: async (signal) => {
      let res
      try {
        res = await deps.testConnection(path, env, signal)
      } catch (e) {
        logOnce('native-test', e)
        return { toast: t('native.testFail') }
      }
      if (!res || res.ok !== true) {
        // The cause can run to paragraphs; the toast is capped at 40 characters,
        // so the phone gets the verdict and the Host log keeps the detail.
        if (res && res.message) console.warn('[dsh-dbhub-live] dsh-Go 连接测试失败: ' + String(res.message).slice(0, 200))
        return { toast: t('native.testFail') }
      }
      return { toast: t('native.testOk', { ms: String(Number(res.ms) || 0) }) }
    },
  }
}

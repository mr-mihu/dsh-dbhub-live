// Contract check for the hand-authored client bundle: the file must be a
// lazy-CJS registration the client module loader can serve and materialize,
// and it must keep the page layout contract (grouped accordion / flat tiles),
// the zero-knowledge surface and the configOp state machine intact.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

test('client bundle registers through window.__ModuleLoader__.load', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-dbhub-live"/)
})

test('client bundle factory is lazy CJS with module/exports boilerplate', () => {
  assert.match(source, /factory:\s*\(require\)\s*=>\s*\{/)
  assert.match(source, /var module = \{ exports: \{\} \};/)
  assert.match(source, /Object\.defineProperty\(exports, Symbol\.toStringTag, \{ value: "Module" \}\);/)
})

test('client bundle requires only baseline platform modules', () => {
  const requires = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
  assert.deepEqual(requires, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
})

test('client bundle exports name/inject/apply and returns module.exports', () => {
  assert.match(source, /exports\.name = name;/)
  assert.match(source, /exports\.inject = inject;/)
  assert.match(source, /exports\.apply = apply;/)
  assert.match(source, /return module\.exports;/)
  // The transport is NOT injected: injecting `settingsScope` (removed in 0.2.x)
  // would keep the whole browser half pending. Only `slots` is injected.
  assert.match(source, /var inject = \["slots"\];/)
  assert.doesNotMatch(source, /var inject = \[[^\]]*settingsScope/)
})

test('client bundle binds its host face through the plugin bridge only', () => {
  // dsh 0.1.x is no longer supported, so there is exactly one face: the plugin's
  // own authenticated bridge. The old `settingsScope` face must not come back.
  assert.match(source, /function httpFace\(\)/)
  assert.match(source, /var BRIDGE_BASE = "api\/dsh-dbhub-live";/)
  assert.match(source, /var face = httpFace\(\);/)
  assert.doesNotMatch(source, /legacyFace/)
  assert.doesNotMatch(source, /ctx\.get\("settingsScope"\)/)
})

test('client bundle writes options through the settings form when it can', () => {
  // `ctx.configForms.get(entryId).set(field, value)` — the entry id arrives in
  // the Host view. POST /options is the fallback (a deployment without the
  // settings client, or a form that does not accept the field).
  assert.match(source, /var saveOptions = function \(patch\) \{/)
  assert.match(source, /var forms = typeof ctx\.get === "function" \? ctx\.get\("configForms"\) : undefined;/)
  assert.match(source, /form = forms\.get\(entryId\);/)
  assert.match(source, /return form\.set\(key, raw\)\.then/)
  assert.match(source, /return post\("\/options", patch\);/)
  assert.match(source, /saveConfig: function \(patch\) \{ return saveOptions\(patch \|\| \{\}\); \},/)
})

test('client bundle accepts a settings-form write only on an explicit true', () => {
  // `ok !== false` read a `set()` that resolves `undefined` (several 0.2.x
  // builds) as accepted, so the save went NOWHERE — zero POST, zero verification —
  // while the page printed 已保存 ✓. Anything but `true` falls back to the bridge.
  assert.match(source, /return form\.set\(key, raw\)\.then\(function \(ok\) \{ return ok === true; \}/)
  assert.match(source, /if \(accepted !== true\) return post\("\/options", patch\);/)
})

test('client bundle keeps write answers out of the read watermark', () => {
  // Two watermarks: reads are ordered by `appliedSeq`, write answers by
  // `appliedWriteStamp`. One shared stamp let a read that answered first throw the
  // write's own answer away (写先发 → 读后发 → 读先回 → 写后回).
  assert.match(source, /var publishWrite = function \(stamp, next\) \{/)
  assert.match(source, /publishWrite\(mine, \{ status: "ready", value: body\.value \}\);/)
  // And a Host answer without a view is a FAILURE, never `value: {}` (R3).
  assert.match(source, /var isView = function \(v\) \{/)
  assert.match(source, /if \(!isView\(body\.value\)\) throw bridgeFail\(\);/)
  // A non-JSON answer is a transport failure, not a raw parser trace (R4).
  assert.match(source, /return Promise\.resolve\(\)\.then\(function \(\) \{ return res\.json\(\); \}\)\.then\(/)
})

test('client bundle bounds every write so a hung bridge cannot leave it pending', () => {
  // Without a ceiling a hung bridge (a proxy that accepts and never answers) left
  // every write pending FOREVER: no tick, no error, no retry — the click vanished.
  // The ceiling must be LONGER than the probe watchdogs: a `{op:'test'}` POST may
  // legitimately spend a whole SSH budget before it answers, and a write timeout
  // must never turn a healthy slow probe into a "failed save".
  assert.match(source, /var withWriteTimeout = function \(p\) \{/)
  assert.match(source, /return withWriteTimeout\(request\(path, \{/)
  const ms = (re) => Number((source.match(re) || [])[1])
  const write = ms(/var WRITE_TIMEOUT_MS = (\d+);/)
  const sshWatchdog = ms(/var PRETEST_WATCHDOG_SSH_MS = (\d+);/)
  assert.ok(Number.isFinite(write) && write > 0, `WRITE_TIMEOUT_MS not found (${write})`)
  assert.ok(write > sshWatchdog,
    `the write ceiling (${write}ms) must stay above the SSH probe watchdog (${sshWatchdog}ms)`)
})

test('client bundle registers the plugins.row.config page keyed to package#row', () => {
  // dsh 0.1.6 dropped settings.plugin.item; the plugin's own configuration now
  // lives on the Plugins page through the keyed plugins.row.config slot.
  assert.doesNotMatch(source, /settings\.plugin\.item/)
  assert.match(source, /slots\.inject\(SLOT/)
  assert.match(source, /var SLOT = "plugins\.row\.config";/)
  assert.match(source, /var SLOT_KEY = "dsh-dbhub-live#dbhub-live";/)
  assert.match(source, /name:\s*SLOT, key:\s*SLOT_KEY/)
})

test('client bundle renders both owner views (summary one-liner + page)', () => {
  assert.match(source, /var isPage = props\.view !== "summary";/)
  // The view is chosen at the RETURN, after every hook has run: an early return
  // for `summary` made the two views consume a different number of hooks, and
  // switching a mounted instance between them threw
  // "Rendered more hooks than during the previous render".
  assert.doesNotMatch(source, /if \(!isPage\)/)
  assert.match(source, /return isPage \? h\("div", \{ className: innerClass/)
  assert.match(source, /: summaryNode;/)
  assert.match(source, /h\("span", \{ className: "dbh-summary" \}/)
})

test('client bundle owns a Settings section (core shell, always available)', () => {
  assert.match(source, /slots\.inject\("settings\.section"/)
  assert.match(source, /name: "settings\.section",\s*\n\s*id: "dbhub"/)
  assert.match(source, /label: function \(\) \{ return t\("title"\); \}/)
  assert.match(source, /function ConfigPanel\(props\)/)
  // the settings section owns its scroll container; the Plugins row does not
  assert.match(source, /className: "dbh-wrap"/)
})

test('client bundle owns a sidebar entry gated by enabled AND the user switch', () => {
  assert.match(source, /slots\.inject\("sidebar\.panellist"/)
  assert.match(source, /name: "sidebar\.panellist",\s*\n\s*id: "dbhub"/)
  assert.match(source, /function PanelIcon\(props\)/)
  assert.match(source, /slots\.inject\("main"/)
  assert.match(source, /name: "main",\s*\n\s*key: "dbhub"/)
  // Two independent conditions: the user's "hide the shortcut" switch and the
  // plugin's enabled state. Hiding the entry is NOT disabling the plugin. An
  // UNKNOWN state (a read that has not answered, or one that failed) registers
  // nothing: `enabled` must be literally true, not "not false".
  assert.match(source, /return v\.enabled === true && v\.showSidebarEntry !== false;/)
  assert.match(source, /var syncSidebar = function/)
  assert.match(source, /face\.subscribe\(syncSidebar\)/)
  // The switch itself sits in the settings rows/bar and applies immediately.
  assert.match(source, /"row\.sidebar": "侧边栏入口"/)
  assert.match(source, /"row\.sidebar": "Sidebar entry"/)
  assert.match(source, /var toggleSidebar = function \(next\)/)
  assert.match(source, /props\.saveConfig\(\{ showSidebarEntry: next \}\);/)
  assert.match(source, /showSidebarEntry: draft\.showSidebarEntry !== false,/)
  // The settings section and the Plugins row never depend on either condition, so
  // no combination can lock the user out of the configuration.
  assert.match(source, /slots\.inject\("settings\.section"/)
  assert.match(source, /"cfg\.sidebarHint":/)
})

test('client bundle exposes the config editor (saveConfig + editable options)', () => {
  assert.match(source, /saveConfig:\s*function/)
  assert.match(source, /updateIntervalDays/)
  assert.match(source, /保存配置/)
  // the auto-install package is NOT a settings field anymore
  assert.doesNotMatch(source, /dbhubPackage/)
})

test('client bundle injects one scoped stylesheet built on theme tokens', () => {
  assert.match(source, /var STYLE_ID = "dsh-dbhub-live-style";/)
  assert.match(source, /function ensureStyle\(\)/)
  assert.match(source, /document\.getElementById\(STYLE_ID\)/)
  assert.match(source, /document\.createElement\("style"\)/)
  assert.match(source, /ensureStyle\(\);/)
  // tokens with neutral fallbacks so the page follows the active skin/theme
  assert.match(source, /--dsw-alias-bg-layer-2/)
  assert.match(source, /--dsw-alias-label-primary/)
  assert.match(source, /--dsw-alias-interactive-bg-hover/)
  assert.match(source, /--dsw-alias-state-error-primary/)
  assert.match(source, /--dsw-alias-state-success-tertiary/)
  assert.match(source, /--dsw-alias-border-l1/)
  assert.match(source, /\.dbh-btn:focus-visible/)
  assert.match(source, /\.dbh-grouphead:hover/)
})

test('client bundle decides the layout from the workspace×environment shape', () => {
  // Pure helpers: grouping by PATH (a title is not identity) and the
  // threshold-free mode decision (tiles when every workspace has one env).
  assert.match(source, /function groupRows\(rows\)/)
  assert.match(source, /function layoutModeOf\(groups\)/)
  assert.match(source, /if \(groups\[i\]\.envs\.length > 1\) return "grouped";/)
  assert.match(source, /return "tiled";/)
  assert.match(source, /return "empty";/)
  assert.match(source, /var key = String\(r\.path \|\| r\.title \|\| ""\);/)
  assert.match(source, /order\[j\]\.dup = titleCount\[order\[j\]\.title\] > 1;/)
})

test('client bundle folds workspaces per group, with click-to-expand groups', () => {
  assert.match(source, /var groupView = function \(g\)/)
  assert.match(source, /var toggleGroup = function \(g\)/)
  assert.match(source, /"aria-expanded": open/)
  assert.match(source, /className: "dbh-chev" \+ \(open \? " open" : ""\)/)
  assert.match(source, /t\("grp\.envs", \{ n: String\(g\.envs\.length\), m: String\(g\.saved\) \}\)/)
  // a lone workspace opens by itself; otherwise the most recently used one does
  assert.match(source, /if \(groups\.length === 1\) return true;/)
  assert.match(source, /function recentWorkspacePath\(snapshot\)/)
  assert.match(source, /return !!recentPath && samePath\(g\.path, recentPath\);/)
  assert.match(source, /typeof props\.useWorkspaces === "function"/)
  // expand/collapse-all is always available in grouped mode
  assert.match(source, /allOpen \? t\("btn\.collapseAll"\) : t\("btn\.expandAll"\)/)
})

test('client bundle tiles single-environment workspaces instead of folding them', () => {
  assert.match(source, /var tileView = function \(g\)/)
  assert.match(source, /className: "dbh-tiles"/)
  // The list renders the SEARCHED + SORTED groups (`sortRows` / `filterRows`);
  // the unfiltered `groups` stays the source of truth for the header count, the
  // add-form datalist and the collision check behind every write.
  assert.match(source, /visibleGroups\.map\(tileView\)/)
  // one row per connection: env chip + 🔒 metadata + actions
  assert.match(source, /var envRow = function \(w\)/)
  assert.match(source, /className: "dbh-envrow"/)
  assert.match(source, /className: "dbh-conn", title: w\.conn/)
  // where a connection came from is identical on almost every row, so it is a
  // tooltip on the environment chip — never an inline badge
  assert.match(source, /var originTitle = function \(w, base\)/)
  assert.match(source, /title: originTitle\(w, w\.env\)/)
  assert.match(source, /t\("ws\.source"\) \+ "：" \+ sourceLabelOf\(w, t\)/)
  assert.match(source, /if \(!w\.persisted\) text \+= " " \+ t\("ws\.autoHint"\);/)
  // the read-only flag is a per-row ATTRIBUTE that changes what a query may do,
  // so it has its own row control (the source is a tooltip, this is not)
  assert.match(source, /var envChip = function \(w\)/)
  assert.match(source, /var roChip = function \(w\)/)
  assert.match(source, /className: "dbh-rochip"/)
  assert.match(source, /if \(w\.ro === true\) text \+= " · " \+ t\("ro\.title"\);/)
  assert.match(source, /if \(w\.ssh\) text \+= " · " \+ t\("ro\.sshTitle"/)
  assert.doesNotMatch(source, /dbh-pill/)
})

test('client bundle localizes copy through ctx.locale (zh/en dictionaries)', () => {
  assert.match(source, /localeSvc\.register\(NS, \{ zh: LOCALE_ZH, en: LOCALE_EN \}\)/)
  assert.match(source, /face\.t = t|t: t,/)
  assert.match(source, /var LOCALE_ZH = \{/)
  assert.match(source, /var LOCALE_EN = \{/)
  assert.match(source, /"conn\.title": "连接"/)
  assert.match(source, /"conn\.title": "Connections"/)
  assert.match(source, /"btn\.addEnv": "＋ 环境"/)
  assert.match(source, /"btn\.addEnv": "＋ Environment"/)
  assert.match(source, /"dsh\.tooOld":/)
})

test('client bundle releases its locale dictionaries on disposal (hot reload)', () => {
  // The locale service refuses a namespace+locale it already owns, so a bundle
  // reload that kept its registration alive used to abort the whole plugin half
  // ("locale namespace dsh-dbhub-live already has locale zh").
  assert.match(source, /var localeDispose = null;/)
  assert.match(source, /localeDispose = localeSvc\.register\(NS, \{ zh: LOCALE_ZH, en: LOCALE_EN \}\);/)
  assert.match(source, /ctx\.effect\(function \(\) \{ return localeDispose; \}, "dsh-dbhub-live: locale dictionaries"\);/)
  // ... and a duplicate must degrade to the local dictionaries, never throw.
  assert.match(source, /locale namespace busy, falling back to local dictionaries/)
  assert.match(source, /function localTranslator\(localeSvc\)/)
  assert.match(source, /var t = localeOwned && localeSvc \? localeSvc\.bind\(NS\) : localTranslator\(localeSvc\);/)
})

test('client bundle hands a copied connection label over verbatim', () => {
  // Copying across the split label's flex boxes makes the browser insert a
  // separator ("…3306/ app" when pasted into a DSN field), so the label answers
  // the copy event itself with the exact metadata string.
  assert.match(source, /var onConnCopy = function \(w, e\)/)
  assert.match(source, /e\.clipboardData\.setData\("text\/plain", String\(w\.conn \|\| ""\)\)/)
  assert.match(source, /h\("span", \{ className: "dbh-conn", title: w\.conn, onCopy: function \(e\) \{ onConnCopy\(w, e\); \} \}/)
})

test('client bundle cannot dispatch a second pre-test while one is pending', () => {
  assert.match(source, /var pendingPretest = !!\(pretest && pretest\.pendingNonce\);/)
  assert.match(source, /disabled: pendingPretest,\s*\n\s*onClick: addDsn,/)
  assert.match(source, /disabled: pendingPretest,\s*\n\s*onClick: function \(\) \{ saveEdit\(w\); \},/)
})

test('client bundle asks before overwriting an existing environment', () => {
  // Writing into (or renaming onto) an environment that already has a connection
  // REPLACES it — the Host's setWorkspaceEnv is an unconditional store write, so
  // the page must ask before dispatching anything (it used to be silent).
  assert.match(source, /var ENV_NAME_MAX = 64;/)
  assert.match(source, /function normalizeEnvForCompare\(name\)/)
  assert.match(source, /function envCollision\(rows, wsRef, envName\)/)
  assert.match(source, /var requestWrite = function \(form, check\)/)
  assert.match(source, /if \(hit\) \{\s*\n\s*setOverwrite\(\{ form: form, hit: hit \}\);/)
  assert.match(source, /var executeWrite = function \(form\)/)
  assert.match(source, /var confirmOverwrite = function \(\)/)
  assert.match(source, /var cancelOverwrite = function \(\) \{ setOverwrite\(null\); \}/)
  // both entry points go through the gate: the add form and a renaming edit
  assert.match(source, /function connDraftOf\(form\)/)
  assert.match(source, /requestWrite\(withConnDraft\(\{\s*\n\s*ws: addTarget \|\| addForm\.ws\.trim\(\),\s*\n\s*env: addForm\.env\.trim\(\) \|\| "default",\s*\n\s*dsn: addForm\.dsn\.trim\(\),\s*\n\s*_draft: addForm,\s*\n\s*\}, addForm\), true\);/)
  assert.match(source, /_renameFrom: renaming \? row\.env : "" \}, editing\), renaming\);/)
  // editing the connection of the SAME environment is not an overwrite question
  assert.match(source, /var renaming = normalizeEnvForCompare\(newEnv\) !== normalizeEnvForCompare\(row\.env\);/)
  // the prompt is a warning card with an explicit overwrite/cancel pair
  assert.match(source, /className: "dbh-warncard", role: "alert"/)
  assert.match(source, /t\("ovr\.title"\)/)
  assert.match(source, /t\("ovr\.bodyAmbiguous", \{/)
  assert.match(source, /t\("ovr\.confirm"\)/)
  assert.match(source, /overwriteView \|\| removeView \|\| pretestView,/)
})

test('client bundle keeps the source handle copyable instead of echoing it inline', () => {
  assert.match(source, /w\.srcId/)
  assert.match(source, /var copySource = function \(text, key\)/)
  // the platform clipboard helper already falls back to execCommand
  assert.match(source, /writeClipboard/)
  assert.match(source, /function shortHandle\(id\)/)
  assert.match(source, /var sourceChip = function \(w, key\)/)
  assert.match(source, /className: "dbh-src" \+ \(copied \? " dbh-src-ok" : ""\)/)
  assert.match(source, /t\("ws\.srcHint"\)/)
  assert.match(source, /h\("span", \{ className: "dbh-srcid" \}, copied \? t\("copy\.ok"\) : shortHandle\(w\.srcId\)\)/)
  // the handle is metadata, never a DSN
  assert.doesNotMatch(source, /w\.dsn/)
})

test('client bundle draws clear row-action icons instead of text labels', () => {
  assert.match(source, /function pickIcon\(name, glyph\)/)
  // Test / edit / delete are explicit 16px SVG shapes (the bundled edit glyph is
  // ambiguous at 1x); copy and close keep their product primitives.
  assert.match(source, /var svgIcon = function \(children\)/)
  assert.match(source, /var RunIcon = svgIcon\(/)
  assert.match(source, /var EditIcon = svgIcon\(/)
  assert.match(source, /var TrashIcon = svgIcon\(/)
  assert.match(source, /pickIcon\("IconCopyOutline16"/)
  assert.match(source, /pickIcon\("IconCloseOutline16"/)
  // icons carry their label in title/aria-label, never as row text
  assert.match(source, /"aria-label": t\("btn\.test"\)/)
  assert.match(source, /"aria-label": t\("btn\.delete"\)/)
})

test('client bundle keeps the database name visible when the row is narrow', () => {
  // `type://host:port/` may be truncated; the database name must not be.
  assert.match(source, /function splitConn\(conn\)/)
  assert.match(source, /className: "dbh-conn-pre"/)
  assert.match(source, /className: "dbh-conn-db"/)
})

// Property names whose value paints a colour. Shadows, fills, strokes and
// outlines colour the page just as much as `background` does, so they are in the
// same set: a `box-shadow:0 0 8px #0d1117` is an opaque literal in a themed UI.
// Custom properties (`--w:#0d1117`) and `filter` (`drop-shadow(…)`) are included
// as well: a custom property becomes a paint the moment anything reads it, and a
// drop-shadow paints an opaque silhouette — both used to be invisible here
// because the property name was not in the list.
const COLOR_PROP = /((?:--[a-z0-9-]+)|[a-z-]*(?:color|background|border|box-shadow|text-shadow|fill|stroke|outline|filter))\s*:\s*([^;"]+)/g

// The ONLY literals allowed in a themed surface: the neutral translucent grey the
// bundle uses as a token fallback (`rgba(127,127,127,α)` — inherits light/dark),
// `transparent`/`none`, and the hairline card shadow. Everything else (hex, white,
// black, named greys, saturated rgba) is an opaque literal.
const NEUTRAL_COLOR_RE = /^\s*(?:transparent|none|rgba\(\s*127\s*,\s*127\s*,\s*127\s*,\s*(?:0?\.\d+|1|0)\s*\))\s*$/i
const HAIRLINE_SHADOW = /^0 1px 2px rgba\(0,0,0,\.05\)$/
// Modern colour FUNCTIONS pick a colour without ever writing `#`:
// `oklch(0.7 0.2 30)`, `lab(52% 40 -20)`, `color(display-p3 1 0 0)`. A hex-only
// pattern cannot see them, and neither can it see `color-mix()` components.
const COLOR_FN_NAMES = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'light-dark'])
const LITERAL_RE = /#[0-9a-f]{3,8}|\b(?:white|black|gray|grey|silver|whitesmoke)\b/i

/**
 * Split a declaration value into top-level pieces (commas and whitespace), so a
 * function's arguments are judged as a unit and `rgba(0,0,0,.05)` stays whole.
 */
function topLevelPieces(value) {
  const pieces = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth += 1
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current) pieces.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) pieces.push(current)
  return pieces
}

/**
 * The first opaque literal inside a paint value — `''` when every component is
 * theme-safe.
 *
 * `color-mix()` is decided by its ARGUMENTS (`in oklab` names the interpolation
 * space, percentages are amounts), every other colour function is a picked
 * colour, and every other function (`drop-shadow`, `linear-gradient`, `blur`) is
 * structural, so the walk looks inside it — that is how `drop-shadow(0 0 2px
 * #0d1117)` still names its hex.
 */
function opaqueColorOf(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  for (const piece of topLevelPieces(raw)) {
    const text = piece.trim()
    if (!text) continue
    const call = text.match(/^([a-z-]+)\((.*)\)$/is)
    if (call) {
      const name = call[1].toLowerCase()
      const inner = call[2]
      // A runtime reference and an arithmetic wrapper carry no colour of their own.
      if (name === 'var' || name === 'env' || name === 'calc' || name === 'clamp' || name === 'min' || name === 'max') continue
      if (name === 'color-mix') {
        for (const arg of topLevelPieces(inner)) {
          const part = arg.trim()
          if (!part) continue
          if (/^in\s+[a-z0-9-]+(?:\s+[a-z0-9-]+)*$/i.test(part)) continue // interpolation space
          if (/^(?:shorter|longer|increasing|decreasing)\s+hue$/i.test(part)) continue
          const bad = opaqueColorOf(part)
          if (bad) return bad
        }
        continue
      }
      if (COLOR_FN_NAMES.has(name)) {
        // The neutral grey fallback is the one colour this bundle may name.
        if (NEUTRAL_COLOR_RE.test(text)) continue
        return text
      }
      const inside = opaqueColorOf(inner)
      if (inside) return inside
      continue
    }
    if (text === 'TOKEN') continue // a `var(--dsw-alias-…)` reference
    if (NEUTRAL_COLOR_RE.test(text)) continue
    // Named colours BEFORE the generic keyword rule: `white` is a keyword too,
    // and the old order let `outline:1px solid white` pass as "just a keyword".
    const hit = text.match(LITERAL_RE)
    if (hit) return hit[0]
    if (/^[-+]?(?:\d*\.)?\d+(?:[a-z%]+)?$/i.test(text)) continue // length / angle / number
    if (/^[a-z-]+$/i.test(text)) continue // keyword: solid, center, auto, currentColor
  }
  return ''
}

/**
 * Split a declaration value into its `var(--dsw-alias-…)` references and the
 * literal text around them, honouring nested parens so a fallback such as
 * `var(--dsw-alias-bg-primary,rgba(255,255,255,.95))` is seen whole.
 *
 * The old gate exempted the ENTIRE declaration as soon as the substring
 * `var(--dsw-alias-` appeared, so anything hidden in the fallback was invisible.
 * @returns `{ rest, fallbacks }` — `rest` has every token reference replaced.
 */
function splitAliasVars(value) {
  let rest = ''
  const fallbacks = []
  let i = 0
  for (;;) {
    const start = value.indexOf('var(--dsw-alias-', i)
    if (start === -1) {
      rest += value.slice(i)
      return { rest, fallbacks }
    }
    rest += value.slice(i, start)
    let depth = 0
    let j = start
    for (; j < value.length; j++) {
      if (value[j] === '(') depth += 1
      else if (value[j] === ')') {
        depth -= 1
        if (depth === 0) {
          j += 1
          break
        }
      }
    }
    const inner = value.slice(start + 'var('.length, j - 1) // `--dsw-alias-x,<fallback>`
    const comma = inner.indexOf(',')
    if (comma !== -1) fallbacks.push(inner.slice(comma + 1))
    rest += ' TOKEN '
    i = j
  }
}

/** @returns the offending literal(s) of a declaration value, '' when theme-safe. */
function literalColorOf(value) {
  const { rest, fallbacks } = splitAliasVars(value)
  const badFallback = fallbacks.find((fallback) => opaqueColorOf(fallback))
  if (badFallback) return opaqueColorOf(badFallback)
  const stripped = rest.replace(/\b(?:transparent|none)\b/gi, ' ').trim()
  if (HAIRLINE_SHADOW.test(stripped.replace(/\s+/g, ' '))) return ''
  return opaqueColorOf(stripped)
}

/** @returns declarations that paint an opaque literal colour. */
function colorOffenders(css) {
  return [...css.matchAll(COLOR_PROP)]
    .map((m) => ({ prop: m[1], value: m[2] }))
    .filter((decl) => literalColorOf(decl.value))
    .map((decl) => `${decl.prop}:${decl.value}`)
}

test('client bundle styles stay theme-safe (tokens only, no opaque literals)', () => {
  // A themed or translucent skin may redefine the tokens or leave some
  // undefined: surfaces must inherit the page background instead of painting a
  // hard block, and text must never fall back to a fixed light-mode grey.
  assert.doesNotMatch(source, /#ffffff|#f6f8fa|#d0d7de|#1f2328|#e03131|#2f9e44/i)
  const start = source.indexOf('var CSS_TEXT = [')
  const end = source.indexOf('].join("");', start)
  assert.ok(start > 0 && end > start, 'CSS_TEXT block must exist')
  const css = source.slice(start, end)
  // Compare as text so a failure names the offending declarations instead of
  // printing `actual: [Array]`.
  const offenders = colorOffenders(css)
  assert.equal(JSON.stringify(offenders), '[]', `opaque literals in the stylesheet: ${offenders.join(' | ')}`)
  // the only literal left is the (theme-neutral) hairline card shadow
  assert.match(css, /box-shadow:0 1px 2px rgba\(0,0,0,\.05\)/)
})

test('the token-only rule actually rejects literals (fallbacks, shadows, svg paints)', () => {
  // Every shape below used to be PERMITTED by this gate: the substring
  // `var(--dsw-alias-` exempted the whole declaration (so a literal in the
  // fallback was invisible), the property set stopped at border/background, and
  // `#0d1117` in a shadow or a stroke was never inspected at all.
  const bad = [
    'background:var(--dsw-alias-bg-primary,#0d1117)',
    'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.95))',
    'box-shadow:0 0 8px #0d1117',
    'stroke:#0d1117',
    'fill:#fff',
    'text-shadow:0 0 2px rgba(0,0,0,.8)',
    'outline:1px solid white',
    'border-color:var(--dsw-alias-border-l1,#d0d7de)',
    // Modern colour functions pick a colour without a `#`; a hex-only pattern
    // (and a property list that stopped at the layout properties) let every one
    // of these through — including a custom property and a drop-shadow.
    'background:oklch(0.7 0.2 30)',
    'color:oklch(0.7 0.2 30)',
    'background:lab(52% 40 -20)',
    'background:lch(52% 50 30)',
    'background:color(display-p3 1 0 0)',
    'background:color-mix(in oklab, var(--dsw-alias-bg-primary) 50%, #0d1117)',
    'filter:drop-shadow(0 0 2px #0d1117)',
    '--w:#0d1117',
    '--surface-color:oklch(0.7 0.2 30)',
  ]
  for (const declaration of bad) {
    assert.deepEqual(colorOffenders(declaration), [declaration], `must be rejected: ${declaration}`)
  }
  // ... while the neutrals the bundle actually uses stay allowed: token
  // references with translucent-grey fallbacks, transparent/none, lengths and
  // the hairline card shadow.
  const good = [
    'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))',
    'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3))',
    'background:var(--dsw-alias-bg-layer-3,transparent)',
    'background:transparent',
    'outline:none',
    'border:0',
    'box-shadow:0 1px 2px rgba(0,0,0,.05)',
    'stroke:var(--dsw-alias-label-secondary)',
    // The new coverage must not swallow the theme-safe shapes: a custom property
    // holding a token reference, `filter:none`, and a colour mix whose only
    // components are a token and `transparent`.
    '--w:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))',
    'filter:none',
    '--w:transparent',
    'background:color-mix(in oklab, var(--dsw-alias-bg-primary) 50%, transparent)',
    'border-color:transparent',
  ]
  for (const declaration of good) {
    assert.deepEqual(colorOffenders(declaration), [], `must stay allowed: ${declaration}`)
  }
})

test('client bundle manages workspace connections through configOp', () => {
  assert.match(source, /configOp:\s*function/)
  assert.match(source, /op: "add"/)
  assert.match(source, /op: "remove"/)
  assert.match(source, /op: "rename"/)
  // the options-only write (read-only switch / SSH tunnel) never carries a DSN
  assert.match(source, /op: "options"/)
  assert.match(source, /_opKind: "rename"/)
  assert.match(source, /_opKind: "options"/)
  assert.match(source, /newEnv/)
  assert.match(source, /renameFrom/)
  assert.match(source, /workspacesOf\(value\)/)
  assert.match(source, /已保存|自动/)
})

test('client bundle folds the add form behind an explicit entry point', () => {
  assert.match(source, /var openAdd = function \(target\)/)
  assert.match(source, /var closeAdd = function \(\)/)
  assert.match(source, /t\("btn\.addConn"\)/)
  assert.match(source, /onClick: function \(\) \{ openAdd\(g\.path\); \}/)
  assert.match(source, /className: "dbh-addpanel"/)
  // per-workspace adds carry the workspace implicitly
  assert.match(source, /ws: addTarget \|\| addForm\.ws\.trim\(\)/)
  assert.match(source, /id: "dbh-ws-list"/)
})

test('client bundle folds status/options into the header + DSH-style settings rows', () => {
  assert.match(source, /className: "dbh-titlebar"/)
  assert.match(source, /className: "dbh-statusline"/)
  assert.match(source, /var toggleSettings = function \(\)/)
  assert.match(source, /className: "dbh-settings"/)
  assert.match(source, /className: "dbh-settings dbh-settingsbar"/)
  // view state survives remounts within the page session
  assert.match(source, /var uiMemory = \{ expanded: \{\}, addOpen: false, addTarget: "", settingsOpen: false, advOpen: false \};/)
})

test('client bundle offers a transient per-row connection test', () => {
  assert.match(source, /op: "test"/)
  assert.match(source, /nonce/)
  assert.match(source, /value\.testResult/)
  // results are surfaced only for nonces the card itself dispatched
  assert.match(source, /nonceKeys/)
  assert.match(source, /btn\.test/)
})

test('client bundle keeps the pre-test gate before saving a connection', () => {
  assert.match(source, /var dispatchPretest = function \(form\)/)
  assert.match(source, /"pretest:" \+ \(form\.ws \|\| ""\)/)
  assert.match(source, /var confirmSave = function \(\)/)
  assert.match(source, /t\("pretest\.failHint"\)/)
  assert.match(source, /className: "dbh-pretest"/)
})

test('client bundle injects only slots (the removed settingsScope stays out)', () => {
  // A never-satisfied `settingsScope` injection left the plugin pending forever,
  // so nothing rendered and nothing logged. Only `slots` may be injected; the
  // bridge needs no service at all.
  assert.match(source, /var inject = \["slots"\];/)
  assert.doesNotMatch(source, /inject = \[[^\]]*"settingsScope"/)
  // The live poll belongs to a rendered page, not to the plugin scope: an idle
  // GUI must not poll the bridge.
  assert.match(source, /props\.subscribe\(function \(\) \{ setValue\(valueOf\(props\.getSnapshot\(\)\)\); \}, \{ live: true \}\);/)
  assert.match(source, /var live = !!\(opts && opts\.live\);/)
})

test('client bundle offers the environment read-only switch and never echoes the mirrored secret', () => {
  assert.match(source, /"add\.readOnly": "只读模式"/)
  assert.match(source, /"add\.readOnly": "Read-only mode"/)
  assert.match(source, /var roCheck = function \(form, update, keyPrefix\)/)
  // the checkbox is NOT a `.dbh-field`/`.dbh-input`: the add panel's field count
  // and its 0..2 input indices are pinned by the offscreen gate
  assert.match(source, /type: "checkbox", className: "dbh-checkbox"/)
  assert.match(source, /"aria-label": t\("add\.readOnly"\)/)
  // the very same draft builder feeds every op payload
  assert.match(source, /function withConnDraft\(op, form\)/)
  assert.match(source, /op\.readOnly = d\.readOnly === true;/)
})

test('client bundle configures the SSH tunnel, keeping secrets write-only', () => {
  assert.match(source, /"add\.adv": "高级：SSH 隧道"/)
  assert.match(source, /"add\.adv": "Advanced: SSH tunnel"/)
  assert.match(source, /var advPanel = function \(form, update, keyPrefix, targetOf\)/)
  // the SSH-layer-only test lives in the advanced section, with its own payload
  assert.match(source, /"btn\.testSsh": "测试 SSH 隧道"/)
  assert.match(source, /var startSshTest = function \(form, targetOf, key\)/)
  assert.match(source, /op: "test", kind: "ssh",/)
  assert.match(source, /"aria-expanded": open/)
  // secrets are typed in and posted, never rendered back
  assert.match(source, /"adv\.keepSecret"/)
  assert.match(source, /type: "password", placeholder: t\("adv\.keepSecret"\)/)
  // a blank secret means "keep the stored one": the builder only attaches the
  // fields the user actually typed
  assert.match(source, /if \(password\) ssh\.password/)
  assert.match(source, /if \(keyPath\) ssh\.keyPath/)
  assert.match(source, /if \(passphrase\) ssh\.passphrase/)
  // the mirrored row only carries booleans for secrets
  assert.match(source, /function sshDraftOf\(row\)/)
  assert.match(source, /sshKeyPath: "",\s*\n\s*sshPassword: "",\s*\n\s*sshPassphrase: "",/)
})

test('client bundle shows the elapsed time of a running probe and cleans the ticker up', () => {
  assert.match(source, /"test\.elapsed": "测试中… \{s\}s"/)
  assert.match(source, /startedAt: Date\.now\(\)/)
  assert.match(source, /t\("test\.elapsed", \{ s: String\(secs\) \}\)/)
  // the 1s ticker exists ONLY while a row is testing, and its effect cleans up
  // (the offscreen gate hangs on a leaked interval, which is the point)
  assert.match(source, /if \(!anyTesting \|\| typeof setInterval !== "function"\) return undefined;/)
  assert.match(source, /return function \(\) \{ clearInterval\(id\); \};/)
  // probe watchdogs are tiered for the slower tunnel
  assert.match(source, /var PRETEST_WATCHDOG_MS = 30000;/)
  assert.match(source, /var PRETEST_WATCHDOG_SSH_MS = 60000;/)
  assert.match(source, /var TEST_WATCHDOG_MS = 30000;/)
  assert.match(source, /var TEST_WATCHDOG_SSH_MS = 60000;/)
})

test('client bundle disables what the installed dbhub cannot do', () => {
  assert.match(source, /function capsOf\(value\)/)
  assert.match(source, /function capabilityHint\(caps, t\)/)
  assert.match(source, /"cap\.tooOld":/)
  assert.match(source, /disabled: !sshSupported,/)
  assert.match(source, /disabled: !roSupported,/)
})

test('client bundle renders every surface unconditionally and warns on an unsupported dsh', () => {
  // 5.2 surfaces (title/version header, update prompt, wide settings block,
  // inline read-only toggle, switch-style controls) are the ONLY surfaces now:
  // 0.1.x is no longer supported, so nothing is version-gated any more. An old
  // host gets a full page plus one visible warning line (never a blank card).
  assert.doesNotMatch(source, /dshModern/)
  assert.match(source, /var pluginVersion = typeof value\.pluginVersion === "string"/)
  assert.match(source, /var dshVersion = typeof value\.dshVersion === "string"/)
  assert.match(source, /var dshTooOld = value\.dshTooOld === true;/)
  assert.match(source, /className: "dbh-warncard dbh-tooold"/)
  assert.match(source, /t\("dsh\.tooOld", \{ min: dshMinVersion, v: dshVersion \|\| "\?" \}\)/)
  assert.match(source, /"dsh\.tooOld": "此插件需要 DSH \{min\} 或更高版本/)
  assert.match(source, /"dsh\.tooOld": "This plugin requires DSH \{min\} or later/)
  assert.match(source, /var runtime = value\.runtime === "desktop"/)
  // The three mounts are named, not guessed: settings dialog vs full pages.
  assert.match(source, /function SettingsSectionPanel\(props\)/)
  assert.match(source, /function MainPanel\(props\)/)
  assert.match(source, /surface: "modal"/)
  assert.match(source, /surface: "main"/)
  // Layout follows the measured column, with the phone check on the VIEWPORT
  // (a narrow settings dialog on a desktop is not a phone). The observer is
  // attached by a callback ref, never by an effect that reads `ref.current` —
  // that measured once and was never re-armed (see the measurement test).
  assert.match(source, /function attachMeasuredWidth\(state\)/)
  assert.match(source, /var innerRefCb = widthCbRef\.current;/)
  assert.match(source, /var isMobile = viewportWidth > 0 \? viewportWidth < 700/)
  assert.match(source, /var isWide = !isMobile && surface !== "modal"/)
})

test('client bundle shows the plugin version and the quiet update prompt', () => {
  assert.match(source, /"ver\.link": "可升级到 \{v\}"/)
  assert.match(source, /"ver\.link": "Upgrade to \{v\}"/)
  assert.match(source, /function parseUpdate\(value\)/)
  // A text link by default; the instructions live in a panel opened on demand.
  assert.match(source, /className: "dbh-updatelink"/)
  assert.match(source, /className: "dbh-updatepanel"/)
  // The header link EXPANDS the detail panel, so its tooltip describes the
  // expansion; only the copy button INSIDE the panel may advertise a copy.
  assert.match(source, /title: t\("ver\.linkHint"\),/)
  assert.match(source, /"ver\.linkHint": "展开升级说明与安装命令"/)
  assert.match(source, /"ver\.linkHint": "Show the upgrade details and the install command"/)
  // `ver.copySpec` survives on exactly one control: the panel's copy button.
  assert.equal([...source.matchAll(/t\("ver\.copySpec"/g)].length, 1,
    'ver.copySpec belongs to the copy button only — the upgrade link must not claim it')
  // the copy control copies the exact install spec; the web command is copiable too
  assert.match(source, /dsh-dbhub-live@" \+ update\.latest/)
  assert.match(source, /dsh plugin --profile web up dsh-dbhub-live@/)
  // opening the page asks the Host for a throttled check; the button forces one
  assert.match(source, /kickUpdateCheck\(false\)/)
  assert.match(source, /op: "updateCheck", force: force === true/)
  // Updating is neutral news, not an error: no red card/pill classes remain.
  assert.doesNotMatch(source, /dbh-latest/)
  assert.doesNotMatch(source, /dbh-updatecard/)
  // desktop and web update routes differ
  assert.match(source, /t\("ver\.desktopHint"/)
  assert.match(source, /t\("ver\.webHint"/)
  assert.match(source, /releases\/tag\/v/)
})

test('client bundle renders DSH-style settings rows, the harness Switch and row read-only chips', () => {
  assert.match(source, /function switchControl\(opts\)/)
  // The real toggle comes from the primitives module; the fallback is local.
  assert.match(source, /primitives\.Switch/)
  assert.match(source, /className: "dbh-fbswitch"/)
  assert.match(source, /className: "dbh-settings"/)
  assert.match(source, /className: "dbh-srow"/)
  // Non-modal pages always use the horizontal bar (a narrow desktop column gets
  // the compact variant instead of four stacked rows).
  assert.match(source, /var useSettingsBar = !isMobile && surface !== "modal"/)
  assert.match(source, /className: "dbh-settings dbh-settingsbar"/)
  // State words are two-character, current-state labels — never "已开启".
  assert.match(source, /"row\.enable": "启用插件"/)
  assert.match(source, /"state\.show": "显示"/)
  assert.match(source, /"state\.hide": "隐藏"/)
  assert.match(source, /"state\.on": "开启"/)
  assert.match(source, /"state\.off": "关闭"/)
  // Wide page owns the settings: enable / sidebar / policy switches + interval.
  assert.match(source, /props\.setEnabled\(next\)/)
  assert.match(source, /onChange: toggleSidebar/)
  assert.match(source, /onChange: togglePolicy/)
  // Read-only is a row chip in every layout, written as an options-only op.
  assert.match(source, /className: "dbh-rochip"/)
  assert.match(source, /op: "options", workspace: w\.path, env: w\.env, readOnly: w\.ro !== true/)
  // The chip shows an OPEN lock + 可写 when writable and a CLOSED lock + 只读
  // when locked, so a first-time user cannot mistake two writable rows for RO.
  assert.match(source, /"dbh-roemoji"/)
  assert.match(source, /on \? "🔒" : "🔓"/)
  assert.match(source, /t\(on \? "ro\.chip" : "ro\.writable"\)/)
  assert.match(source, /"ro\.writable": "可写"/)
  assert.match(source, /"ro\.writable": "Writable"/)
  // Long explanations are collapsed into the notes block.
  assert.match(source, /className: "dbh-notes"/)
  assert.match(source, /"note\.tools":/)
  assert.match(source, /className: "dbh-titlebar"/)
  assert.match(source, /className: "dbh-title"/)
})

test('client bundle contributes the composer `@` source (one message, many references)', () => {
  // The `@` menu is the one surface where the USER names connections; every
  // submitted chip serializes on its own, which is what makes several
  // references in one message work. The source is registered through the
  // OPTIONAL service, so it must never join the exported `inject` list.
  assert.match(source, /ctx\.inject\(\["inputTriggers"\], function \(scope\) \{/)
  assert.match(source, /scope\.inputTriggers\.registerSource\(dbhubInputSource\);/)
  assert.match(source, /name: "dbhub",\s*\n\s*trigger: "@",/)
  assert.match(source, /serialize: function \(ref\) \{ return "@db:" \+ String\(ref \|\| ""\); \},/)
  assert.match(source, /clipboardText: function \(ref\) \{ return "@" \+ aliasOfHandle\(ref\); \},/)
  assert.match(source, /insert: \{\s*\n\s*source: "dbhub",/)
  assert.match(source, /appearance: "file",/)
  // A candidate carries the alias, the handle and the metadata label only.
  assert.match(source, /var cand = \{ name: alias, label: alias, description: bits\.join\(" · "\), value: handle \};/)
  assert.match(source, /if \(v\.enabled !== true\) return \[\];/)
  // ... and the service stays out of the declared dependencies.
  assert.match(source, /var inject = \["slots"\];/)
  assert.doesNotMatch(source, /var inject = \[[^\]]*inputTriggers/)
})

// ── locale tables ───────────────────────────────────────────────────────────
//
// The bundle is hand-written and its dictionaries are plain object literals, so
// a repeated key is SILENT: the later value wins and the earlier one becomes
// dead text that a later edit can "fix" forever with no effect. The bundle also
// exports no dictionary, so the source (the shipping artifact) is the contract.

/**
 * The `[key, value]` pairs of one locale object literal, in source order.
 * Values are single-line double-quoted strings; that is true of every entry and
 * a violation is caught here rather than silently skipped.
 */
function localeEntriesOf(name) {
  const start = source.indexOf("var " + name + " = {")
  assert.ok(start > 0, name + " not found in the bundle")
  const end = source.indexOf("\n  };", start)
  assert.ok(end > start, name + " has no closing brace")
  const body = source.slice(start, end)
  const entries = []
  const re = /^ {4}(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*"((?:[^"\\]|\\.)*)",?\s*$/gm
  let m
  while ((m = re.exec(body))) entries.push([m[1] || m[2], m[3]])
  // Every non-comment line in the block must have been consumed: a multi-line or
  // oddly formatted entry would otherwise drop out of the duplicate check.
  const valueLines = body.split(/\r?\n/).filter((line) => line.trim() && !/^\s*(\/\/|var )/.test(line))
  assert.equal(entries.length, valueLines.length,
    name + " has lines this parser did not understand (the duplicate check would miss them)")
  return entries
}

test('client locale tables define every key once and stay language-pure', () => {
  const zh = localeEntriesOf('LOCALE_ZH')
  const en = localeEntriesOf('LOCALE_EN')
  for (const [name, entries] of [['LOCALE_ZH', zh], ['LOCALE_EN', en]]) {
    const seen = new Set()
    const dupes = []
    for (const [key] of entries) {
      if (seen.has(key)) dupes.push(key)
      seen.add(key)
    }
    assert.deepEqual(dupes, [], name + ' defines a key twice (the literal silently keeps the last one)')
    assert.ok(entries.length > 100, name + ' is unexpectedly small: ' + entries.length)
  }
  // Same keys, both languages: a key that exists on one side only renders as the
  // raw key (or as the zh fallback) in the other locale.
  assert.deepEqual(en.map(([k]) => k).sort(), zh.map(([k]) => k).sort(), 'zh/en key sets differ')
  // No Chinese in the English table. A leftover zh example in a placeholder
  // ("e.g. prod / dev / test / 线上") is what a user on an en host actually reads.
  const leaked = en.filter(([, value]) => /[\u4e00-\u9fff]/.test(value)).map(([k]) => k)
  assert.deepEqual(leaked, [], 'the en table embeds Chinese text')
  // The SAME placeholders on both sides: a `{n}` that exists in one dictionary
  // only is an unfilled `{n}` (or a silently lost number) for the other locale.
  // The list controls are parameterized ("N / M", "X passed / Y failed / …"), so
  // this is a real failure mode, not a theoretical one — and `check:ui` only
  // renders the filtered/batch copy in zh.
  const zhMap = new Map(zh)
  const placeholders = (text) => [...String(text).matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort().join(',')
  const mismatched = en
    .filter(([key, value]) => zhMap.has(key) && placeholders(value) !== placeholders(zhMap.get(key)))
    .map(([key]) => key)
  assert.deepEqual(mismatched, [], 'zh/en placeholders differ')
})

// ── measured column ─────────────────────────────────────────────────────────

test('the measured column re-arms when the element mounts (no one-shot measure)', () => {
  // The width effect used to read `ref.current` inside a `[]`-dependency effect:
  // when the column was not attached yet (a surface switch, a remount, a host that
  // defers the mount) it measured nothing and NEVER retried, so the layout fell
  // back to the viewport for the rest of the mount. The observer is now created by
  // the callback ref: attach, re-attach on a different node, disconnect on detach.
  // No interval, no timer — either would keep the offscreen gate alive.
  assert.match(source, /function attachMeasuredWidth\(state\)/)
  assert.match(source, /if \(innerRef\.current === node\) return;/)
  assert.match(source, /observerRef\.current = observer;/)
  assert.doesNotMatch(source, /var el = ref && ref\.current;/, 'the ref-read form is the defect')
  // Mount + unmount teardown is the ONLY effect left around the measurement.
  assert.match(source, /react\.useEffect\(function \(\) \{\s*return function \(\) \{\s*if \(!widthObserver\.current\) return;/)
  // The callback identity is frozen (a fresh function each render would
  // detach/re-attach the node every pass).
  assert.match(source, /ref: innerRefCb/)
  assert.match(source, /if \(!widthCbRef\.current\) \{/)
  const measure = source.slice(source.indexOf('function attachMeasuredWidth'), source.indexOf('function switchControl'))
  assert.doesNotMatch(measure, /setInterval|setTimeout|requestAnimationFrame/)
})

// ── SSH-layer test form validation ──────────────────────────────────────────

test('the ssh-layer test refuses a half-filled tunnel before it dispatches', () => {
  // `connDraftOf` ALWAYS returns an object while the tunnel switch is on, so the
  // old `if (!ssh)` guard was dead in the only state where the button exists: a
  // blank host or user went to the Host and came back as a generic "missing user"
  // instead of the form's own hint.
  assert.match(source, /connDraftOf\(form\)/)
  assert.match(source, /if \(!ssh \|\| !String\(ssh\.host \|\| ""\)\.trim\(\) \|\| !String\(ssh\.user \|\| ""\)\.trim\(\)\) \{/)
  assert.match(source, /finishTest\(key, nonce, false, t\("adv\.testSshNeedFields"\)\);/)
  // The guard runs BEFORE the watchdog is armed: an early return must not leave a
  // timer behind (the gate fails the run on a leaked timer too).
  const at = source.indexOf('var ssh = d.ssh && typeof d.ssh === "object" ? d.ssh : null;')
  const guard = source.indexOf('finishTest(key, nonce, false, t("adv.testSshNeedFields"));', at)
  const watchdog = source.indexOf('testTimers.current[nonce] = setTimeout(function () {', at)
  assert.ok(at > 0 && guard > at && watchdog > guard, 'the field check must precede the watchdog')
})

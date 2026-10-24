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
  // The transport is PROBED, never injected: a `settingsScope` injection is
  // unsatisfiable on dsh 0.2.x and keeps the whole browser half pending (the
  // page, the sidebar entry and the Plugins card all vanish silently).
  assert.match(source, /var inject = \["slots"\];/)
  assert.doesNotMatch(source, /var inject = \[[^\]]*settingsScope/)
})

test('client bundle binds its host face through the runtime ladder', () => {
  // 0.1.x keeps the settings namespace; every newer line reads the plugin's own
  // authenticated bridge instead.
  assert.match(source, /function legacyFace\(scope\)/)
  assert.match(source, /function httpFace\(\)/)
  assert.match(source, /var BRIDGE_BASE = "api\/dsh-dbhub-live";/)
  assert.match(source, /var legacyScope = typeof ctx\.get === "function" \? ctx\.get\("settingsScope"\) : undefined;/)
  assert.match(source, /var face = legacyScope && typeof legacyScope\.bind === "function" \? legacyFace\(legacyScope\) : httpFace\(\);/)
})

test('client bundle writes options through the settings form when it can', () => {
  // dsh 0.1.7+/0.2.x: `ctx.configForms.get(entryId).set(field, value)` — the
  // entry id arrives in the Host view. POST /options is the fallback (0.1.x, or
  // a deployment without the settings client).
  assert.match(source, /var saveOptions = function \(patch\) \{/)
  assert.match(source, /var forms = typeof ctx\.get === "function" \? ctx\.get\("configForms"\) : undefined;/)
  assert.match(source, /form = forms\.get\(entryId\);/)
  assert.match(source, /return form\.set\(key, raw\)\.then/)
  assert.match(source, /return post\("\/options", patch\);/)
  assert.match(source, /saveConfig: function \(patch\) \{ return saveOptions\(patch \|\| \{\}\); \},/)
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
  assert.match(source, /if \(!isPage\)/)
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
  // plugin's enabled state. Hiding the entry is NOT disabling the plugin.
  assert.match(source, /return v\.enabled !== false && v\.showSidebarEntry !== false;/)
  assert.match(source, /var syncSidebar = function/)
  assert.match(source, /face\.subscribe\(syncSidebar\)/)
  // The switch itself is back on the settings strip and applies immediately.
  assert.match(source, /"cfg\.sidebar": "在侧边栏显示入口"/)
  assert.match(source, /"cfg\.sidebar": "Show the sidebar entry"/)
  assert.match(source, /var toggleSidebar = function \(next\)/)
  assert.match(source, /props\.saveConfig\(\{ showSidebarEntry: next \}\);/)
  assert.match(source, /showSidebarEntry: draft\.showSidebarEntry !== false,/)
  // The settings section and the Plugins row never depend on either condition, so
  // no combination can lock the user out of the configuration.
  assert.match(source, /slots\.inject\("settings\.section"/)
  assert.match(source, /"cfg\.disabledHint":/)
  assert.match(source, /t\("cfg\.enabledHint"\) : t\("cfg\.disabledHint"\)\) \+ " " \+ t\("cfg\.sidebarHint"\)/)
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
  assert.match(source, /groups\.map\(tileView\)/)
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
  // so it is visible on the chip (the source is a tooltip, this is not)
  assert.match(source, /var envChip = function \(w\)/)
  assert.match(source, /className: "dbh-ro", title: t\("ro\.title"\)/)
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
  assert.match(source, /"cfg\.summary":/)
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
  assert.match(source, /overwriteView \|\| pretestView,/)
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

test('client bundle styles stay theme-safe (tokens only, no opaque literals)', () => {
  // A themed or translucent skin may redefine the tokens or leave some
  // undefined: surfaces must inherit the page background instead of painting a
  // hard block, and text must never fall back to a fixed light-mode grey.
  assert.doesNotMatch(source, /#ffffff|#f6f8fa|#d0d7de|#1f2328|#e03131|#2f9e44/i)
  const start = source.indexOf('var CSS_TEXT = [')
  const end = source.indexOf('].join("");', start)
  assert.ok(start > 0 && end > start, 'CSS_TEXT block must exist')
  const css = source.slice(start, end)
  const offenders = [...css.matchAll(/([a-z-]*(?:color|background|border))\s*:\s*([^;"]+)/g)]
    .map((m) => `${m[1]}:${m[2]}`)
    .filter((decl) => {
      const value = decl.slice(decl.indexOf(':') + 1)
      if (value.includes('var(--dsw-alias-')) return false
      // a literal colour is the problem; `transparent`/`none`/lengths are fine
      return /#[0-9a-f]{3,8}|(?:rgba?|hsla?)\(|\b(?:white|black|gray|grey|silver)\b/i.test(value)
    })
  assert.deepEqual(offenders, [])
  // the only literal left is the (theme-neutral) hairline card shadow
  assert.match(css, /box-shadow:0 1px 2px rgba\(0,0,0,\.05\)/)
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

test('client bundle folds status/options into the header + a settings strip', () => {
  assert.match(source, /className: "dbh-statustext", title: modeLabel/)
  assert.match(source, /var toggleSettings = function \(\)/)
  assert.match(source, /className: "dbh-strip"/)
  assert.match(source, /t\("cfg\.summary", \{/)
  assert.match(source, /className: "dbh-cfgsum"/)
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

test('client bundle injects only slots and probes the host transport', () => {
  // Regression gate for the 0.2.x failure: a never-satisfied `settingsScope`
  // injection left the plugin pending forever, so nothing rendered and nothing
  // logged. Only `slots` may be injected; the face probes for the rest.
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

test('client bundle gates every modern surface on the Host dsh version', () => {
  // 5.2 surfaces (title/version header, update prompt, wide settings block,
  // inline read-only toggle, switch-style controls) exist only on dsh >= 0.2.1.
  // On 0.1.x the bundle must render the OLD DOM — the offscreen gate's legacy
  // groups pin that, so the flag is read, never inferred from a slot existing.
  assert.match(source, /var modern = value\.dshModern === true;/)
  assert.match(source, /var pluginVersion = typeof value\.pluginVersion === "string"/)
  assert.match(source, /var dshVersion = typeof value\.dshVersion === "string"/)
  assert.match(source, /var runtime = value\.runtime === "desktop"/)
  // The three mounts are named, not guessed: settings dialog vs full pages.
  assert.match(source, /function SettingsSectionPanel\(props\)/)
  assert.match(source, /function MainPanel\(props\)/)
  assert.match(source, /surface: "modal"/)
  assert.match(source, /surface: "main"/)
  // Layout follows the measured column, with the phone check on the VIEWPORT
  // (a narrow settings dialog on a desktop is not a phone).
  assert.match(source, /function useMeasuredWidth\(ref\)/)
  assert.match(source, /var isMobile = modern && \(viewportWidth > 0/)
  assert.match(source, /var isWide = modern && !isMobile && surface !== "modal"/)
})

test('client bundle shows the plugin version and the quiet update prompt', () => {
  assert.match(source, /"ver\.link": "可升级到 \{v\}"/)
  assert.match(source, /"ver\.link": "Upgrade to \{v\}"/)
  assert.match(source, /function parseUpdate\(value\)/)
  // A text link by default; the instructions live in a panel opened on demand.
  assert.match(source, /className: "dbh-updatelink"/)
  assert.match(source, /className: "dbh-updatepanel"/)
  assert.match(source, /t\("ver\.copySpec", \{ v: update\.latest \}\)/)
  // the copy control copies the exact install spec; the web command is copiable too
  assert.match(source, /dsh-dbhub-live@" \+ update\.latest/)
  assert.match(source, /dsh plugin --profile web up dsh-dbhub-live@/)
  // opening the page asks the Host for a throttled check; the button forces one
  assert.match(source, /op: "updateCheck", force: false/)
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
  assert.match(source, /var useSettingsBar = modern && !isMobile && surface !== "modal"/)
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

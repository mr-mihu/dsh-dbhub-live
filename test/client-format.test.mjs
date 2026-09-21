// Contract check for the hand-authored client bundle: the file must be a
// lazy-CJS registration the client module loader can serve and materialize.

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
  assert.match(source, /var inject = \["slots", "settingsScope"\];/)
})

test('client bundle registers the plugins.row.config page keyed to package#row', () => {
  // dsh 0.1.6 dropped settings.plugin.item; the plugin's own configuration now
  // lives on the Plugins page through the keyed plugins.row.config slot.
  assert.doesNotMatch(source, /settings\.plugin\.item/)
  assert.match(source, /slots\.inject\(SLOT/)
  assert.match(source, /var SLOT = "plugins\.row\.config";/)
  assert.match(source, /var SLOT_KEY = "dsh-dbhub-live#dbhub-live";/)
  assert.match(source, /name:\s*SLOT, key:\s*SLOT_KEY/)
  assert.match(source, /settingsScope\.bind\(\{ namespace: NS \}\)/)
})

test('client bundle renders both owner views (summary one-liner + page form)', () => {
  assert.match(source, /var isPage = props\.view !== "summary";/)
  assert.match(source, /if \(!isPage\)/)
})

test('client bundle owns a Settings section (core shell, always available)', () => {
  assert.match(source, /slots\.inject\("settings\.section"/)
  assert.match(source, /name: "settings\.section",\s*\n\s*id: "dbhub"/)
  assert.match(source, /label: function \(\) \{ return t\("title"\); \}/)
  assert.match(source, /function ConfigPanel\(props\)/)
})

test('client bundle owns an optional sidebar entry toggled by showSidebarEntry', () => {
  assert.match(source, /slots\.inject\("sidebar\.panellist"/)
  assert.match(source, /name: "sidebar\.panellist",\s*\n\s*id: "dbhub"/)
  assert.match(source, /function PanelIcon\(props\)/)
  assert.match(source, /slots\.inject\("main"/)
  assert.match(source, /name: "main",\s*\n\s*key: "dbhub"/)
  // the switch lives on the settings page and applies live
  assert.match(source, /v\.showSidebarEntry !== false/)
  assert.match(source, /var syncSidebar = function/)
  assert.match(source, /host\.subscribe\(syncSidebar\)/)
  assert.match(source, /props\.saveConfig\(\{ showSidebarEntry: next \}\)/)
})

test('client bundle exposes the config editor (saveConfig + editable options)', () => {
  assert.match(source, /saveConfig:\s*function/)
  assert.match(source, /updateIntervalDays/)
  assert.match(source, /保存配置/)
  // the auto-install package is NOT a settings field anymore
  assert.doesNotMatch(source, /dbhubPackage/)
})

test('client bundle renders a native single-collapse card (theme tokens, primitives chevron)', () => {
  assert.match(source, /var openState = react\.useState\(false\)/)
  assert.match(source, /--dsw-alias-bg-layer-2/)
  assert.match(source, /--dsw-alias-label-primary/)
  assert.match(source, /IconChevronDownOutline14/)
  assert.match(source, /ChevronIcon/)
  assert.match(source, /rotate\(180deg\)/)
  assert.match(source, /e\.stopPropagation\(\)/)
  assert.match(source, /t\("block\.status"\)/)
  assert.match(source, /t\("block\.config"\)/)
  assert.match(source, /t\("block\.workspaces"\)/)
})

test('client bundle localizes copy through ctx.locale (zh/en dictionaries)', () => {
  assert.match(source, /localeSvc\.register\(NS, \{ zh: LOCALE_ZH, en: LOCALE_EN \}\)/)
  assert.match(source, /face\.t = t|t: t,/)
  assert.match(source, /var LOCALE_ZH = \{/)
  assert.match(source, /var LOCALE_EN = \{/)
  assert.match(source, /"block\.status": "状态"/)
  assert.match(source, /"block\.config": "Configuration"/)
})

test('client bundle shows the source value per workspace row', () => {
  assert.match(source, /w\.srcId/)
  assert.match(source, /t\("ws\.srcVal"\) \+ ": "/)
})

test('client bundle manages workspace connections through configOp', () => {
  assert.match(source, /configOp:\s*function/)
  assert.match(source, /op: "add"/)
  assert.match(source, /op: "remove"/)
  assert.match(source, /op: "rename"/)
  assert.match(source, /newEnv/)
  assert.match(source, /renameFrom/)
  assert.match(source, /workspacesOf\(value\)/)
  assert.match(source, /已保存|自动/)
})

test('client bundle offers a transient per-row connection test', () => {
  assert.match(source, /op: "test"/)
  assert.match(source, /nonce/)
  assert.match(source, /value\.testResult/)
  // results are surfaced only for nonces the card itself dispatched
  assert.match(source, /nonceKeys/)
  assert.match(source, /btn\.test/)
})

test('client bundle still hard-injects slots and settingsScope', () => {
  assert.match(source, /var inject = \["slots", "settingsScope"\];/)
})
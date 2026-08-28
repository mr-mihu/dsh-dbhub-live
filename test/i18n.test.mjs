// Unit tests for the host locale dictionary (lib/i18n.mjs): zh/en selection,
// parameter substitution, provider-driven current locale, and fallbacks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { tFor, currentT, setLocaleProvider } from '../lib/i18n.mjs'

test('tFor selects zh/en and substitutes params', () => {
  assert.equal(tFor('zh', 'result.noSource', { src: 'x' }), '找不到数据源 "x"：请先调用 dbhub_list_sources 查看可用 source 值（如 <工作区> 或 <工作区>_<环境>）。')
  assert.equal(tFor('en', 'result.noSource', { src: 'x' }), 'source "x" not found: run dbhub_list_sources first to see the available source values (e.g. <workspace> or <workspace>_<env>).')
  assert.equal(tFor('zh', 'log.loaded', { n: 6 }), 'dbhub 服务已加载（6 个工具）')
  assert.equal(tFor('en', 'log.loaded', { n: 6 }), 'dbhub server loaded (6 tools)')
})

test('tFor falls back to zh then the key', () => {
  assert.equal(tFor('en', 'result.saveOkUnknownKey'), 'result.saveOkUnknownKey')
  assert.equal(tFor('zh', 'missing-key', { a: 1 }), 'missing-key')
})

test('currentT follows the installed provider', () => {
  setLocaleProvider(() => 'en')
  assert.equal(currentT('result.disabled'), 'dsh-dbhub-live is disabled: dbhub tools are unavailable. Re-enable it in Settings → Plugins → dsh-dbhub-live.')
  setLocaleProvider(() => 'zh')
  assert.equal(currentT('result.disabled').includes('已禁用'), true)
  setLocaleProvider(() => { throw new Error('no settings') })
  assert.equal(currentT('result.disabled').includes('已禁用'), true) // provider errors -> zh
})
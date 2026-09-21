// Unit tests for the host locale dictionary (lib/i18n.mjs): zh/en selection,
// parameter substitution, provider-driven current locale, and fallbacks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { tFor, currentT, setLocaleProvider } from '../lib/i18n.mjs'

test('tFor selects zh/en and substitutes params', () => {
  assert.equal(tFor('zh', 'result.noSource', { src: 'x' }), '找不到数据源 "x"：请先调用 dbhub_list_sources 查看可用 source 值（结果按工作区分组，标出【当前工作区】）。')
  assert.equal(tFor('en', 'result.noSource', { src: 'x' }), 'source "x" not found: run dbhub_list_sources first to see the available source values (the list is grouped by workspace and marks the CURRENT workspace).')
  assert.equal(tFor('zh', 'log.loaded', { n: 6 }), 'dbhub 插件已加载（6 个工具）')
  assert.equal(tFor('en', 'log.loaded', { n: 6 }), 'dbhub plugin loaded (6 tools)')
})

test('tFor falls back to zh then the key', () => {
  assert.equal(tFor('en', 'result.saveOkUnknownKey'), 'result.saveOkUnknownKey')
  assert.equal(tFor('zh', 'missing-key', { a: 1 }), 'missing-key')
})

test('currentT follows the installed provider', () => {
  setLocaleProvider(() => 'en')
  assert.equal(currentT('result.disabled'), 'dsh-dbhub-live is disabled: dbhub tools are unavailable. Re-enable it in Plugins → dsh-dbhub-live → Configure.')
  setLocaleProvider(() => 'zh')
  assert.equal(currentT('result.disabled').includes('已禁用'), true)
  setLocaleProvider(() => { throw new Error('no settings') })
  assert.equal(currentT('result.disabled').includes('已禁用'), true) // provider errors -> zh
})

test('connection-test strings exist in both locales (no zh leakage into en)', () => {
  const keys = ['log.testStart', 'log.testDone', 'result.testOk', 'result.testFail', 'result.testNoDetail', 'result.testNoRow']
  for (const key of keys) {
    assert.notEqual(tFor('en', key, { title: 't', env: 'e', ms: '1', msg: 'm', result: 'r', ws: 'w' }), key, 'missing en key: ' + key)
    assert.notEqual(tFor('zh', key, { title: 't', env: 'e', ms: '1', msg: 'm', result: 'r', ws: 'w' }), key, 'missing zh key: ' + key)
  }
  assert.equal(tFor('zh', 'result.testOk', { ms: '42' }), '连接成功（SELECT 1，42 ms）')
  assert.equal(tFor('en', 'result.testFail', { msg: 'boom', ms: '30000' }), 'connection failed (30000 ms): boom')
})
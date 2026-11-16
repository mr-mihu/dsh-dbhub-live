// Unit tests for the host locale dictionary (lib/i18n.mjs): zh/en selection,
// parameter substitution, provider-driven current locale, and fallbacks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tFor, currentT, setLocaleProvider, dictionaryFor } from '../lib/i18n.mjs'

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

// A per-feature test cannot catch the string somebody adds on one side only, or
// a duplicate key (an object literal silently keeps the LAST one, so the earlier
// entry can never be reached). This is the whole-dictionary sweep.
test('the zh and en dictionaries cover exactly the same keys', () => {
  const zh = Object.keys(dictionaryFor('zh')).sort()
  const en = Object.keys(dictionaryFor('en')).sort()
  const onlyZh = zh.filter((key) => !en.includes(key))
  const onlyEn = en.filter((key) => !zh.includes(key))
  assert.deepEqual(onlyZh, [], 'missing from en: ' + onlyZh.join(', '))
  assert.deepEqual(onlyEn, [], 'missing from zh: ' + onlyEn.join(', '))
  assert.ok(zh.length > 100, 'the dictionary looks truncated: ' + zh.length + ' key(s)')
})

test('no English string carries Chinese copy', () => {
  const cjk = /[\u4e00-\u9fff]/
  const leaked = Object.entries(dictionaryFor('en'))
    .filter(([, value]) => cjk.test(value))
    .map(([key]) => key)
  assert.deepEqual(leaked, [], 'keys whose en copy is still Chinese: ' + leaked.join(', '))
})

test('neither dictionary declares a key twice', () => {
  // Read the SOURCE: the runtime object cannot show a duplicate, the later
  // literal silently wins and the earlier translation becomes unreachable.
  const source = readFileSync(new URL('../lib/i18n.mjs', import.meta.url), 'utf8')
  for (const name of ['ZH', 'EN']) {
    const start = source.indexOf(`const ${name} = {`)
    assert.ok(start >= 0, `dictionary ${name} not found`)
    const body = source.slice(start, source.indexOf('\n}', start))
    const seen = new Map()
    const dupes = []
    const re = /^\s*'([^']+)':/gm
    let m
    while ((m = re.exec(body))) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1)
      if (seen.get(m[1]) === 2) dupes.push(m[1])
    }
    assert.deepEqual(dupes, [], `${name} declares these keys twice: ${dupes.join(', ')}`)
  }
})
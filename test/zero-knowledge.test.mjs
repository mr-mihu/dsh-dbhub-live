// Zero-knowledge gate: the model-facing surface must never carry a password
// (or a full DSN / username). Four layers are asserted here:
//   1. summarizeRows produces metadata only (no dsn field, no password).
//   2. Tool sources: the 4-tool contract has no dbhub_query and dbhub_configure
//      has NO dsn parameter (a password may never ride a tool argument).
//   3. Tool descriptions must never instruct the model to pass credentials.
//   4. i18n copy must never embed a DSN with a real-looking password.
//
// Together with util.test's scrubSecrets/connLabel tests this is the
// "no password reaches the model" regression suite.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-zk-'))
process.env.DSH_HOME = home

const mcp = await import('../lib/mcp.mjs?zk=' + Date.now())
const i18n = await import('../lib/i18n.mjs?zk=' + Date.now())
const here = dirname(fileURLToPath(import.meta.url))
const toolsSource = readFileSync(join(here, '..', 'lib', 'tools.mjs'), 'utf8')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('summarizeRows is metadata-only (no dsn/password/username)', () => {
  const rows = [{
    wsPath: 'C:\\ws\\demo',
    title: 'Demo App',
    env: 'default',
    dsn: 'mysql://root:secret.pw@10.0.0.1:3306/mydb',
    source: 'persisted(user)',
    persisted: true,
  }]
  const summary = mcp.summarizeRows(rows)[0]
  assert.equal(summary.conn, 'mysql://10.0.0.1:3306/mydb')
  assert.equal(summary.dsn, undefined)
  assert.ok(!JSON.stringify(summary).includes('secret.pw'))
  assert.ok(!JSON.stringify(summary).includes('root'))
})

test('tools.mjs registers exactly the 4-tool zero-knowledge contract', () => {
  // no ad-hoc dsn-passthrough tools remain
  assert.doesNotMatch(toolsSource, /name:\s*["']dbhub_query["']/)
  assert.doesNotMatch(toolsSource, /name:\s*["']dbhub_query_objects["']/)
  // the 4 tools are declared
  for (const tool of ['dbhub_configure', 'dbhub_list_sources', 'dbhub_execute_sql', 'dbhub_search_objects']) {
    assert.match(toolsSource, new RegExp('name:\\s*["\']' + tool + '["\']'), tool)
  }
  // NO tool declares a `dsn` schema property the model could fill with a secret
  assert.doesNotMatch(toolsSource, /dsn:\s*\{\s*type:\s*["']string["']/)
  // descriptions explicitly forbid passing credentials as arguments
  assert.match(toolsSource, /不能作为本工具参数传入/)
})

test('no tool description embeds a real-looking DSN', () => {
  // Placeholder examples (user:pass@, u:p@, username:password@, 账号:密码@) are
  // tolerated user-facing copy; anything else in the password position is a leak.
  const dsnLike = /[a-z]+:\/\/[^/\s]*:[^@\s]+@/g
  const placeholders = /(user:pass|u:p|username:password|account:password|账号:密码)@$/
  for (const m of toolsSource.matchAll(dsnLike)) {
    assert.ok(placeholders.test(m[0]), 'real-looking DSN in copy: ' + m[0])
  }
})

test('i18n copy never embeds a DSN with a password', () => {
  const dsnLike = /[a-z]+:\/\/[^/\s]*:[^@\s]+@/
  for (const locale of ['zh', 'en']) {
    const dict = i18n.dictionaryFor(locale)
    for (const key of Object.keys(dict)) {
      assert.doesNotMatch(String(dict[key]), dsnLike, key + ' (' + locale + ')')
    }
  }
})
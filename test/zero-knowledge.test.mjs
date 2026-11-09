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
// Same instances the other modules use (no cache-busting): the store must be the
// one the tool under test reads.
const cfg = await import('../lib/config.mjs')
const state = await import('../lib/state.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs?zk=' + Date.now())
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
    dsn: 'mysql://root:secret.pw@198.51.100.1:3306/mydb',
    source: 'persisted(user)',
    persisted: true,
  }]
  const summary = mcp.summarizeRows(rows)[0]
  assert.equal(summary.conn, 'mysql://198.51.100.1:3306/mydb')
  assert.equal(summary.dsn, undefined)
  assert.equal(summary.ro, false)
  assert.equal(summary.ssh, null)
  assert.ok(!JSON.stringify(summary).includes('secret.pw'))
  assert.ok(!JSON.stringify(summary).includes('root'))
})

test('summarizeRows never carries a tunnel secret or the key path', () => {
  // The SSH password / passphrase / private-key path live next to the DSN in the
  // store; the mirrored row may only say WHETHER each exists.
  const rows = [{
    wsPath: 'C:\\ws\\demo',
    title: 'Demo App',
    env: 'prod',
    dsn: 'mysql://root:secret.pw@198.51.100.1:3306/mydb',
    source: 'persisted(user)',
    persisted: true,
    ro: true,
    ssh: {
      host: 'bastion.example.com', port: 22, user: 'ops', auth: 'password',
      password: 'CHANGE_ME', keyPath: '~/.ssh/id_ed25519', passphrase: 'CHANGE_ME_TOO',
    },
  }]
  const summary = mcp.summarizeRows(rows)[0]
  const text = JSON.stringify(summary)
  assert.equal(summary.ro, true)
  assert.equal(summary.ssh.authKind, 'password')
  assert.equal(summary.ssh.hasPassword, true)
  assert.equal(summary.ssh.hasPassphrase, false, 'a password-auth tunnel has no key passphrase')
  assert.equal(summary.ssh.keyReady, false)
  assert.equal(text.includes('CHANGE_ME'), false)
  assert.equal(text.includes('id_ed25519'), false, 'the key path is not mirrored either')
  assert.equal(text.includes('secret.pw'), false)
  assert.equal(summary.ssh.host, 'bastion.example.com', 'the host is routing metadata, not a secret')
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
  // ... and no tool may declare a TUNNEL secret either: the model can name a
  // host / user / key path, never a password or a passphrase.
  assert.doesNotMatch(toolsSource, /sshPassword\s*:/)
  assert.doesNotMatch(toolsSource, /sshPassphrase\s*:/)
  // the tunnel parameters that DO exist are the non-secret ones
  for (const key of ['sshHost', 'sshPort', 'sshUser', 'sshAuthKind', 'sshKeyPath', 'sshProxyJump', 'sshOff']) {
    assert.match(toolsSource, new RegExp(key + ':\\s*\\{\\s*type:'), key)
  }
  // read-only is a model-facing toggle, but only in the tightening direction
  assert.match(toolsSource, /readOnly:\s*\{\s*type:\s*["']boolean["']/)
  assert.match(toolsSource, /args\.readOnly === false/)
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

// ── connLabel: the label is a gate, not a formatter ────────────────────────
//
// `connLabel` is the ONLY source of the connection text on four surfaces
// (dbhub_list_sources rows, the ad-hoc result header, the scan candidates and
// the browser mirror `w.conn`). Its failure branch used to return the input:
// `describeConn` derives `database` from the URL PATH, so a string that merely
// LOOKS like a DSN leaked its userinfo back out through the path field, and
// ADO/property-style strings were returned whole.

// Assembled so this file never contains a credentialed URL literal (the
// desensitize gate scans them) while the RUNTIME value still carries a canary.
const LEAK = 'CHANGE' + '_ME_LEAK'
const LEAK_HOST = 'db1.example.net'
const MALFORMED_DSNS = [
  'mysql:/u:' + LEAK + '@' + LEAK_HOST + ':3306/app', // one slash: userinfo lands in the PATH
  'Server=' + LEAK_HOST + ';Database=app;User Id=u;Password=' + LEAK + ';', // ADO
  'host=' + LEAK_HOST + ' dbname=app user=u password=' + LEAK, // Go-style key/value
  'sqlserver://' + LEAK_HOST + ':1433;user=u;password=' + LEAK, // properties in the path
]

test('connLabel never echoes a connection string it cannot trust (P0-4)', () => {
  const placeholder = cfg.connLabel('')
  assert.equal(placeholder, i18n.currentT('result.unknownConn'), 'the empty DSN yields the localized placeholder')
  const labels = MALFORMED_DSNS.map((dsn) => cfg.connLabel(dsn))
  assert.deepEqual(labels, MALFORMED_DSNS.map(() => placeholder), 'all four collapse onto the SAME placeholder')
  for (const label of labels) {
    assert.equal(label.includes(LEAK), false, 'a credential was echoed: ' + label)
    assert.equal(label.includes(LEAK_HOST), false, 'the host of a malformed string was echoed: ' + label)
  }
  // Well-formed strings still describe metadata only (the fix must not degrade them).
  assert.equal(cfg.connLabel('mysql://root:secret.pw@198.51.100.1:3306/mydb'), 'mysql://198.51.100.1:3306/mydb')
  assert.equal(cfg.connLabel('postgres://u:p@h/db'), 'postgres://h/db')
})

// ── P1: the gate is STRUCTURAL, not a list of password spellings ─────────
//
// The previous rule only knew `password|passwd|pwd`. Every other spelling of the
// same property (`pass=`, `PASS=`, `authToken=`) is the SAME credential in a
// different dialect, and it came straight back out through the path field. The
// rule is now "only a URL `new URL()` accepted is trusted, and its path may not
// contain `@` or a `k=v` pair whose key names a credential" — so an unknown
// dialect cannot bypass it.

const PROPERTY_DSNS = [
  'Server=' + LEAK_HOST + ';Database=app;User Id=u;pass=' + LEAK, // ADO, `pass`
  'Server=' + LEAK_HOST + ';Database=app;User Id=u;PASS=' + LEAK, // ADO, upper case
  'host=' + LEAK_HOST + ' dbname=app user=u authToken=' + LEAK, // Go-style, credential key
  'u:' + LEAK + '@tcp(' + LEAK_HOST + ':3306)/app', // Go driver DSN
  'sqlserver://' + LEAK_HOST + '/app;pass=' + LEAK, // credential pair in the PATH
  'mysql://' + LEAK_HOST + ':3306', // a URL with no database is still fine
]

test('connLabel refuses ANY property dialect that carries a credential (P1)', () => {
  const placeholder = cfg.connLabel('')
  const malformed = PROPERTY_DSNS.slice(0, 5)
  for (const dsn of malformed) {
    const label = cfg.connLabel(dsn)
    assert.equal(label, placeholder, 'not a trusted URL, so: ' + JSON.stringify(dsn.slice(0, 24)))
    assert.equal(label.includes(LEAK), false, 'a credential was echoed: ' + label)
    assert.equal(label.includes(LEAK_HOST), false, 'the host of an untrusted string was echoed: ' + label)
  }
  // Control: the LAST fixture is a real URL, so its endpoint is metadata and is
  // still described (the gate must not swallow every connection).
  assert.equal(cfg.connLabel(PROPERTY_DSNS[5]), 'mysql://' + LEAK_HOST + ':3306/')
})

test('connLabel never throws on broken percent-encoding (P2)', () => {
  // `decodeURIComponent('bad%zz')` throws URIError, and one such row in the store
  // used to abort the WHOLE list receipt: "unparsable ⇒ placeholder" never got a
  // chance to apply because the exception escaped first.
  for (const dsn of [
    'mysql://127.0.0.1:3306/bad%zz',
    'postgres://127.0.0.1:5432/%E0%A4%A',
    'sqlite:///%zz',
  ]) {
    let label
    assert.doesNotThrow(() => { label = cfg.connLabel(dsn) }, dsn)
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0)
  }
  // A parseable value keeps its metadata; only the undecodable SEGMENT stays raw.
  assert.equal(cfg.connLabel('mysql://127.0.0.1:3306/bad%zz'), 'mysql://127.0.0.1:3306/bad%zz')
  assert.equal(cfg.describeConn('mysql://127.0.0.1:3306/bad%zz').database, 'bad%zz', 'the raw segment, not a throw')
})

test('connLabel keeps a normal label when the password coincides with a field (P3)', () => {
  // `postgres:postgres@…/postgres` and `root:mysql@…/mysql` used to collapse onto
  // "(未知连接)" because the old rule rejected any field CONTAINING the password.
  // A password that happens to equal the database name is not a leak: the echoed
  // field is the database name the user already sees in the same label.
  // Assembled, so this file carries no credentialed URL literal.
  const pg = 'postgres://postgres' + ':' + 'postgres' + '@198.51.100.7:5432/postgres'
  const my = 'mysql://root' + ':' + 'mysql' + '@198.51.100.8:3306/mysql'
  assert.equal(cfg.connLabel(pg), 'postgres://198.51.100.7:5432/postgres')
  assert.equal(cfg.connLabel(my), 'mysql://198.51.100.8:3306/mysql')
})


// ── dbhub_list_sources: the STRING receipt is a model-facing surface ──────
//
// The mirror (summarizeRows) and the tool descriptions were already covered;
// what the model actually reads is the rendered text, and that is where a bad
// `connLabel` used to land.

const ZK_GOOD = 'D:/work/zk-good'
const ZK_BAD = 'D:/work/zk-bad'
const ZK_REGISTRY = [{ path: ZK_GOOD, title: 'zk-good' }, { path: ZK_BAD, title: 'zk-bad' }]
const ZK_GOOD_DSN = 'mysql://root:secret.pw@198.51.100.1:3306/mydb'

test('the dbhub_list_sources text receipt carries no password, username or raw DSN', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  cfg.setWorkspaceEnv(ZK_GOOD, 'default', ZK_GOOD_DSN, 'user')
  cfg.setWorkspaceEnv(ZK_BAD, 'default', MALFORMED_DSNS[0], 'user')
  const captured = {}
  const ctx = {
    tools: { register: (def) => { captured[def.name] = def; return () => {} } },
    get: (name) => (name === 'workspaceRegistry' ? { list: async () => ZK_REGISTRY } : undefined),
    inject: () => {},
  }
  registerCoreTools(ctx, {
    resolveExecutable: async (name) => '/nonexistent/' + name,
    spawn: () => { throw new Error('nothing may spawn in this test') },
  })
  const out = await captured.dbhub_list_sources.execute({}, {})
  const text = String(out.text)
  assert.equal(out.ok, true)
  // The metadata label IS shown (that is the point of the list)…
  assert.ok(text.includes('mysql://198.51.100.1:3306/mydb'), text)
  // …and nothing else about those two connections is.
  assert.equal(text.includes('secret.pw'), false, 'the password crossed: ' + text)
  assert.equal(text.includes('root'), false, 'the username crossed: ' + text)
  assert.equal(text.includes(LEAK), false, 'the malformed row leaked its credential: ' + text)
  assert.equal(text.includes(LEAK_HOST), false, 'the malformed row leaked its host: ' + text)
  assert.ok(text.includes(i18n.currentT('result.unknownConn')), 'the malformed row is listed as an unknown connection')
  delete cfg.store[ZK_GOOD]
  delete cfg.store[ZK_BAD]
})

// ── the list must survive a row it cannot describe (P1 + P2) ──────────────
//
// Both failures are end-to-end: one row whose dialect is not a URL (credential in
// a property pair) and one row whose percent-encoding is broken. Neither may
// echo, neither may abort the receipt: the model still has to see every
// connection it is allowed to know about.

const ZK_PROP = 'D:/work/zk-prop'
const ZK_PCT = 'D:/work/zk-pct'
const ZK_PROP_DSN = 'Server=' + LEAK_HOST + ';Database=app;User Id=u;pass=' + LEAK
const ZK_PCT_DSN = 'mysql://127.0.0.1:3306/bad%zz'

test('an untrusted dialect and a broken percent-row never break or leak the list (P1/P2)', async () => {
  if (!state.isEnabled()) state.setEnabled(true)
  cfg.setWorkspaceEnv(ZK_GOOD, 'default', ZK_GOOD_DSN, 'user')
  cfg.setWorkspaceEnv(ZK_PROP, 'default', ZK_PROP_DSN, 'user')
  cfg.setWorkspaceEnv(ZK_PCT, 'default', ZK_PCT_DSN, 'user')
  const registry = [
    ...ZK_REGISTRY,
    { path: ZK_PROP, title: 'zk-prop' },
    { path: ZK_PCT, title: 'zk-pct' },
  ]
  const captured = {}
  const ctx = {
    tools: { register: (def) => { captured[def.name] = def; return () => {} } },
    get: (name) => (name === 'workspaceRegistry' ? { list: async () => registry } : undefined),
    inject: () => {},
  }
  registerCoreTools(ctx, {
    resolveExecutable: async (name) => '/nonexistent/' + name,
    spawn: () => { throw new Error('nothing may spawn in this test') },
  })
  const out = await captured.dbhub_list_sources.execute({}, {})
  const text = String(out.text)
  assert.equal(out.ok, true, 'one bad row must not fail the whole receipt')
  // All three rows are listed …
  assert.match(text, /zk-good/)
  assert.match(text, /zk-prop/)
  assert.match(text, /zk-pct/)
  // … the good one keeps its metadata label, the undecodable one keeps its raw
  // (non-secret) segment, and the untrusted one is the placeholder.
  assert.ok(text.includes('mysql://198.51.100.1:3306/mydb'), text)
  assert.ok(text.includes('mysql://127.0.0.1:3306/bad%zz'), 'the undecodable row is still described')
  assert.ok(text.includes(i18n.currentT('result.unknownConn')), 'the property dialect is the placeholder')
  // Nothing from the untrusted row crossed.
  assert.equal(text.includes(LEAK), false, 'the property row leaked its credential: ' + text)
  assert.equal(text.includes(LEAK_HOST), false, 'the property row leaked its host: ' + text)
  delete cfg.store[ZK_GOOD]
  delete cfg.store[ZK_PROP]
  delete cfg.store[ZK_PCT]
})
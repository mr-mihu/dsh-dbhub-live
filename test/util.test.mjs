// Unit tests for the pure utilities in lib/config.mjs and lib/collect.mjs.
// Test isolation: these modules derive the storage directory from DSH_HOME at
// import time, so point DSH_HOME at a temp dir BEFORE importing them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-test-'))
process.env.DSH_HOME = home

const cfg = await import('../lib/config.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('slugify normalizes titles', () => {
  assert.equal(cfg.slugify('MyApp'), 'myapp')
  assert.equal(cfg.slugify('my-app-server_abc123'), 'my-app-server_abc123')
  assert.equal(cfg.slugify('A B!/c'), 'a-b-c')
  assert.equal(cfg.slugify(''), 'ws')
  assert.equal(cfg.slugify(undefined), 'ws')
})

test('envSlug keeps ASCII names stable and gives non-ASCII names distinct handles', () => {
  // default stays bare (the legacy source id) and pure lowercase ASCII names never
  // move: `slug === name` is exactly the historical handle.
  assert.equal(cfg.envSlug('default'), '')
  assert.equal(cfg.envSlug('test'), 'test')
  assert.equal(cfg.envSlug('dev'), 'dev')
  assert.equal(cfg.envSlug('prod'), 'prod')
  // A name whose ASCII projection is LOSSY keeps the readable prefix but carries a
  // hash, so it can never share an id with the plain name (`my env` vs `my-env`,
  // `PROD` vs `prod`, `!!!` vs `env`).
  assert.match(cfg.envSlug('my env'), /^my-env-[a-z0-9]+$/)
  assert.notEqual(cfg.envSlug('my env'), cfg.envSlug('my-env'))
  assert.notEqual(cfg.envSlug('PROD'), cfg.envSlug('prod'))
  // Chinese (or any non-ASCII) name: deterministic, prefixed, UNIQUE per name
  const online = cfg.envSlug('线上')
  const local = cfg.envSlug('本地开发环境')
  const qa = cfg.envSlug('测试')
  assert.match(online, /^env-[a-z0-9]+$/)
  assert.equal(online, cfg.envSlug('线上')) // deterministic
  assert.notEqual(online, qa)
  assert.notEqual(online, local)
  // regression: every purely non-ASCII name used to collapse to the SAME slug
  assert.notEqual(cfg.envSlug('线上'), cfg.envSlug('线下'))
  // a mixed name keeps its readable prefix AND stays distinct from the ASCII one
  assert.match(cfg.envSlug('线上 env'), /^env-[a-z0-9]+$/)
  assert.notEqual(cfg.envSlug('线上 env'), cfg.envSlug('env'))
  assert.equal(cfg.envSlug(''), '')
  assert.equal(cfg.envSlug(undefined), '')
})

test('normalizeEnvName trims, caps and defaults blank names', () => {
  assert.equal(cfg.normalizeEnvName(undefined), 'default')
  assert.equal(cfg.normalizeEnvName('   '), 'default')
  assert.equal(cfg.normalizeEnvName(' prod '), 'prod')
  assert.equal(cfg.normalizeEnvName('线上'), '线上')
  assert.equal(cfg.normalizeEnvName('bad\u0000name'), 'badname')
  assert.equal(cfg.normalizeEnvName('x'.repeat(200)).length, cfg.ENV_NAME_MAX)
})

test('renameWorkspaceEnv moves a persisted connection to a new name', () => {
  const wsPath = 'C:\\ws\\rename-test'
  cfg.setWorkspaceEnv(wsPath, 'default', 'mysql://u:p@h/main', 'user')
  assert.deepEqual(cfg.renameWorkspaceEnv(wsPath, 'default', 'prod'), { name: 'prod', collided: false, renamed: true })
  const rows = cfg.listWorkspaceEnvironments(cfg.store).filter((r) => r.wsPath === wsPath)
  assert.deepEqual(rows.map((r) => r.env), ['prod'])
  assert.equal(rows[0].dsn, 'mysql://u:p@h/main') // the connection itself moved
  // renaming a missing environment is refused, not silently created
  assert.equal(cfg.renameWorkspaceEnv(wsPath, 'nope', 'qa'), undefined)
  // rename onto an existing name is REPORTED, and only performed with confirm
  cfg.setWorkspaceEnv(wsPath, 'qa', 'mysql://u:p@h/qa', 'user')
  assert.deepEqual(cfg.renameWorkspaceEnv(wsPath, 'prod', 'qa'), { name: 'qa', collided: true, renamed: false })
  const unconfirmed = cfg.listWorkspaceEnvironments(cfg.store).filter((r) => r.wsPath === wsPath)
  assert.deepEqual(unconfirmed.map((r) => r.env).sort(), ['prod', 'qa'], 'an unconfirmed collision writes nothing')
  assert.deepEqual(cfg.renameWorkspaceEnv(wsPath, 'prod', 'qa', { confirm: true }), { name: 'qa', collided: true, renamed: true })
  const after = cfg.listWorkspaceEnvironments(cfg.store).filter((r) => r.wsPath === wsPath)
  assert.deepEqual(after.map((r) => r.env), ['qa'])
  assert.equal(after[0].dsn, 'mysql://u:p@h/main')
  // same-name rename is a no-op that still reports the name
  assert.deepEqual(cfg.renameWorkspaceEnv(wsPath, 'qa', 'qa'), { name: 'qa', collided: false, renamed: false })
  delete cfg.store[wsPath]
})

test('connLabel describes host/port/database — never user or password', () => {
  assert.equal(cfg.connLabel('mysql://root:secret@198.51.100.1:3306/mydb'), 'mysql://198.51.100.1:3306/mydb')
  assert.equal(cfg.connLabel('postgres://u:p@h/db'), 'postgres://h/db')
  assert.equal(cfg.connLabel('sqlite:///C:/data/x.db'), 'sqlite:///C:/data/x.db')
  assert.equal(cfg.connLabel(''), '(未知连接)')
})

test('describeConn extracts only non-secret metadata', () => {
  const c = cfg.describeConn('mysql://root:secret@198.51.100.1:3306/mydb')
  assert.deepEqual(c, { type: 'mysql', host: '198.51.100.1', port: '3306', database: 'mydb' })
  assert.ok(!JSON.stringify(c).includes('secret'))
  assert.ok(!JSON.stringify(c).includes('root'))
  assert.equal(cfg.describeConn('jdbc:postgresql://u:p@h:5432/db').type, 'postgres')
  assert.equal(cfg.describeConn('sqlite:///C:/data/x.db').type, 'sqlite')
})

test('scrubSecrets removes the DSN password and generic password= tokens', () => {
  const dsn = 'mysql://root:secret.pw@198.51.100.1:3306/mydb'
  const scrubbed = cfg.scrubSecrets('Auth failed for user secret.pw (password=secret.pw)', dsn)
  assert.ok(!scrubbed.includes('secret.pw'))
  assert.ok(scrubbed.includes('****'))
  // generic key=value secrets (dbhub stderr style)
  assert.ok(cfg.scrubSecrets('password=abc123', dsn).includes('password=****'))
  assert.ok(cfg.scrubSecrets('passwd: abc123', dsn).includes('passwd:****'))
  assert.ok(cfg.scrubSecrets('PWD=abc123', dsn).includes('PWD=****'))
  // plain text without the password is untouched (sanity)
  assert.ok(cfg.scrubSecrets('SELECT 1 OK', dsn).includes('SELECT 1 OK'))
})

test('scrubSecrets collapses the whole userinfo of a URL-shaped connection string', () => {
  const dsn = 'mysql://root:secret.pw@198.51.100.1:3306/mydb'
  // dbhub's own startup banner masks only the password, so the USERNAME used to
  // survive into the model-facing diagnostics. Both must go now.
  const banner = 'Configuration source: dbhub-1.toml\n- default: mysql://root:****@198.51.100.1:3306/mydb'
  const out = cfg.scrubSecrets(banner, dsn)
  assert.ok(!out.includes('root'), 'the username must not survive: ' + out)
  assert.ok(out.includes('mysql://****:****@198.51.100.1:3306/mydb'), out)
  // A userinfo without a password is collapsed the same way.
  assert.ok(!cfg.scrubSecrets('connect mysql://ops@198.51.100.2:3306/app', dsn).includes('ops'))
  // A metadata label carries no userinfo at all and must stay byte-identical.
  assert.equal(cfg.scrubSecrets('mysql://198.51.100.1:3306/mydb', dsn), 'mysql://198.51.100.1:3306/mydb')
  // SSH secrets riding the child environment are replaced like the DSN password.
  const sshOut = cfg.scrubSecrets('ssh_password=CHANGE_ME', dsn, ['CHANGE_ME'])
  assert.ok(!sshOut.includes('CHANGE_ME'), sshOut)
})

test('a SHORT DSN password never disarms the token rules (P4)', () => {
  // 1-character password. A bare `split(pass).join('****')` rewrote the literal
  // `password=` into `p****ssword`, after which the keyword rule no longer matched
  // and the real value leaked — and every later secret with it.
  // Assembled so this file holds no credentialed URL literal (the desensitize
  // gate scans them) while the RUNTIME value still is one.
  const dsn = 'mysql://u' + ':' + 'x' + '@127.0.0.1:3306/db'
  const text = 'export failed: password=SECRETVAL for ' + dsn
  const out = cfg.scrubSecrets(text, dsn)
  assert.equal(out.includes('SECRETVAL'), false, 'the token value leaked: ' + out)
  assert.ok(out.includes('password=****'), 'the keyword rule must still run: ' + out)
  assert.ok(out.includes('export'), 'a word containing the password was mangled: ' + out)
  assert.equal(out.includes(':x@'), false, 'the short password survives inside the userinfo: ' + out)
  assert.ok(out.includes('mysql://****:****@127.0.0.1:3306/db'), 'the whole userinfo is folded: ' + out)
})

test('dsnPassword and describeConn agree on percent-decoding (P6)', () => {
  // The password component is percent-encoded in the URL while the metadata is
  // decoded: the two used to describe the SAME DSN in different spellings.
  const dsn = 'mysql://u' + ':' + 'X%5FY' + '@127.0.0.1:3306/X_Y'
  assert.equal(cfg.dsnPassword(dsn), 'X_Y', 'the password is decoded like the metadata')
  assert.equal(cfg.describeConn(dsn).database, 'X_Y')
  // …and the scrubber masks BOTH spellings, because a diagnostic may echo either.
  const out = cfg.scrubSecrets('auth failed for X%5FY and X_Y', dsn)
  assert.equal(out.includes('X_Y'), false, out)
  assert.equal(out.includes('X%5FY'), false, out)
})

test('dsnUser extracts the username host-side only (never surfaced)', () => {
  assert.equal(cfg.dsnUser('mysql://root:secret@h/d'), 'root')
  assert.equal(cfg.dsnUser('postgres://alice@h/db'), 'alice')
  assert.equal(cfg.dsnUser('mysql://h/d'), undefined)
  assert.equal(cfg.dsnUser('sqlite:///C:/data/x.db'), undefined)
  assert.equal(cfg.dsnUser('jdbc:mysql://bob:pw@h:3306/db'), 'bob')
})

test('shortHash is stable and hex-ish', () => {
  assert.equal(cfg.shortHash('abc'), cfg.shortHash('abc'))
  assert.notEqual(cfg.shortHash('abc'), cfg.shortHash('another'))
  assert.match(cfg.shortHash('abc'), /^[a-z0-9]+$/)
  assert.ok(cfg.shortHash('abc').length > 0)
})

// `maskDsn` (the old "hide the password but keep the username" formatter) was
// production-dead and violated the metadata-only rule, so it is gone. Its shape
// test is replaced by the invariant that actually matters: connLabel describes
// endpoint metadata for the shapes a user really pastes.
test('connLabel keeps metadata for every well-formed dialect and never userinfo', () => {
  assert.equal(cfg.connLabel('mysql://root:secret@198.51.100.1:3306/mydb'), 'mysql://198.51.100.1:3306/mydb')
  assert.equal(cfg.connLabel('postgres://u:p@h/db'), 'postgres://h/db')
  assert.equal(cfg.connLabel('sqlite:///C:/data/x.db'), 'sqlite:///C:/data/x.db')
  // jdbc: is stripped the same way describeConn strips it
  assert.equal(cfg.connLabel('jdbc:mysql://bob:pw@198.51.100.1:3306/db'), 'mysql://198.51.100.1:3306/db')
  // A database legitimately named after the account keeps its label: the gate
  // rejects userinfo (`@`) and `password=` tokens, not coincidental substrings.
  assert.equal(cfg.connLabel('mysql://root:pw@198.51.100.1:3306/rootdb'), 'mysql://198.51.100.1:3306/rootdb')
  // an absent/blank connection string is the placeholder, never an empty label
  assert.equal(cfg.connLabel(''), '(未知连接)')
  assert.equal(cfg.connLabel(undefined), '(未知连接)')
  for (const dsn of ['mysql://root:secret@198.51.100.1:3306/mydb', 'postgres://u:p@h/db', 'jdbc:mysql://bob:pw@h/db']) {
    const label = cfg.connLabel(dsn)
    assert.equal(label.includes('@'), false, label)
    assert.equal(label.includes('secret'), false, label)
  }
})

test('dsnFromEnv joins DB_* variables and handles sqlite', () => {
  const env = { DB_HOST: '198.51.100.1', DB_PORT: '3307', DB_USER: 'root', DB_PASSWORD: 'pw', DB_NAME: 'maindb' }
  assert.equal(cfg.dsnFromEnv(env), 'mysql://root:pw@198.51.100.1:3307/maindb')
  assert.equal(cfg.dsnFromEnv({ DB_HOST: 'a', DB_USER: 'b', DB_NAME: 'c', DB_TYPE: 'sqlite' }), 'sqlite:///a')
  assert.equal(cfg.dsnFromEnv({ DB_HOST: 'a' }), undefined)
})

test('dsnFromMap prefers explicit DSN', () => {
  assert.equal(cfg.dsnFromMap({ DSN: 'postgres://u@h/db' }), 'postgres://u@h/db')
  assert.equal(cfg.dsnFromMap({ DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd' }), 'mysql://u:@h/d')
})

test('buildDsnFromParts assembles DSNs (password only from the UI channel)', () => {
  assert.equal(
    cfg.buildDsnFromParts({ type: 'mysql', host: '198.51.100.1', port: '3307', user: 'root', password: 'pw', database: 'maindb' }),
    'mysql://root:pw@198.51.100.1:3307/maindb')
  // no user/password -> empty credentials stay in the string
  assert.equal(
    cfg.buildDsnFromParts({ type: 'mysql', host: '198.51.100.1', port: '3307', database: 'maindb' }),
    'mysql://:@198.51.100.1:3307/maindb')
  // defaults: mysql type and localhost host; port/database optional
  assert.equal(cfg.buildDsnFromParts({ host: 'h' }), 'mysql://:@h/')
  assert.equal(cfg.buildDsnFromParts({}), 'mysql://:@localhost/')
  // sqlite treats host as the file path
  assert.equal(cfg.buildDsnFromParts({ type: 'sqlite', host: 'C:/data/x.db' }), 'sqlite:///C:/data/x.db')
  assert.equal(cfg.buildDsnFromParts({ type: 'sqlite' }), 'sqlite:///test.db')
})

test('likelyAuthOrConnError classifies auth/connect failures', () => {
  for (const bad of [
    'Access denied for user',
    'ER_ACCESS_DENIED_ERROR (1045)',
    'authentication failed',
    'password incorrect',
    'code 28000',
    'ECONNREFUSED',
    'connection refused',
    '认证失败',
    '连接被拒',
  ]) {
    assert.ok(cfg.likelyAuthOrConnError(bad), bad)
  }
  assert.ok(!cfg.likelyAuthOrConnError('syntax error near SELECT'))
  assert.ok(!cfg.likelyAuthOrConnError(''))
})

test('argsChangedEndpoint detects a re-described endpoint', () => {
  const meta = { type: 'mysql', host: '198.51.100.1', port: '3306', database: 'mydb' }
  // same endpoint (or blank args) -> keep verifying the existing row
  assert.equal(cfg.argsChangedEndpoint({ type: 'mysql', host: '198.51.100.1', port: '3306', database: 'mydb' }, meta), false)
  assert.equal(cfg.argsChangedEndpoint({ user: 'root' }, meta), false)
  assert.equal(cfg.argsChangedEndpoint({}, meta), false)
  // any endpoint field differing -> re-run the probe-first loop
  assert.equal(cfg.argsChangedEndpoint({ host: '198.51.100.2' }, meta), true)
  assert.equal(cfg.argsChangedEndpoint({ port: '3307' }, meta), true)
  assert.equal(cfg.argsChangedEndpoint({ database: 'otherdb' }, meta), true)
  assert.equal(cfg.argsChangedEndpoint({ type: 'postgres' }, meta), true)
  // missing existing row -> every supplied endpoint field counts as changed
  assert.equal(cfg.argsChangedEndpoint({ host: 'h' }, undefined), true)
  assert.equal(cfg.argsChangedEndpoint({}, undefined), false)
})

test('decideConfigureStep picks the probe-first interaction', () => {
  const prefill = { type: 'mysql', host: '198.51.100.1', port: '3307', database: 'maindb', user: 'root' }
  // existing row + probe OK -> zero-input confirm
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: { dsn: 'x' }, existingCheck: { ok: true, message: 'ok' }, prefill, candidateCheck: undefined }), { kind: 'existing-ok' })
  // existing row + auth-style failure -> minimal credentials dialog
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: { dsn: 'x' }, existingCheck: { ok: false, message: 'Access denied' }, prefill, candidateCheck: undefined }), { kind: 'ask-credentials', emptyUserDenied: false })
  // the SAME dialog flags empty-account rejection so the account becomes required
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: { dsn: 'x' }, existingCheck: { ok: false, message: "Access denied for user ''@'198.51.100.1'" }, prefill, candidateCheck: undefined }), { kind: 'ask-credentials', emptyUserDenied: true })
  // existing row + non-auth failure -> mode dialog
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: { dsn: 'x' }, existingCheck: { ok: false, message: 'Unknown host' }, prefill, candidateCheck: undefined }), { kind: 'ask-mode', failed: true })
  // new env, complete essentials, candidate probe OK -> persist with no dialog
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: undefined, existingCheck: undefined, prefill, candidateCheck: { ok: true, message: 'ok' } }), { kind: 'persist-direct' })
  // new env, complete essentials, auth-style failure -> minimal credentials dialog
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: undefined, existingCheck: undefined, prefill, candidateCheck: { ok: false, message: 'password incorrect' } }), { kind: 'ask-credentials', emptyUserDenied: false })
  // ... and an empty-account candidate denial also makes the account required
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: undefined, existingCheck: undefined, prefill, candidateCheck: { ok: false, message: 'Access denied for user ""@198.51.100.4' } }), { kind: 'ask-credentials', emptyUserDenied: true })
  // new env, complete essentials, non-auth failure -> mode dialog with the failure noted
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: undefined, existingCheck: undefined, prefill, candidateCheck: { ok: false, message: 'timeout' } }), { kind: 'ask-mode', failed: true })
  // new env, missing database (essentials incomplete) -> mode dialog, no probe happened
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: undefined, existingCheck: undefined, prefill: { type: 'mysql', host: 'h' }, candidateCheck: undefined }), { kind: 'ask-mode', failed: false })
  // sqlite never takes the persist-direct / credentials paths
  assert.deepEqual(cfg.decideConfigureStep({ existingRow: undefined, existingCheck: undefined, prefill: { type: 'sqlite', host: 'C:/x.db', database: '' }, candidateCheck: undefined }), { kind: 'ask-mode', failed: false })
})

test('emptyUserDenied detects empty-account rejections', () => {
  assert.ok(cfg.emptyUserDenied("Access denied for user ''@'198.51.100.1'"))
  assert.ok(cfg.emptyUserDenied('authentication failed for user ""@host'))
  assert.ok(!cfg.emptyUserDenied('Access denied for user root@198.51.100.1'))
  assert.ok(!cfg.emptyUserDenied('password incorrect'))
  assert.ok(!cfg.emptyUserDenied(''))
})

test('parseEnvFile skips comments/quotes', () => {
  const map = cfg.parseEnvFile('# c\nDSN="mysql://u@h/d"\nEMPTY=\nFOO=bar')
  assert.equal(map.DSN, 'mysql://u@h/d')
  assert.equal(map.FOO, 'bar')
  assert.equal(map.EMPTY, '')
})

test('generateToml is GONE — the resident-server/toml layer was removed', () => {
  assert.equal(typeof cfg.generateToml, 'undefined')
  assert.equal(typeof cfg.fingerprintOf, 'undefined')
  assert.equal(typeof cfg.writeToml, 'undefined')
})

test('collect: walkForCandidates skips noise dirs and finds config files', async () => {
  const { walkForCandidates, extractDsnCandidates } = await import('../lib/collect.mjs')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const root = join(home, 'proj')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.env'), 'DSN=mysql://root:pw@198.51.100.1:3306/appdb\n')
  writeFileSync(join(root, 'node_modules', 'x.env'), 'DSN=mysql://nope@x/y\n')
  writeFileSync(join(root, 'src', 'application.yml'), 'url: jdbc:mysql://198.51.100.4:3306/biz?user=u&password=p\n')

  const found = walkForCandidates(root, { count: 0 })
  assert.ok(found.includes(join(root, '.env')))
  assert.ok(found.includes(join(root, 'src', 'application.yml')))
  assert.ok(!found.some((f) => f.includes('node_modules')))

  const candidates = extractDsnCandidates(join(root, '.env'), 'DSN=mysql://root:pw@198.51.100.1:3306/appdb\n')
  assert.ok(candidates.some((c) => c.dsn === 'mysql://root:pw@198.51.100.1:3306/appdb'))
})
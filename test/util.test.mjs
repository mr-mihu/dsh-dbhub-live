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

test('connLabel describes host/port/database — never user or password', () => {
  assert.equal(cfg.connLabel('mysql://root:secret@10.0.0.1:3306/mydb'), 'mysql://10.0.0.1:3306/mydb')
  assert.equal(cfg.connLabel('postgres://u:p@h/db'), 'postgres://h/db')
  assert.equal(cfg.connLabel('sqlite:///C:/data/x.db'), 'sqlite:///C:/data/x.db')
  assert.equal(cfg.connLabel(''), '(未知连接)')
})

test('describeConn extracts only non-secret metadata', () => {
  const c = cfg.describeConn('mysql://root:secret@10.0.0.1:3306/mydb')
  assert.deepEqual(c, { type: 'mysql', host: '10.0.0.1', port: '3306', database: 'mydb' })
  assert.ok(!JSON.stringify(c).includes('secret'))
  assert.ok(!JSON.stringify(c).includes('root'))
  assert.equal(cfg.describeConn('jdbc:postgresql://u:p@h:5432/db').type, 'postgres')
  assert.equal(cfg.describeConn('sqlite:///C:/data/x.db').type, 'sqlite')
})

test('scrubSecrets removes the DSN password and generic password= tokens', () => {
  const dsn = 'mysql://root:secret.pw@10.0.0.1:3306/mydb'
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

test('maskDsn hides passwords, keeps host/db', () => {
  assert.equal(cfg.maskDsn('mysql://root:secret@10.0.0.1:3306/mydb'),
    'mysql://root:****@10.0.0.1:3306/mydb')
  assert.equal(cfg.maskDsn('postgres://u:p@h/db'), 'postgres://u:****@h/db')
  // no password -> unchanged
  assert.equal(cfg.maskDsn('sqlite:///C:/data/x.db'), 'sqlite:///C:/data/x.db')
  // unparseable DSN falls back to regex masking
  assert.equal(cfg.maskDsn('mysql://root:secret@h:3306/d'), 'mysql://root:****@h:3306/d')
})

test('dsnFromEnv joins DB_* variables and handles sqlite', () => {
  const env = { DB_HOST: '10.0.0.1', DB_PORT: '3307', DB_USER: 'root', DB_PASSWORD: 'pw', DB_NAME: 'maindb' }
  assert.equal(cfg.dsnFromEnv(env), 'mysql://root:pw@10.0.0.1:3307/maindb')
  assert.equal(cfg.dsnFromEnv({ DB_HOST: 'a', DB_USER: 'b', DB_NAME: 'c', DB_TYPE: 'sqlite' }), 'sqlite:///a')
  assert.equal(cfg.dsnFromEnv({ DB_HOST: 'a' }), undefined)
})

test('dsnFromMap prefers explicit DSN', () => {
  assert.equal(cfg.dsnFromMap({ DSN: 'postgres://u@h/db' }), 'postgres://u@h/db')
  assert.equal(cfg.dsnFromMap({ DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd' }), 'mysql://u:@h/d')
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
  writeFileSync(join(root, '.env'), 'DSN=mysql://root:pw@10.0.0.1:3306/appdb\n')
  writeFileSync(join(root, 'node_modules', 'x.env'), 'DSN=mysql://nope@x/y\n')
  writeFileSync(join(root, 'src', 'application.yml'), 'url: jdbc:mysql://1.2.3.4:3306/biz?user=u&password=p\n')

  const found = walkForCandidates(root, { count: 0 })
  assert.ok(found.includes(join(root, '.env')))
  assert.ok(found.includes(join(root, 'src', 'application.yml')))
  assert.ok(!found.some((f) => f.includes('node_modules')))

  const candidates = extractDsnCandidates(join(root, '.env'), 'DSN=mysql://root:pw@10.0.0.1:3306/appdb\n')
  assert.ok(candidates.some((c) => c.dsn === 'mysql://root:pw@10.0.0.1:3306/appdb'))
})
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
  assert.equal(cfg.slugify('hbtx-server-master_1hn7yaw'), 'hbtx-server-master_1hn7yaw')
  assert.equal(cfg.slugify('A B!/c'), 'a-b-c')
  assert.equal(cfg.slugify(''), 'ws')
  assert.equal(cfg.slugify(undefined), 'ws')
})

test('tomlEscape escapes backslash, quotes and newlines', () => {
  assert.equal(cfg.tomlEscape('a"b'), 'a\\"b')
  assert.equal(cfg.tomlEscape('a\\b'), 'a\\\\b')
  assert.equal(cfg.tomlEscape('a\nb'), 'a\\nb')
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
  const env = { DB_HOST: '10.0.0.1', DB_PORT: '3307', DB_USER: 'root', DB_PASSWORD: 'pw', DB_NAME: 'tx_zdsf_main_pro' }
  assert.equal(cfg.dsnFromEnv(env), 'mysql://root:pw@10.0.0.1:3307/tx_zdsf_main_pro')
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

test('generateToml and fingerprintOf', () => {
  const sources = [{ id: 'ws_abc', dsn: 'mysql://u@h/d' }]
  const toml = cfg.generateToml(sources)
  assert.match(toml, /^# Auto-generated/)
  assert.match(toml, /id = "ws_abc"/)
  assert.match(toml, /dsn = "mysql:\/\/u@h\/d"/)
  assert.match(toml, /lazy = true/)
  assert.notEqual(cfg.fingerprintOf(sources), cfg.fingerprintOf([{ id: 'ws_abc', dsn: 'other' }]))
})

test('generateToml emits lazy = true for EVERY source (one dead env must not kill the server)', () => {
  const sources = [
    { id: 'hbtx_1hn7yaw', dsn: 'mysql://root:pw@10.253.0.3:3307/tx_zdsf_main_pro' },
    { id: 'hbtx_1hn7yaw_test', dsn: 'mysql://root:pw@10.253.0.6:1688/db_zdsf' },
    { id: 'other_2', dsn: 'sqlite:///C:/data/x.db' },
  ]
  const blocks = cfg.generateToml(sources).split('[[sources]]').slice(1)
  assert.equal(blocks.length, 3)
  for (const b of blocks) {
    assert.match(b, /id = ".+"/)
    assert.match(b, /dsn = ".+"/)
    assert.match(b, /lazy = true/)
  }
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
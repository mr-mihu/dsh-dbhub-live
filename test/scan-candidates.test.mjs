// The scan picker's candidate labels (lib/tools.mjs `scanCandidateOptions`).
//
// `connLabel` is metadata ONLY (host/port/database), so two credentials for the
// same database produced IDENTICAL option labels — "use the prod one" could
// persist the dev DSN while both the user and the model believed the choice was
// unambiguous. The label now carries an ordinal and a credential marker, and
// neither may ever contain a secret.
//
// Test isolation: tools.mjs pulls in config.mjs, which binds its storage dir at
// import time — point DSH_HOME at a temp dir BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-scan-'))
process.env.DSH_HOME = home

const tools = await import('../lib/tools.mjs')
const { connLabel } = await import('../lib/config.mjs')
const { setLocaleProvider } = await import('../lib/i18n.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
  setLocaleProvider(() => 'zh')
})

// One database, two credentials: the exact shape that collided (a .env pointing
// at the pooled app user, a compose file at the owner).
const DSN_APP = 'postgres://app:CHANGE_ME@127.0.0.1:5432/app'
const DSN_OWNER = 'postgres://owner:CHANGE_ME@127.0.0.1:5432/app'
const DSN_NOPASS = 'postgres://app@127.0.0.1:5432/app'

const RAW = [
  { rel: '.env', dsn: DSN_APP, via: '.env' },
  { rel: './docker-compose.yml', dsn: DSN_OWNER, via: 'compose' },
  { rel: './ci/.env', dsn: DSN_NOPASS, via: '.env' },
]

test('two candidates for ONE database are distinguishable', () => {
  // The premise: metadata alone cannot tell them apart.
  assert.equal(connLabel(DSN_APP), connLabel(DSN_OWNER), 'same host/port/db — that is the collision')

  const options = tools.scanCandidateOptions(RAW)
  assert.equal(options.length, 3)
  const labels = options.map((o) => o.label)
  assert.equal(new Set(labels).size, labels.length, 'every option label must be unique: ' + JSON.stringify(labels))
  // The ordinal leads, so the choice can be spoken back unambiguously.
  assert.match(labels[0], /^#1 /)
  assert.match(labels[1], /^#2 /)
  assert.match(labels[2], /^#3 /)
  // …and the credential marker says which look-alike will actually authenticate.
  assert.match(labels[0], /含密码/)
  assert.match(labels[2], /无密码/)
  assert.notEqual(labels[0], labels[2])
  // The label carries the location, so the same database in two files is obvious.
  assert.match(labels[0], /\.env/)
  assert.match(labels[1], /docker-compose\.yml/)
})

test('a scan label never carries a secret or a raw DSN', () => {
  const options = tools.scanCandidateOptions(RAW)
  for (const option of options) {
    assert.equal(option.label.includes('CHANGE_ME'), false, option.label)
    // `connLabel` already strips the userinfo; the label must not put it back.
    assert.equal(option.label.includes('@'), false, option.label)
    assert.equal(option.label.includes('app:'), false, option.label)
    // The DSN itself is still there for the host half to persist — it just never
    // rides the label/description the model sees.
    assert.ok(option.dsn)
    assert.equal(option.description.includes('CHANGE_ME'), false)
  }
  assert.equal(options[0].dsn, DSN_APP, 'the picked row keeps its real DSN host-side')
})

test('the labels follow the host locale', () => {
  setLocaleProvider(() => 'en')
  const en = tools.scanCandidateOptions(RAW).map((o) => o.label)
  assert.match(en[0], /has a password/)
  assert.match(en[2], /no password/)
  setLocaleProvider(() => 'zh')
  const zh = tools.scanCandidateOptions(RAW).map((o) => o.label)
  assert.match(zh[0], /含密码/)
})

test('an empty / malformed list never throws', () => {
  assert.deepEqual(tools.scanCandidateOptions([]), [])
  assert.deepEqual(tools.scanCandidateOptions(undefined), [])
  assert.deepEqual(tools.scanCandidateOptions(null), [])
})

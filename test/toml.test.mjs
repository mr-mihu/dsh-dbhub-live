// Unit tests for lib/toml.mjs — the ONE-SHOT dbhub TOML generator.
//
// toml.mjs imports config.mjs, which binds its storage paths (DATA_DIR → TMP_DIR)
// from DSH_HOME at import time, so DSH_HOME must point at a fresh temp dir
// BEFORE the dynamic import; the module is loaded through a unique query string
// so this file always gets an instance bound to its own temp home.
//
// Fixtures obey the desensitization convention: loopback / RFC 5737 hosts and
// CHANGE_ME-class placeholders, never a real host, account or password.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-toml-'))
process.env.DSH_HOME = home

const toml = await import('../lib/toml.mjs?x=' + Date.now())

const {
  SECRET_ENV,
  TMP_DIR,
  buildDbhubToml,
  referencedVars,
  removeTempToml,
  sweepTempToml,
  tomlString,
  writeTempToml,
} = toml

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── fixtures / helpers ────────────────────────────────────────────────────

const DSN = 'mysql://u:CHANGE_ME@127.0.0.1:3306/appdb'
const SSH_PASSWORD = 'CHANGE_ME'
const SSH_PASSPHRASE = 'changeme'

/** True when the document contains this EXACT line. */
function hasLine(text, line) {
  return text.split('\n').includes(line)
}

/** Every `[[tools]]` section body, in order. */
function toolBlocks(text) {
  return text.split('[[tools]]').slice(1)
}

/**
 * The contract of buildDbhubToml: the set of `${VAR}` names referenced by the
 * text is EXACTLY the set of keys handed to the child environment — in both
 * directions (no reference without a value, no dead value).
 */
function assertVarSetsMatch(text, env) {
  assert.deepEqual(referencedVars(text).sort(), Object.keys(env).sort())
}

// ── read-only: the `[[tools]]` whitelist trap ─────────────────────────────

test('read-only emits EXACTLY the execute_sql + search_objects pair', () => {
  const { text, env } = buildDbhubToml({ dsn: DSN, ro: true })
  // `[[tools]]` is a whitelist, not a patch: one entry suppresses dbhub's
  // default pair, so a read-only config must list BOTH tools or search_objects
  // dies with "Tool search_objects not found".
  const blocks = toolBlocks(text)
  assert.equal((text.match(/\[\[tools\]\]/g) || []).length, 2)
  assert.equal(blocks.length, 2)
  assert.match(blocks[0], /name = "execute_sql"/)
  assert.match(blocks[0], /readonly = true/)
  assert.match(blocks[1], /name = "search_objects"/)
  assert.doesNotMatch(blocks[1], /readonly/)
  // `readonly = true` appears exactly once, inside the execute_sql block only
  assert.equal((text.match(/readonly = true/g) || []).length, 1)
  // both tools are pinned to the single generated source
  assert.equal((text.match(/source = "default"/g) || []).length, 2)
  assertVarSetsMatch(text, env)
})

test('no options (ro false, ssh null) emits no [[tools]] section at all', () => {
  const { text, env } = buildDbhubToml({ dsn: DSN, ro: false, ssh: null })
  assert.equal(text.includes('[[tools]]'), false)
  assert.equal(text.includes('readonly'), false)
  assert.equal(text.split('\n')[0], '[[sources]]')
  assert.ok(hasLine(text, 'id = "default"'))
  assert.deepEqual(env, { [SECRET_ENV.dsn]: DSN })
  // omitted options behave exactly like explicit ones (and never throw)
  assert.equal(buildDbhubToml({ dsn: DSN }).text, text)
  assert.equal(buildDbhubToml({ dsn: DSN, ro: undefined, ssh: undefined }).text, text)
})

test('a truthy-but-not-true ro is not read-only', () => {
  // The flag is strict (`c.ro === true`): a hand-edited string must not turn
  // the only-write-protection on by accident.
  for (const ro of ['true', 1, {}, []]) {
    const { text } = buildDbhubToml({ dsn: DSN, ro })
    assert.equal(text.includes('[[tools]]'), false, 'ro=' + JSON.stringify(ro))
  }
})

// ── dsn is always a placeholder ───────────────────────────────────────────

test('the dsn value never appears in the text (placeholder + child env)', () => {
  const { text, env } = buildDbhubToml({ dsn: DSN })
  assert.ok(hasLine(text, 'dsn = "${' + SECRET_ENV.dsn + '}"'))
  assert.equal(text.includes(DSN), false)
  assert.equal(text.includes('CHANGE_ME'), false) // no password half either
  assert.equal(text.includes('127.0.0.1'), false) // nor the host
  assert.equal(env[SECRET_ENV.dsn], DSN)
  assertVarSetsMatch(text, env)
})

test('a missing dsn still leaves the variable DEFINED for the child', () => {
  // dbhub keeps an undefined `${VAR}` verbatim and fails later, obscurely.
  for (const conn of [undefined, null, {}, { dsn: '' }, { dsn: '   ' }, { dsn: 42 }]) {
    const { text, env } = buildDbhubToml(conn)
    assert.equal(text.includes('dsn ='), false)
    assert.ok(hasLine(text, 'id = "default"'))
    assert.equal(env[SECRET_ENV.dsn], '')
    // every name the text references has a value (subset direction: this is the
    // case where the env intentionally carries one more key than the text uses)
    for (const name of referencedVars(text)) assert.ok(name in env, name)
  }
  assert.equal(buildDbhubToml().text.split('\n')[0], '[[sources]]')
})

test('referenced ${VARS} and env keys match in BOTH directions', () => {
  const combos = [
    { dsn: DSN },
    { dsn: DSN, ro: true },
    { dsn: DSN, ssh: { host: '192.0.2.11', port: 2222, user: 'deploy', auth: 'password', password: SSH_PASSWORD } },
    { dsn: DSN, ssh: { host: '192.0.2.10', user: 'deploy', auth: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: SSH_PASSPHRASE } },
    { dsn: DSN, ro: true, ssh: { host: '192.0.2.10', port: 22, user: 'deploy', auth: 'key', keyPath: '/keys/id', proxyJump: 'deploy@192.0.2.12:22' } },
  ]
  for (const conn of combos) {
    const { text, env } = buildDbhubToml(conn)
    assertVarSetsMatch(text, env)
    // direction 2 is the real one: no environment entry is dead weight
    for (const key of Object.keys(env)) {
      assert.ok(referencedVars(text).includes(key), key + ' is never referenced by the text')
    }
  }
})

// ── ssh tunnel fields ─────────────────────────────────────────────────────

test('ssh key auth emits host/port/user/key/proxy_jump and no password line', () => {
  const { text, env } = buildDbhubToml({
    dsn: DSN,
    ssh: {
      host: '192.0.2.10',
      port: 2222,
      user: 'deploy',
      auth: 'key',
      keyPath: '~/.ssh/id_ed25519',
      proxyJump: 'deploy@192.0.2.12:22',
    },
  })
  assert.ok(hasLine(text, 'ssh_host = "192.0.2.10"'))
  assert.ok(hasLine(text, 'ssh_port = 2222'))
  assert.ok(hasLine(text, 'ssh_user = "deploy"'))
  assert.ok(hasLine(text, 'ssh_key = "~/.ssh/id_ed25519"')) // verbatim: `~` is dbhub's to expand
  assert.ok(hasLine(text, 'ssh_proxy_jump = "deploy@192.0.2.12:22"'))
  assert.equal(text.includes('ssh_password'), false)
  assert.equal(SECRET_ENV.sshPassword in env, false)
  assert.equal(text.includes('ssh_passphrase'), false)
  assertVarSetsMatch(text, env)
})

test('only the ssh fields actually present are emitted', () => {
  const { text } = buildDbhubToml({
    dsn: DSN,
    ssh: { host: '192.0.2.10', user: 'deploy', auth: 'key', keyPath: '/keys/id' },
  })
  assert.ok(hasLine(text, 'ssh_key = "/keys/id"'))
  assert.equal(text.includes('ssh_port'), false) // no port -> no line (dbhub defaults it)
  assert.equal(text.includes('ssh_proxy_jump'), false)
  // a non-object ssh block is ignored entirely, never dereferenced
  const junk = buildDbhubToml({ dsn: DSN, ssh: 'yes' })
  assert.equal(junk.text.includes('ssh_'), false)
  assert.equal(buildDbhubToml({ dsn: DSN, ssh: 42 }).text.includes('ssh_'), false)
})

test('key material passes through verbatim, including a base64-ish blob', () => {
  // A path is not a secret; base64 key material and a Windows path both survive
  // unchanged. The blob is real base64 of a repeated pattern (base64 of
  // 'ABCDEFABCDEFABCDEF'), so it is obviously not a key AND stays low-entropy
  // enough for the desensitization gate (`npm run check:secrets`).
  const blob = 'QUJDREVGQUJDREVGQUJDREVG'
  const blobText = buildDbhubToml({
    dsn: DSN,
    ssh: { host: '192.0.2.10', user: 'deploy', auth: 'key', keyPath: blob },
  }).text
  assert.ok(hasLine(blobText, 'ssh_key = ' + tomlString(blob)))
  assert.ok(blobText.includes(blob))

  const winPath = 'C:\\keys\\id_ed25519'
  const winText = buildDbhubToml({
    dsn: DSN,
    ssh: { host: '192.0.2.10', user: 'deploy', auth: 'key', keyPath: winPath },
  }).text
  assert.ok(hasLine(winText, 'ssh_key = ' + tomlString(winPath)))
  assert.equal(winText.includes(winPath), false) // backslashes must be escaped for TOML
})

test('ssh_password only ever appears as a `${...}` placeholder', () => {
  const { text, env } = buildDbhubToml({
    dsn: DSN,
    ssh: {
      host: '192.0.2.11',
      port: 2222,
      user: 'deploy',
      auth: 'password',
      password: SSH_PASSWORD,
      proxyJump: 'deploy@192.0.2.12:22',
    },
  })
  assert.ok(hasLine(text, 'ssh_password = "${' + SECRET_ENV.sshPassword + '}"'))
  assert.equal(text.includes(SSH_PASSWORD), false, 'the real tunnel password reached the file')
  assert.equal(env[SECRET_ENV.sshPassword], SSH_PASSWORD) // it rides the child env instead
  assert.equal(text.includes('ssh_key'), false) // password auth never emits a key line
  assert.deepEqual(referencedVars(text).sort(), [SECRET_ENV.dsn, SECRET_ENV.sshPassword].sort())
  assertVarSetsMatch(text, env)
})

test('ssh_passphrase only ever appears as a `${...}` placeholder', () => {
  const { text, env } = buildDbhubToml({
    dsn: DSN,
    ssh: {
      host: '192.0.2.10',
      port: 22,
      user: 'deploy',
      auth: 'key',
      keyPath: '~/.ssh/id_ed25519',
      passphrase: SSH_PASSPHRASE,
    },
  })
  assert.ok(hasLine(text, 'ssh_passphrase = "${' + SECRET_ENV.sshPassphrase + '}"'))
  assert.equal(text.includes(SSH_PASSPHRASE), false, 'the real passphrase reached the file')
  assert.equal(env[SECRET_ENV.sshPassphrase], SSH_PASSPHRASE)
  assert.deepEqual(referencedVars(text).sort(), [SECRET_ENV.dsn, SECRET_ENV.sshPassphrase].sort())
  assertVarSetsMatch(text, env)

  // no passphrase -> no placeholder and no dead env entry
  const noPass = buildDbhubToml({
    dsn: DSN,
    ssh: { host: '192.0.2.10', port: 22, user: 'deploy', auth: 'key', keyPath: '~/.ssh/id_ed25519' },
  })
  assert.equal(noPass.text.includes('ssh_passphrase'), false)
  assert.equal(SECRET_ENV.sshPassphrase in noPass.env, false)
  assertVarSetsMatch(noPass.text, noPass.env)
})

// ── small pure helpers ────────────────────────────────────────────────────

test('referencedVars lists distinct ${VAR} names in order of appearance', () => {
  assert.deepEqual(referencedVars('${B} x ${A} ${B}'), ['B', 'A'])
  assert.deepEqual(referencedVars('${DSH_DBHUB_SEC_DSN}'), ['DSH_DBHUB_SEC_DSN'])
  assert.deepEqual(referencedVars('$A ${} ${1BAD} ${ok} $B'), ['ok'])
  assert.deepEqual(referencedVars(''), [])
  assert.deepEqual(referencedVars(undefined), [])
  assert.deepEqual(referencedVars(123), [])
})

test('tomlString escapes backslashes, quotes, newlines and tabs', () => {
  assert.equal(tomlString('plain'), '"plain"')
  assert.equal(tomlString('say "hi"'), '"say \\"hi\\""')
  assert.equal(tomlString('a\\b'), '"a\\\\b"') // backslash FIRST, so `\n` stays literal
  assert.equal(tomlString('l1\nl2'), '"l1\\nl2"')
  assert.equal(tomlString('tab\there'), '"tab\\there"')
  assert.equal(tomlString('cr\rhere'), '"cr\\rhere"')
  assert.equal(tomlString('C:\\keys\\a"b'), '"C:\\\\keys\\\\a\\"b"')
  // empty-ish values still produce a valid TOML string
  assert.equal(tomlString(undefined), '""')
  assert.equal(tomlString(null), '""')
  assert.equal(tomlString(''), '""')
  assert.equal(tomlString(7), '"7"')
})

// ── temp file lifecycle ───────────────────────────────────────────────────

test('writeTempToml returns an absolute path inside TMP_DIR and the file exists', () => {
  const path = writeTempToml('id = "default"\n')
  try {
    assert.ok(isAbsolute(path))
    assert.ok(path.startsWith(TMP_DIR + sep), path + ' is not under ' + TMP_DIR)
    assert.ok(existsSync(path))
    assert.equal(readFileSync(path, 'utf8'), 'id = "default"\n')
    // writeTempToml never reuses a name
    const second = writeTempToml('x')
    assert.notEqual(second, path)
    assert.equal(removeTempToml(second), true)
    assert.equal(removeTempToml(path), true)
    assert.equal(existsSync(path), false)
  } finally {
    removeTempToml(path)
  }
})

test('removeTempToml reports true for a missing path and never throws', () => {
  const missing = join(TMP_DIR, 'dbhub-no-such-config.toml')
  assert.equal(existsSync(missing), false)
  assert.equal(removeTempToml(missing), true)
  assert.equal(removeTempToml(''), true)
  assert.equal(removeTempToml(undefined), true)
})

test('sweepTempToml removes only stale matching files', () => {
  mkdirSync(TMP_DIR, { recursive: true })
  const stale = []
  const fresh = []
  for (let i = 0; i < 3; i++) stale.push(writeTempToml('stale ' + i))
  for (let i = 0; i < 2; i++) fresh.push(writeTempToml('fresh ' + i))
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
  for (const path of stale) utimesSync(path, tenMinutesAgo, tenMinutesAgo)

  // a non-matching name must never be touched …
  const stranger = join(TMP_DIR, 'notes.txt')
  writeFileSync(stranger, 'keep me')
  // … and neither must a directory that merely looks like a config
  const dirLike = join(TMP_DIR, 'dbhub-looks-like-a-config.toml')
  mkdirSync(dirLike, { recursive: true })
  utimesSync(dirLike, tenMinutesAgo, tenMinutesAgo)

  const removed = sweepTempToml(60 * 1000)
  assert.equal(removed, stale.length)
  for (const path of stale) assert.equal(existsSync(path), false, path + ' should have been swept')
  for (const path of fresh) assert.equal(existsSync(path), true, path + ' is in use and must survive')
  assert.equal(existsSync(stranger), true)
  assert.equal(readFileSync(stranger, 'utf8'), 'keep me')
  assert.equal(existsSync(dirLike), true)
})

test('sweepTempToml is a no-op when the temp directory does not exist', () => {
  // An unwritable/absent dir must return 0, not throw (it runs at boot).
  const saved = toml.TMP_DIR
  rmSync(saved, { recursive: true, force: true })
  assert.equal(sweepTempToml(1), 0)
  // put the directory back for the remaining tests / cleanup
  mkdirSync(saved, { recursive: true })
})

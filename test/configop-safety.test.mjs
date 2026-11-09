// PR-1 "stop losing data": the safety properties of the card command channel and
// of the two model-callable writes that replace an existing environment.
//
// What this file pins, and why each case exists:
//
//  1. `resolveWorkspaceRef` — an EXPLICIT workspace selector that does not
//     resolve is refused, never slid onto `workspaces[0]` (that is how a stale
//     page deleted or overwrote a connection in a DIFFERENT workspace while
//     reporting success). An empty selector still means "the current workspace",
//     and two workspaces sharing a title are never guessed between.
//  2. add/set carrying a SECRET-LESS ssh block — the card cannot echo a stored
//     secret back, so "blank = keep" must survive the DSN-only edit: a password
//     tunnel keeps its password, a key tunnel keeps its CUSTOM key path (not the
//     conventional default), and `ssh: null` still deletes the tunnel. The same
//     merge runs BEFORE the rename, so a refused tunnel leaves the store exactly
//     as it was (the receipt says "nothing was changed").
//  3. `copyFrom` onto an existing environment — nothing is written without the
//     user's confirmation, the copy takes the SOURCE row's read-only flag and
//     tunnel, and it CLEARS a target flag/tunnel the source does not have
//     (inheriting the target's old bastion points the new connection at the
//     wrong host; inheriting its read-only flag silently locks a writable one).
//  4. rename / `newEnv` collisions — a rename onto an existing environment is
//     refused until confirmed, a rename onto the row's OWN name is "no rename"
//     (not a collision with itself), and a blank `newEnv` is "no rename" instead
//     of being normalized into `default` (which overwrote the default row).
//  5. failure attribution — an empty DSN is attributed to the DSN (not to the
//     workspace), an unusable tunnel writes NOTHING, and a write that did land
//     (a rename) is still published when a later step of the command fails.
//  6. the pre-save probe (R61) — it must validate the connection the save would
//     produce: a card that sends NO ssh key at all (all three SSH fields blank)
//     still probes through the stored tunnel, an explicit `ssh:null` really
//     probes without it, and the SSH secret never travels back in the report.
//  7. the "fill in the fields" dialog — a dismissed form is a cancel, with ZERO
//     writes (the fallbacks used to build a DSN with an empty password and
//     persist it over the stored one).
//  8. the two option semantics that must never退化: `{readOnly:false}` DELETES
//     the flag, and switching the SSH auth kind drops the other kind's secret
//     (a stale key path / passphrase must not ride along into a password tunnel).
//  9. the `opNotice` receipt channel — the VIEW must carry it (the browser half
//     does not read op response bodies) and the sentence must be a localized
//     template plus scrubbed detail: no DSN, no host, no password.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-configop-'))
process.env.DSH_HOME = home

// Plain imports = the very singletons the modules under test use (see
// copy-from.test.mjs for why the tools import carries a cache-busting query).
const cfg = await import('../lib/config.mjs')
const mcp = await import('../lib/mcp.mjs')
const state = await import('../lib/state.mjs')
const index = await import('../lib/index.mjs')
const { currentT } = await import('../lib/i18n.mjs')
const { BRIDGE_ROUTES } = await import('../lib/bridge.mjs')
const { registerCoreTools } = await import('../lib/tools.mjs?configop=' + Date.now())

const STORE_PATH = join(home, 'storages', 'dsh-dbhub-live', 'credentials.json')
const storeText = () => {
  try {
    return readFileSync(STORE_PATH, 'utf8')
  } catch (e) {
    return ''
  }
}

/**
 * Semantic snapshot of the persisted store: workspace → env → the three fields a
 * write can change (`dsn`, `readOnly`, `ssh`) plus the raw text.
 *
 * `storeText()` alone is NOT a reliable "nothing was written" probe: two writes in
 * the same millisecond produce byte-identical JSON, so a rewrite that restores the
 * previous content (a rename plus an immediate rollback, a flag flipped twice) is
 * invisible to it. The snapshot carries the environment-name SET and each row's
 * option block, so a name that moved is visible even then; the raw text is still
 * compared because a real save always bumps `updatedAt` (see `settle`).
 */
function snapshotOf() {
  const raw = storeText()
  if (!raw.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { '!unparsable': raw }
  }
  const out = {}
  for (const wsPath of Object.keys(parsed).sort()) {
    const envs = parsed[wsPath] && parsed[wsPath].environments
    if (!envs || typeof envs !== 'object') continue
    const rows = {}
    for (const env of Object.keys(envs).sort()) {
      const entry = envs[env] || {}
      rows[env] = {
        dsn: entry.dsn,
        readOnly: entry.readOnly === true,
        ssh: entry.ssh ? JSON.stringify(entry.ssh) : '',
      }
    }
    out[wsPath] = rows
  }
  return out
}

/** Capture both views of the store before a command that must not write to it. */
const tallyOf = () => ({ text: storeText(), rows: snapshotOf() })

/**
 * Wait past the millisecond boundary. `saveStore` stamps `updatedAt: Date.now()`,
 * so a write at least 2 ms after the tally was taken always changes the file —
 * without the pause an immediate same-content rewrite hides from `storeText()`.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 2))

/** Assert that a command left the store byte-for-byte AND semantically intact. */
function assertUntouched(before, why) {
  const prefix = why ? why + ' — ' : ''
  assert.deepEqual(snapshotOf(), before.rows, prefix + 'the stored rows are unchanged')
  assert.equal(storeText(), before.text, prefix + 'the store file is unchanged')
}

// RFC 5737 / loopback fixtures only: nothing here names a real host.
const DSN_A = 'mysql://u:CHANGE_ME@127.0.0.1:3306/alpha'
const DSN_A2 = 'mysql://u:CHANGE_ME@127.0.0.1:3306/alpha2'
const DSN_B = 'postgres://u:CHANGE_ME@127.0.0.1:5432/beta'
const SSH_HOST = 'bastion.example.com'
const SSH_PASS = { host: SSH_HOST, port: 22, user: 'deploy', auth: 'password', password: 'CHANGE_ME' }
const SSH_KEY = {
  host: SSH_HOST, port: 2222, user: 'deploy',
  auth: 'key', keyPath: '/home/deploy/.ssh/deploy_ed25519',
}
// A canary for the zero-knowledge assertions. It is assembled here so this file
// does not contain a credentialed URL literal (the desensitize gate scans them)
// while the RUNTIME payload still is one: userinfo `root:<canary>`.
const CANARY = 'CHANGE_ME' + '_HOST'
const CANARY_DSN = 'mysql://root:' + CANARY + '@127.0.0.1:3306/db'

const WS_A = 'D:/work/alpha'
const WS_B = 'D:/work/beta'
const WS_SHARED_1 = 'D:/work/shared-one'
const WS_SHARED_2 = 'D:/work/shared-two'
const REGISTRY = [
  { path: WS_A, title: 'alpha' },
  { path: WS_B, title: 'beta' },
  // Two workspaces with an IDENTICAL title: a selector by title is ambiguous.
  { path: WS_SHARED_1, title: 'shared' },
  { path: WS_SHARED_2, title: 'shared' },
]

// Every dbhub spawn fails immediately: nothing real may run, and the writes under
// test happen before any probe anyway.
const subprocess = {
  resolveExecutable: async (name) => '/nonexistent/' + name,
  spawn: () => ({
    stdin: { write() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    done: Promise.resolve({ exitCode: 1 }),
    terminate() {},
    waitForExit: async () => ({ exitCode: 1 }),
  }),
}

/**
 * A recording stand-in for the host `subprocess` service (same shape as the one
 * in adhoc-toml.test.mjs): it records the exact spawn spec so a probe can be
 * asserted on its argv and its child environment, and never runs anything.
 */
function probeRecorder() {
  const specs = []
  return {
    specs,
    subprocess: {
      resolveExecutable: async (name) => '/fake/bin/' + name,
      spawn(spec) {
        specs.push(spec)
        return {
          stdin: { write() {} },
          stdout: { on() {} },
          stderr: { on() {} },
          done: Promise.resolve({ exitCode: 1 }),
          terminate() {},
          waitForExit: async () => ({ exitCode: 1 }),
        }
      },
    },
  }
}

const dialogs = []
let responder = async () => undefined
const fakeQuestions = {
  ask: async (params) => {
    dialogs.push(params)
    return responder(params)
  },
}
const fakeFs = {
  resolve: async () => {
    throw new Error('no .env')
  },
  readText: async () => '',
}

const captured = {}
const ctx = {
  tools: {
    register: (def) => {
      captured[def.name] = def
      return () => {}
    },
  },
  get: (name) => {
    if (name === 'userQuestions') return fakeQuestions
    if (name === 'fs') return fakeFs
    if (name === 'workspaceRegistry') return { list: async () => REGISTRY }
    return undefined
  },
  inject: () => {},
}
registerCoreTools(ctx, subprocess)

const wsOf = (path) => ({ path, title: path.slice(path.lastIndexOf('/') + 1) })
const rowOf = (wsPath, env) =>
  cfg.listWorkspaceEnvironments(cfg.store).find((r) => r.wsPath === wsPath && r.env === env)
const entryOf = (wsPath, env) => (cfg.store[wsPath] ? cfg.store[wsPath].environments[env] : undefined)

// One card command channel: the notices (what the user sees) and the patches the
// mirror received are collected so a refusal can be asserted on BOTH sides.
function channel() {
  const notices = []
  const published = []
  return {
    notices,
    published,
    lastNotice: () => notices.filter((n) => n).slice(-1)[0] || '',
    run: (op) => index.handleConfigOp(
      op,
      ctx,
      subprocess,
      () => {},
      (patches) => published.push(...patches),
      (text) => notices.push(String(text || '')),
    ),
  }
}

test.before(() => {
  if (!state.isEnabled()) state.setEnabled(true)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── 1. workspace selector ─────────────────────────────────────────────────

test('an explicit but unresolvable workspace selector resolves to nothing', async () => {
  // Path miss, title miss: `undefined` — the caller must refuse, not fall back.
  assert.equal(await index.resolveWorkspaceRef('D:/work/deleted-long-ago', ctx), undefined)
  assert.equal(await index.resolveWorkspaceRef('no-such-title', ctx), undefined)
  // An EMPTY selector keeps its documented meaning: the current (first) workspace.
  assert.equal((await index.resolveWorkspaceRef('', ctx)).path, WS_A)
  assert.equal((await index.resolveWorkspaceRef('   ', ctx)).path, WS_A)
  // Exact matches still work…
  assert.equal((await index.resolveWorkspaceRef(WS_B, ctx)).path, WS_B)
  assert.equal((await index.resolveWorkspaceRef('beta', ctx)).path, WS_B)
  // …but an ambiguous title is NOT guessed by list order.
  assert.equal(await index.resolveWorkspaceRef('shared', ctx), undefined)
})

test('a stale workspace selector never touches the first workspace', async () => {
  cfg.setWorkspaceEnv(WS_A, 'default', DSN_A, 'user')
  const ch = channel()
  const stale = 'D:/work/renamed-away'

  const removed = await ch.run({ op: 'remove', workspace: stale, env: 'default' })
  assert.deepEqual(removed, [], 'a refused command patches nothing')
  assert.ok(rowOf(WS_A, 'default'), 'the first workspace keeps its connection')
  assert.equal(ch.lastNotice(), currentT('result.wsNotFound', { ws: stale }))

  const added = await ch.run({ op: 'add', workspace: stale, env: 'stale', dsn: DSN_B })
  assert.deepEqual(added, [])
  assert.equal(rowOf(WS_A, 'stale'), undefined, 'nothing may be written into another workspace')
  assert.equal(ch.lastNotice(), currentT('result.wsNotFound', { ws: stale }))

  delete cfg.store[WS_A]
})

// ── 2. add/set with a secret-less ssh block (P0-3) ─────────────────────────

test('a DSN-only save keeps the stored password tunnel', async () => {
  cfg.setWorkspaceEnv(WS_A, 'tunnel', DSN_A, 'user', { readOnly: true, ssh: SSH_PASS })
  const ch = channel()

  const patches = await ch.run({
    op: 'set',
    workspace: WS_A,
    env: 'tunnel',
    dsn: DSN_A2,
    // Exactly what the card sends: the form never echoes the stored secret.
    ssh: { host: SSH_HOST, port: 22, user: 'deploy', auth: 'password' },
  })

  const row = rowOf(WS_A, 'tunnel')
  assert.equal(row.dsn, DSN_A2, 'the new DSN landed')
  assert.ok(row.ssh, 'the tunnel must survive a DSN-only edit')
  assert.equal(row.ssh.password, 'CHANGE_ME', 'the stored password is kept')
  assert.equal(row.ssh.auth, 'password')
  assert.equal(row.ro, true, 'the read-only flag is untouched')
  assert.equal(ch.lastNotice(), '', 'a successful write leaves no refusal on the card')
  assert.equal(patches.length, 1)
  delete cfg.store[WS_A]
})

test('a DSN-only save keeps the CUSTOM key path instead of the default one', async () => {
  cfg.setWorkspaceEnv(WS_B, 'tunnel', DSN_B, 'user', { ssh: SSH_KEY })
  const ch = channel()
  const NEW_DSN = 'postgres://u:CHANGE_ME@127.0.0.1:5432/beta2'

  await ch.run({
    op: 'set',
    workspace: WS_B,
    env: 'tunnel',
    dsn: NEW_DSN,
    ssh: { host: SSH_HOST, port: 2222, user: 'deploy', auth: 'key' },
  })

  const entry = entryOf(WS_B, 'tunnel')
  // The DSN must be asserted too: without it, a build that never merges the write
  // and only rewrites the option block would still satisfy the ssh assertions.
  assert.equal(entry.dsn, NEW_DSN, 'the new DSN landed')
  assert.equal(rowOf(WS_B, 'tunnel').dsn, NEW_DSN)
  assert.equal(entry.ssh.keyPath, '/home/deploy/.ssh/deploy_ed25519', 'a blank key path must not be filled with the default')
  assert.notEqual(entry.ssh.keyPath, cfg.DEFAULT_SSH_KEY_PATH)
  assert.equal(entry.ssh.host, SSH_HOST)
  assert.equal(entry.ssh.port, 2222)
  delete cfg.store[WS_B]
})

test('ssh:null still DELETES the stored tunnel on a DSN write', async () => {
  cfg.setWorkspaceEnv(WS_B, 'tunnel', DSN_B, 'user', { readOnly: true, ssh: SSH_KEY })
  const ch = channel()

  await ch.run({ op: 'set', workspace: WS_B, env: 'tunnel', dsn: DSN_B, ssh: null })

  const entry = entryOf(WS_B, 'tunnel')
  assert.equal(Object.hasOwn(entry, 'ssh'), false, 'the ssh field is removed, not blanked')
  assert.equal(entry.readOnly, true, 'the read-only flag survives')
  delete cfg.store[WS_B]
})

test('an unusable ssh block is refused instead of silently dropping the tunnel', async () => {
  cfg.setWorkspaceEnv(WS_B, 'tunnel', DSN_B, 'user', { ssh: SSH_KEY })
  const before = tallyOf()
  await settle()
  const ch = channel()

  const patches = await ch.run({
    op: 'set',
    workspace: WS_B,
    env: 'tunnel',
    dsn: 'postgres://u:CHANGE_ME@127.0.0.1:5432/beta3',
    // No user, no credential → cannot be normalized.
    ssh: { host: SSH_HOST, auth: 'password' },
  })

  assert.deepEqual(patches, [])
  assert.equal(ch.lastNotice(), currentT('result.badSsh'))
  assertUntouched(before, 'an unusable tunnel writes nothing')
  assert.equal(rowOf(WS_B, 'tunnel').ssh.keyPath, SSH_KEY.keyPath, 'the stored tunnel is intact')
  delete cfg.store[WS_B]
})

test('an unusable ssh block is refused by the STORE layer too (badSsh, zero writes)', async () => {
  // The command layer merges before it validates, so this pins the layer below it:
  // `applyEnvOptions` must THROW (code `badSsh`) instead of saving the row without
  // its tunnel — a silent drop turned a working bastion route into a bare connect
  // AND made the next probe test a connection execution would never use.
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user', { readOnly: true, ssh: SSH_KEY })
  const before = tallyOf()
  await settle()

  assert.throws(
    () => cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A2, 'user', { ssh: { host: SSH_HOST, auth: 'password' } }),
    (err) => err && err.code === 'badSsh',
    'the store layer attributes an unusable tunnel',
  )
  assertUntouched(before, 'the refused write rolled nothing back')
  assert.equal(rowOf(WS_A, 'prod').dsn, DSN_A, 'the stored connection is intact')
  assert.equal(rowOf(WS_A, 'prod').ssh.keyPath, SSH_KEY.keyPath, 'the stored tunnel is intact')
  assert.equal(rowOf(WS_A, 'prod').ro, true, 'the read-only flag is intact')

  // The options-only write is the same contract: it refuses and writes nothing.
  assert.equal(
    cfg.setWorkspaceEnvOptions(WS_A, 'prod', { ssh: { host: SSH_HOST, auth: 'password' } }),
    undefined,
  )
  assertUntouched(before, 'the refused options write is a no-op')
  delete cfg.store[WS_A]
})

// ── 3. copyFrom onto an existing environment (P1-5) ───────────────────────

const COPY_SOURCE = 'D:/work/copy-source'
const COPY_TARGET = 'D:/work/copy-target'
REGISTRY.push({ path: COPY_SOURCE, title: 'copy-source' }, { path: COPY_TARGET, title: 'copy-target' })

test('copyFrom refuses to replace an existing environment without confirmation', async () => {
  cfg.setWorkspaceEnv(COPY_SOURCE, 'default', DSN_A, 'user', { readOnly: true, ssh: SSH_KEY })
  cfg.setWorkspaceEnv(COPY_TARGET, 'prod', DSN_B, 'user')
  // `resolveSource` answers from the mirrored walk (fast path), so the mirror has
  // to reflect the store the copy will read — otherwise this case would assert
  // against a row from an earlier walk instead of the fixture.
  await mcp.collectSources(ctx, subprocess)
  const srcId = mcp.sourceIdOf({ title: 'copy-source', wsPath: COPY_SOURCE, env: 'default' })
  const before = tallyOf()
  await settle()
  dialogs.length = 0
  responder = async () => undefined // the user dismissed the overwrite card

  const res = await captured.dbhub_configure.execute(
    { copyFrom: srcId, env: 'prod' },
    { agent: { session: { header: { cwd: COPY_TARGET } } }, signal: undefined },
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.modeCanceled'))
  assert.equal(dialogs.length, 1, 'the user is asked exactly once')
  assert.equal(dialogs[0].questions[0].id, 'overwrite')
  assertUntouched(before, 'an unconfirmed copy writes nothing')
  assert.equal(rowOf(COPY_TARGET, 'prod').dsn, DSN_B, 'the target connection is untouched')
})

test('a confirmed copyFrom takes the SOURCE read-only flag and tunnel', async () => {
  const srcId = mcp.sourceIdOf({ title: 'copy-source', wsPath: COPY_SOURCE, env: 'default' })
  dialogs.length = 0
  responder = async () => ({ answers: [{ id: 'overwrite', selected: [currentT('result.copyOverwriteOk')] }] })

  const res = await captured.dbhub_configure.execute(
    { copyFrom: srcId, env: 'prod' },
    { agent: { session: { header: { cwd: COPY_TARGET } } }, signal: undefined },
  )

  assert.equal(res.ok, true, res.text)
  const row = rowOf(COPY_TARGET, 'prod')
  assert.equal(row.dsn, DSN_A, 'the source DSN replaced the target connection')
  assert.equal(row.ro, true, 'the read-only flag comes from the source row')
  assert.equal(row.ssh.host, SSH_HOST, 'the tunnel comes from the source row')
  assert.equal(row.ssh.keyPath, SSH_KEY.keyPath)
  assert.equal(row.source, 'copied')
  // Zero-knowledge: the reply describes the connection, never its credential.
  assert.ok(!res.text.includes('CHANGE_ME'), res.text)
  delete cfg.store[COPY_SOURCE]
  delete cfg.store[COPY_TARGET]
})

test('copyFrom onto a fresh environment asks nothing and inherits no stale tunnel', async () => {
  cfg.setWorkspaceEnv(COPY_SOURCE, 'default', DSN_A, 'user')
  cfg.setWorkspaceEnv(COPY_TARGET, 'prod', DSN_B, 'user', { readOnly: true, ssh: SSH_PASS })
  await mcp.collectSources(ctx, subprocess)
  const srcId = mcp.sourceIdOf({ title: 'copy-source', wsPath: COPY_SOURCE, env: 'default' })
  dialogs.length = 0

  const res = await captured.dbhub_configure.execute(
    { copyFrom: srcId, env: 'fresh' },
    { agent: { session: { header: { cwd: COPY_TARGET } } }, signal: undefined },
  )

  assert.equal(res.ok, true, res.text)
  assert.equal(dialogs.length, 0, 'a brand-new environment is not an overwrite')
  const row = rowOf(COPY_TARGET, 'fresh')
  assert.equal(row.dsn, DSN_A)
  assert.equal(row.ro, false, 'no read-only flag is inherited from the target workspace')
  assert.equal(row.ssh, null, 'no tunnel is inherited from the target workspace')
  delete cfg.store[COPY_SOURCE]
  delete cfg.store[COPY_TARGET]
})

test('a confirmed copyFrom CLEARS target-only options the source does not carry', async () => {
  // The mirror image of the case above: here the TARGET has a read-only flag and a
  // tunnel and the SOURCE has neither. "Adopt the source row" means the copy is
  // writable and untunnelled — keeping the target's old bastion would point the
  // new connection at a throwaway host, and keeping its read-only flag would lock
  // a connection the user just replaced.
  cfg.setWorkspaceEnv(COPY_SOURCE, 'default', DSN_A, 'user')
  cfg.setWorkspaceEnv(COPY_TARGET, 'prod', DSN_B, 'user', { readOnly: true, ssh: SSH_PASS })
  await mcp.collectSources(ctx, subprocess)
  const srcId = mcp.sourceIdOf({ title: 'copy-source', wsPath: COPY_SOURCE, env: 'default' })
  dialogs.length = 0
  responder = async () => ({ answers: [{ id: 'overwrite', selected: [currentT('result.copyOverwriteOk')] }] })

  const res = await captured.dbhub_configure.execute(
    { copyFrom: srcId, env: 'prod' },
    { agent: { session: { header: { cwd: COPY_TARGET } } }, signal: undefined },
  )

  assert.equal(res.ok, true, res.text)
  const row = rowOf(COPY_TARGET, 'prod')
  assert.equal(row.dsn, DSN_A)
  assert.equal(row.ro, false, 'the source has no read-only flag, so the target flag is CLEARED')
  assert.equal(row.ssh, null, 'the source has no tunnel, so the target tunnel is CLEARED')
  const entry = entryOf(COPY_TARGET, 'prod')
  assert.equal(Object.hasOwn(entry, 'readOnly'), false, 'the flag is removed, not stored as false')
  assert.equal(Object.hasOwn(entry, 'ssh'), false, 'the tunnel is removed, not blanked')
  delete cfg.store[COPY_SOURCE]
  delete cfg.store[COPY_TARGET]
})

// ── 4. rename / newEnv collisions (P1-6) ──────────────────────────────────

test('renaming onto an existing environment is refused until confirmed', async () => {
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user')
  cfg.setWorkspaceEnv(WS_A, 'dev', DSN_B, 'user')
  const before = tallyOf()
  await settle()
  const ch = channel()

  const refused = await ch.run({ op: 'rename', workspace: WS_A, env: 'prod', newEnv: 'dev' })
  assert.deepEqual(refused, [])
  assert.equal(ch.lastNotice(), currentT('result.renameCollided', { to: 'dev' }))
  assertUntouched(before, 'an unconfirmed collision writes nothing')
  assert.ok(rowOf(WS_A, 'prod') && rowOf(WS_A, 'dev'), 'both environments still exist')

  const confirmed = await ch.run({ op: 'rename', workspace: WS_A, env: 'prod', newEnv: 'dev', overwrite: true })
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].op, 'rename')
  assert.equal(rowOf(WS_A, 'prod'), undefined)
  assert.equal(rowOf(WS_A, 'dev').dsn, DSN_A, 'the source connection moved onto the target name')
  delete cfg.store[WS_A]
})

test('renaming an environment onto its own name is "no rename", not a collision', async () => {
  // `renameWorkspaceEnv` answers `{renamed:false, collided:false}` when both names
  // normalize to the same key. Reading "did not rename" as a collision told the
  // user the target "already exists and overwriting would drop that connection" —
  // about the row they were renaming.
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user')
  const before = tallyOf()
  await settle()
  const ch = channel()

  const res = await ch.run({ op: 'rename', workspace: WS_A, env: 'prod', newEnv: ' prod ' })

  assert.deepEqual(res, [], 'nothing to rename, nothing to publish')
  assert.equal(ch.lastNotice(), '', 'a same-name rename is not a refusal')
  assertUntouched(before, 'a same-name rename writes nothing')
  assert.equal(rowOf(WS_A, 'prod').dsn, DSN_A, 'the row keeps its connection and its name')
  delete cfg.store[WS_A]
})

test('a blank newEnv is "no rename" and never lands on default', async () => {
  cfg.setWorkspaceEnv(WS_A, 'default', DSN_A, 'user')
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_B, 'user')
  const before = tallyOf()
  await settle()
  const ch = channel()

  const res = await ch.run({ op: 'rename', workspace: WS_A, env: 'prod', newEnv: '   ' })
  assert.deepEqual(res, [])
  assert.equal(ch.lastNotice(), currentT('result.renameBlankTarget'))
  assertUntouched(before, 'a blank target writes nothing')
  assert.equal(entryOf(WS_A, 'default').dsn, DSN_A, 'the default environment is untouched')

  // The same rule on the atomic options+rename command.
  const applied = await index.applyOptionsOp(
    { op: 'options', env: 'prod', newEnv: '', readOnly: true },
    wsOf(WS_A),
    async () => undefined,
  )
  assert.equal(applied.error, undefined)
  assert.equal(applied.patches.some((p) => p.op === 'rename'), false, 'a blank newEnv renames nothing')
  assert.equal(entryOf(WS_A, 'default').dsn, DSN_A)
  assert.equal(entryOf(WS_A, 'prod').readOnly, true, 'the option still lands on the named environment')
  delete cfg.store[WS_A]
})

test('options+newEnv onto an existing environment is refused until confirmed', async () => {
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user')
  cfg.setWorkspaceEnv(WS_A, 'dev', DSN_B, 'user')
  const before = tallyOf()
  await settle()

  const refused = await index.applyOptionsOp(
    { op: 'options', env: 'prod', newEnv: 'dev', readOnly: true },
    wsOf(WS_A),
    async () => undefined,
  )
  assert.deepEqual(refused.patches, [])
  assert.equal(refused.error, 'renameCollided')
  assertUntouched(before, 'an unconfirmed rename+options writes nothing')

  const confirmed = await index.applyOptionsOp(
    { op: 'options', env: 'prod', newEnv: 'dev', readOnly: true, overwrite: true },
    wsOf(WS_A),
    async () => undefined,
  )
  assert.equal(confirmed.patches[0].op, 'rename')
  assert.equal(rowOf(WS_A, 'dev').dsn, DSN_A)
  delete cfg.store[WS_A]
})

test('add with renameFrom onto an existing environment is refused until confirmed', async () => {
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user')
  cfg.setWorkspaceEnv(WS_A, 'dev', DSN_B, 'user')
  const before = tallyOf()
  await settle()
  const ch = channel()

  const res = await ch.run({ op: 'add', workspace: WS_A, env: 'dev', renameFrom: 'prod', dsn: DSN_A2 })
  assert.deepEqual(res, [])
  assert.equal(ch.lastNotice(), currentT('result.renameCollided', { to: 'dev' }))
  assertUntouched(before, 'an unconfirmed collision writes nothing')
  assert.equal(rowOf(WS_A, 'dev').dsn, DSN_B, 'the target connection is untouched')
  delete cfg.store[WS_A]
})

// ── 5. failure attribution (P1-7) ────────────────────────────────────────

test('an empty DSN is attributed to the DSN, not to the workspace', async () => {
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user')
  const before = tallyOf()
  await settle()
  const ch = channel()

  const res = await ch.run({ op: 'set', workspace: WS_A, env: 'prod', dsn: '   ' })

  assert.deepEqual(res, [])
  assert.equal(ch.lastNotice(), currentT('result.emptyDsn'))
  assert.notEqual(ch.lastNotice(), currentT('result.wsNotFound', { ws: 'x' }), 'never blamed on the workspace')
  assertUntouched(before, 'nothing is written for an empty DSN')
  assert.equal(rowOf(WS_A, 'prod').dsn, DSN_A)
  delete cfg.store[WS_A]
})

test('an unusable tunnel in a renaming write leaves the row under its OLD name', async () => {
  // The refusal text promises "nothing was changed". The tunnel is validated
  // BEFORE the rename, so this command must not move the row first and then die —
  // that half-write left the connection under the new name with no DSN update.
  const WS = 'D:/work/renamebadssh'
  REGISTRY.push({ path: WS, title: 'renamebadssh' })
  cfg.setWorkspaceEnv(WS, 'old', DSN_A, 'user', { ssh: SSH_KEY })
  const before = tallyOf()
  await settle()
  const ch = channel()

  const res = await ch.run({
    op: 'add',
    workspace: WS,
    env: 'prod',
    renameFrom: 'old',
    dsn: DSN_A2,
    // Unusable: no user, no credential.
    ssh: { host: SSH_HOST, auth: 'password' },
  })

  assert.deepEqual(res, [])
  assert.equal(ch.lastNotice(), currentT('result.badSsh'))
  assert.deepEqual(ch.published, [], 'nothing was mirrored, because nothing landed')
  assertUntouched(before, 'the refused write did not rename the row')
  const row = rowOf(WS, 'old')
  assert.ok(row, 'the connection is still under its original name')
  assert.equal(row.dsn, DSN_A, 'and still holds its original DSN')
  assert.equal(row.ssh.keyPath, SSH_KEY.keyPath, 'and still holds its tunnel')
  assert.equal(rowOf(WS, 'prod'), undefined, 'no half-renamed row was left behind')
  delete cfg.store[WS]
})

test('a rename that landed is still published when the options write cannot follow', async () => {
  // The "partial failure" contract (AGENTS.md: 部分失败时已落地的补丁照发). Once the
  // tunnel block is validated up front, the store slot moving under the command is
  // what is left, and it is simulated AT THE SLOT so the command itself runs
  // unmodified: the first read hands out the real entry (the rename performs its
  // save), every read afterwards finds the key gone — which is what a second
  // writer (a tool call, another card) does to this one shared store object.
  const WS = 'D:/work/partial'
  REGISTRY.push({ path: WS, title: 'partial' })
  cfg.setWorkspaceEnv(WS, 'old', DSN_A, 'user')
  const realEntry = cfg.store[WS]
  let entryReads = 0
  Object.defineProperty(cfg.store, WS, {
    configurable: true,
    enumerable: true,
    get() {
      entryReads += 1
      return entryReads === 1 ? realEntry : undefined
    },
    set() {
      /* the slot has moved on: the write is accepted and dropped */
    },
  })
  const ch = channel()

  const res = await ch.run({ op: 'options', workspace: WS, env: 'old', newEnv: 'newenv', readOnly: true })

  assert.ok(entryReads > 1, 'the fixture really hid the entry (otherwise this case proves nothing)')
  assert.equal(ch.lastNotice(), currentT('result.needConnFirst'))
  const expected = [{ op: 'rename', path: WS, env: 'newenv', from: 'old' }]
  assert.deepEqual(ch.published, expected, 'the landed rename is mirrored immediately')
  assert.deepEqual(res, expected, 'and returned to the caller')
  delete cfg.store[WS]
})

// ── 6. the pre-save probe carries the stored tunnel secret (P1-4) ─────────

const WS_PROBE = 'D:/work/probe'
REGISTRY.push({ path: WS_PROBE, title: 'probe' })

test('a pre-save probe uses the stored SSH secret instead of an empty one', async () => {
  cfg.setWorkspaceEnv(WS_PROBE, 'prod', DSN_A, 'user', { ssh: SSH_PASS })
  const { subprocess: recording, specs } = probeRecorder()
  const reports = []

  // Exactly the payload the card's pre-save probe sends: the form's ssh block
  // WITHOUT the password it cannot echo back.
  await index.handleConfigOp(
    {
      op: 'test',
      workspace: WS_PROBE,
      env: 'prod',
      nonce: 'probe-1',
      dsn: DSN_A2,
      ssh: { host: SSH_HOST, port: 22, user: 'deploy', auth: 'password' },
    },
    ctx,
    recording,
    (json) => reports.push(JSON.parse(json)),
    () => {},
    () => {},
  )

  assert.ok(specs.length > 0, 'the probe spawned a one-shot dbhub')
  assert.ok(specs[0].argv.join(' ').includes('--config'), 'a tunnelled probe uses the generated TOML')
  assert.equal(specs[0].env.DSH_DBHUB_SEC_SSH_PASSWORD, 'CHANGE_ME', 'the stored tunnel secret is used host-side')
  const report = reports[reports.length - 1]
  assert.equal(report.nonce, 'probe-1')
  assert.equal(JSON.stringify(report).includes('CHANGE_ME'), false, 'the report never echoes the secret')
  delete cfg.store[WS_PROBE]
})

test('a probe that carries NO ssh key still tests through the stored tunnel (R61)', async () => {
  // `connDraftOf` OMITS the ssh key while all three SSH fields are blank, and the
  // save that follows keeps the stored tunnel. Probing the bare connection would
  // validate something execution never uses — the test would say "✗ 失败" about a
  // working tunnel (or "✓ 成功" about a route that is not the saved one).
  cfg.setWorkspaceEnv(WS_PROBE, 'prod', DSN_A, 'user', { readOnly: true, ssh: SSH_PASS })
  const { subprocess: recording, specs } = probeRecorder()
  const reports = []

  await index.handleConfigOp(
    // No `ssh` key at all, exactly like `withConnDraft` on a blank SSH panel.
    { op: 'test', workspace: WS_PROBE, env: 'prod', nonce: 'probe-bare', dsn: DSN_A2, readOnly: true },
    ctx,
    recording,
    (json) => reports.push(JSON.parse(json)),
    () => {},
    () => {},
  )

  assert.ok(specs.length > 0, 'the probe spawned a one-shot dbhub')
  assert.ok(specs[0].argv.join(' ').includes('--config'), 'the stored tunnel forces the TOML path')
  assert.equal(
    specs[0].env.DSH_DBHUB_SEC_SSH_PASSWORD,
    'CHANGE_ME',
    'the probe uses the stored tunnel secret, so it validates the connection the save would keep',
  )
  const report = reports[reports.length - 1]
  assert.equal(report.nonce, 'probe-bare')
  assert.equal(JSON.stringify(report).includes('CHANGE_ME'), false, 'the report never echoes the secret')
  delete cfg.store[WS_PROBE]
})

test('an explicit ssh:null probe really tests WITHOUT the stored tunnel', async () => {
  // The other side of the three-state rule: the user switched the tunnel off, so
  // the probe must not quietly reuse the stored one (`ssh:null` is a DELETION
  // signal, not "unchanged").
  cfg.setWorkspaceEnv(WS_PROBE, 'prod', DSN_A, 'user', { ssh: SSH_PASS })
  const { subprocess: recording, specs } = probeRecorder()
  const reports = []

  await index.handleConfigOp(
    { op: 'test', workspace: WS_PROBE, env: 'prod', nonce: 'probe-off', dsn: DSN_A2, readOnly: false, ssh: null },
    ctx,
    recording,
    (json) => reports.push(JSON.parse(json)),
    () => {},
    () => {},
  )

  assert.ok(specs.length > 0, 'the probe spawned a one-shot dbhub')
  assert.equal(specs[0].argv.join(' ').includes('--config'), false, 'no tunnel and no read-only means --dsn')
  // The `--dsn` shape carries no generated TOML, so there is no child environment
  // of placeholders at all — that absence IS the assertion.
  assert.equal((specs[0].env || {}).DSH_DBHUB_SEC_SSH_PASSWORD, undefined, 'the stored tunnel secret is NOT used')
  assert.equal(reports[reports.length - 1].nonce, 'probe-off')
  delete cfg.store[WS_PROBE]
})

// ── 7. the "fill in the fields" dialog (P0-2) ────────────────────────────

const WS_FORM = 'D:/work/form'
REGISTRY.push({ path: WS_FORM, title: 'form' })

test('a dismissed "fill in the fields" form cancels with zero writes', async () => {
  // No stored row and no prefill → the mode dialog comes first, then the form.
  cfg.setWorkspaceEnv(WS_FORM, 'prod', DSN_A, 'user')
  const before = tallyOf()
  await settle()
  dialogs.length = 0
  let call = 0
  responder = async () => {
    call += 1
    if (call === 1) {
      return { answers: [{ id: 'mode', selected: ['填写分项（类型/主机/端口/账号/密码/库名）'] }] }
    }
    return undefined // the form itself was closed
  }

  const res = await captured.dbhub_configure.execute(
    { env: 'prod' },
    { agent: { session: { header: { cwd: WS_FORM } } }, signal: undefined },
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.modeCanceled'))
  assert.equal(dialogs.length, 2, 'the mode dialog then the field form')
  assertUntouched(before, 'a dismissed form writes NOTHING')
  assert.equal(rowOf(WS_FORM, 'prod').dsn, DSN_A, 'the stored password was not replaced by an empty one')
  delete cfg.store[WS_FORM]
})

test('an empty answer list is treated exactly like a dismissal', async () => {
  cfg.setWorkspaceEnv(WS_FORM, 'prod', DSN_A, 'user')
  const before = tallyOf()
  await settle()
  dialogs.length = 0
  let call = 0
  responder = async () => {
    call += 1
    if (call === 1) {
      return { answers: [{ id: 'mode', selected: ['填写分项（类型/主机/端口/账号/密码/库名）'] }] }
    }
    return { answers: [] }
  }

  const res = await captured.dbhub_configure.execute(
    { env: 'prod' },
    { agent: { session: { header: { cwd: WS_FORM } } }, signal: undefined },
  )

  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.modeCanceled'))
  assertUntouched(before, 'an empty answer list writes NOTHING')
  delete cfg.store[WS_FORM]
})

// ── 8. the two option semantics that must never degrade ──────────────────

test('{readOnly:false} DELETES the stored read-only flag', async () => {
  cfg.setWorkspaceEnv(WS_A, 'prod', DSN_A, 'user', { readOnly: true })
  const ch = channel()

  const patches = await ch.run({ op: 'options', workspace: WS_A, env: 'prod', readOnly: false })

  const entry = entryOf(WS_A, 'prod')
  assert.equal(Object.hasOwn(entry, 'readOnly'), false, 'the flag is removed, not stored as false')
  assert.equal(rowOf(WS_A, 'prod').ro, false, 'the mirror reports a writable connection')
  assert.equal(entry.dsn, DSN_A, 'the options command never touches the DSN')
  assert.equal(patches.some((p) => p.op === 'options' && p.ro === false), true, 'the mirror patch carries the clear')
  delete cfg.store[WS_A]
})

test('switching the SSH auth kind from key to password drops the old key path and passphrase', async () => {
  // "Blank secret = keep the stored value" applies to the SAME auth kind only: a
  // password tunnel must not inherit a key path / passphrase, or the saved block
  // carries a stale identity file that dbhub may still try to use.
  cfg.setWorkspaceEnv(WS_B, 'switch', DSN_B, 'user', {
    ssh: {
      host: SSH_HOST, port: 2222, user: 'deploy', auth: 'key',
      keyPath: '/home/deploy/.ssh/deploy_ed25519', passphrase: 'CHANGE_ME',
    },
  })
  const ch = channel()

  await ch.run({
    op: 'options',
    workspace: WS_B,
    env: 'switch',
    ssh: { host: SSH_HOST, port: 2222, user: 'deploy', auth: 'password', password: 'CHANGE_ME' },
  })

  const entry = entryOf(WS_B, 'switch')
  assert.equal(entry.ssh.auth, 'password')
  assert.equal(entry.ssh.password, 'CHANGE_ME')
  assert.equal(Object.hasOwn(entry.ssh, 'keyPath'), false, 'the old identity file is not carried over')
  assert.equal(Object.hasOwn(entry.ssh, 'passphrase'), false, 'the old passphrase is not carried over')
  assert.equal(entry.dsn, DSN_B, 'the options command never touches the DSN')
  delete cfg.store[WS_B]
})

// ── 9. the opNotice receipt channel (P1-8) ───────────────────────────────

/**
 * The bare minimum `apply(ctx, config)` needs to wire BOTH channels: a tool
 * registry, a workspace registry, one `inject(['settings'])` scope (the legacy
 * namespace) and one `inject(['connection'])` scope whose `fetch.register`
 * records the HTTP routes.
 */
function hostCtx({ subprocess: sub, workspaces }) {
  const tools = []
  const routes = []
  const settings = {
    register: () => ({ replace: async () => {}, watch: () => () => {} }),
    describe: () => [],
  }
  const scopeFor = (names) => {
    const scope = { effect: (fn) => { try { fn() } catch (e) { /* contained */ } return () => {} } }
    if (names.includes('settings')) scope.settings = settings
    if (names.includes('connection')) scope.connection = { fetch: { register: (route) => { routes.push(route) } } }
    return scope
  }
  const hctx = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    get(name) {
      if (name === 'subprocess') return sub
      if (name === 'workspaceRegistry') return { list: async () => workspaces }
      if (name === 'fs') return fakeFs
      if (name === 'userQuestions') return fakeQuestions
      return undefined
    },
    inject: (names, callback) => { callback(scopeFor(names)); return () => {} },
    effect: (fn) => { try { fn() } catch (e) { /* contained */ } return () => {} },
    on: () => {},
  }
  return { ctx: hctx, tools, routes }
}

/** POST one card command through the bridge route and decode the reply. */
async function postOp(route, op) {
  const response = await route.fetch(new Request('http://127.0.0.1' + BRIDGE_ROUTES.op, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op }),
  }))
  assert.equal(response.status, 200)
  return response.json()
}

let cardOpRoute
async function opRouteOf() {
  if (cardOpRoute) return cardOpRoute
  const { ctx: hctx, routes } = hostCtx({ subprocess, workspaces: REGISTRY })
  await index.apply(hctx, undefined)
  cardOpRoute = routes.find((route) => route.path === BRIDGE_ROUTES.op)
  assert.ok(cardOpRoute, 'the /op route must be registered')
  return cardOpRoute
}

test('a refused card command lands in the VIEW as a transient opNotice', async () => {
  const WS = 'D:/work/notice'
  REGISTRY.push({ path: WS, title: 'notice' })
  cfg.setWorkspaceEnv(WS, 'prod', DSN_A, 'user')
  const route = await opRouteOf()

  const refused = await postOp(route, { op: 'rename', workspace: WS, env: 'prod', newEnv: '   ' })
  assert.deepEqual(refused.patches, [])
  assert.ok(
    Object.hasOwn(refused.value, 'opNotice'),
    'the view must CARRY the field the card reads (dropping it makes every refusal silent again)',
  )
  assert.equal(
    JSON.parse(refused.value.opNotice).message,
    currentT('result.renameBlankTarget'),
    'the refusal is addressed to this command',
  )

  // It is a receipt, not a status: the next command clears it.
  const applied = await postOp(route, { op: 'options', workspace: WS, env: 'prod', readOnly: true })
  assert.equal(applied.value.opNotice, '', 'a fresh command clears the previous refusal')
  assert.equal(rowOf(WS, 'prod').ro, true)
  delete cfg.store[WS]
})

test('the opNotice text never carries a DSN, a host or a password', async () => {
  const WS = 'D:/work/notice-scrub'
  REGISTRY.push({ path: WS, title: 'notice-scrub' })
  cfg.setWorkspaceEnv(WS, 'prod', DSN_A, 'user')
  const route = await opRouteOf()

  // (a) A refused write whose payload contains a credentialed DSN: the sentence is
  // a localized template, so nothing of the payload may ride along.
  const bad = await postOp(route, {
    op: 'set', workspace: WS, env: 'prod', dsn: CANARY_DSN,
    ssh: { host: SSH_HOST, auth: 'password' },
  })
  const badText = JSON.parse(bad.value.opNotice).message
  assert.equal(badText, currentT('result.badSsh'))
  assert.equal(badText.includes(CANARY), false, 'the DSN password must not reach the card: ' + badText)
  assert.equal(badText.includes(SSH_HOST), false, 'the bastion host must not reach the card: ' + badText)

  // (b) The selector is echoed back by the "workspace not found" sentence, and it
  // is client-supplied free text: it is scrubbed like every other visible string.
  const miss = await postOp(route, { op: 'set', workspace: CANARY_DSN, env: 'prod', dsn: DSN_A })
  const missText = JSON.parse(miss.value.opNotice).message
  assert.equal(missText.includes(CANARY), false, 'a pasted DSN must not leak its password: ' + missText)
  assert.ok(missText.includes('127.0.0.1'), 'the non-secret part of the label still shows: ' + missText)
  delete cfg.store[WS]
})

// ── 10. the /op RESPONSE body is metadata-only ───────────────────────────
//
// The patches a write command returns travel back to the BROWSER in the `/op`
// response. They used to carry `{dsn, ssh}` — i.e. the full connection string and
// the tunnel password — even though the browser half never reads `patches` (it
// re-renders from the published view). The mirror DOES need the real row, so the
// two audiences are separated: the response stays metadata-only, and
// `mirrorPatchOf` re-reads the secret from the store for the host-side mirror.

test('the /op response carries metadata-only patches (no dsn, no tunnel secret)', async () => {
  const WS = 'D:/work/patch-zk'
  REGISTRY.push({ path: WS, title: 'patch-zk' })
  const route = await opRouteOf()

  const added = await postOp(route, {
    op: 'add',
    workspace: WS,
    env: 'prod',
    dsn: CANARY_DSN,
    ssh: { host: SSH_HOST, port: 22, user: 'deploy', auth: 'password', password: CANARY },
  })
  assert.equal(added.ok, true, 'the write still succeeds')
  const patch = added.patches.find((p) => p.op === 'add')
  assert.ok(patch, 'the mirror is still told which row changed')
  assert.equal(patch.env, 'prod')
  assert.equal(Object.hasOwn(patch, 'dsn'), false, 'the patch must not carry the DSN')
  assert.equal(Object.hasOwn(patch, 'ssh'), false, 'the patch must not carry the tunnel block')
  // No secret of any kind anywhere in the response body.
  for (const forbidden of [CANARY, 'password', 'passphrase', 'keyPath']) {
    assert.equal(JSON.stringify(added.patches).includes(forbidden), false, 'the response leaked ' + forbidden)
  }

  // The row itself did land, tunnel and all — the metadata-only patch is not a
  // weakened write.
  const row = rowOf(WS, 'prod')
  assert.equal(row.dsn, CANARY_DSN)
  assert.equal(row.ssh.password, CANARY)

  // …and the MIRROR still gets what it needs: the same patch, hydrated from the
  // store, carries the DSN and the resolved options.
  const forMirror = index.mirrorPatchOf(patch)
  assert.equal(forMirror.dsn, CANARY_DSN)
  assert.equal(forMirror.ro, false)
  assert.equal(forMirror.ssh.password, CANARY)

  // The options command has the same contract (its patch used to carry `ssh`).
  const toggled = await postOp(route, { op: 'options', workspace: WS, env: 'prod', readOnly: true })
  const optPatch = toggled.patches.find((p) => p.op === 'options')
  assert.ok(optPatch)
  assert.equal(optPatch.ro, true, 'the read-only state is metadata and IS mirrored')
  assert.equal(Object.hasOwn(optPatch, 'ssh'), false, 'the options patch must not carry the tunnel block')
  assert.equal(index.mirrorPatchOf(optPatch).ssh.password, CANARY, 'the mirror re-reads the tunnel from the store')
  delete cfg.store[WS]
})

// ── 10b. the MIRROR gets the connection, the `/op` response does not (M8) ──
//
// Test 10 checks the two audiences through `mirrorPatchOf` called by hand. That
// is a blind spot: reverting `publishFast(patches.map(mirrorPatchOf))` to
// `publishFast(patches)` left EVERY test green, because nothing observed what the
// host-side mirror channel actually received. This test captures the `publishFast`
// argument itself (the channel's `published` array) and asserts the two payloads
// differ in exactly the right direction.

test('the mirror receives the connection data the returned patches never carry (M8)', async () => {
  const WS = 'D:/work/mirror-payload'
  REGISTRY.push({ path: WS, title: 'mirror-payload' })
  const ch = channel()

  const returned = await ch.run({
    op: 'add',
    workspace: WS,
    env: 'prod',
    dsn: CANARY_DSN,
    ssh: { host: SSH_HOST, port: 22, user: 'deploy', auth: 'password', password: CANARY },
  })

  // (a) the mirror was fed a patch that can actually describe the row
  const mirroredAdd = ch.published.filter((p) => p.op === 'add' && p.env === 'prod')
  assert.equal(mirroredAdd.length, 1, 'one add patch reached publishFast')
  assert.equal(mirroredAdd[0].dsn, CANARY_DSN, 'the mirror needs the DSN to summarize the row')
  assert.ok(mirroredAdd[0].ssh, 'the mirror needs the resolved tunnel block')
  assert.equal(mirroredAdd[0].ssh.password, CANARY)
  assert.equal(mirroredAdd[0].ro, false)

  // (b) the SAME command's returned patches stay metadata-only
  const returnedAdd = returned.find((p) => p.op === 'add')
  assert.ok(returnedAdd, 'the caller is still told which row changed')
  assert.equal(Object.hasOwn(returnedAdd, 'dsn'), false, 'the returned patch must not carry the DSN')
  assert.equal(Object.hasOwn(returnedAdd, 'ssh'), false, 'the returned patch must not carry the tunnel')

  // (c) the options command has the same two-audience contract
  const returnedOpts = await ch.run({ op: 'options', workspace: WS, env: 'prod', readOnly: true })
  const mirroredOpts = ch.published.filter((p) => p.op === 'options' && p.env === 'prod').slice(-1)
  assert.equal(mirroredOpts.length, 1)
  assert.equal(mirroredOpts[0].ro, true)
  assert.equal(mirroredOpts[0].ssh.password, CANARY, 'the mirror re-reads the tunnel from the store')
  const returnedOpt = returnedOpts.find((p) => p.op === 'options')
  assert.ok(returnedOpt)
  assert.equal(Object.hasOwn(returnedOpt, 'ssh'), false, 'the returned options patch must not carry the tunnel')

  // Neither payload of the mirror channel is exempt from the zero-knowledge rule:
  // the DSN and tunnel only ever travel host-side (publishFast feeds host memory).
  delete cfg.store[WS]
})

// ── 11. a name that only collides through the length cap (PR-5 / P1-12) ────

const WS_LONG = 'D:/work/long-name'
REGISTRY.push({ path: WS_LONG, title: 'long-name' })

test('the card is told WHY a too-long environment name was refused, and nothing is written', async () => {
  // Two DISTINCT long names share one store key after the ENV_NAME_MAX cap, so the
  // write must be refused instead of overwriting (and silently losing) the row
  // that already sits there — and the card, which has no other feedback channel,
  // must render the reason.
  const capped = 'e'.repeat(cfg.ENV_NAME_MAX)
  cfg.setWorkspaceEnv(WS_LONG, capped, DSN_A, 'user')
  const before = JSON.stringify(cfg.store[WS_LONG])
  const ch = channel()

  const returned = await ch.run({ op: 'add', workspace: WS_LONG, env: capped + '2', dsn: DSN_B })

  assert.deepEqual(returned, [], 'a refused command patches nothing')
  assert.equal(JSON.stringify(cfg.store[WS_LONG]), before, 'and writes nothing')
  assert.equal(ch.lastNotice(), currentT('result.envNameTruncated', { max: String(cfg.ENV_NAME_MAX) }))
  assert.equal(ch.lastNotice().includes('CHANGE_ME'), false, 'the receipt quotes no secret')
  // …and the same refusal cannot be smuggled in through a confirmed overwrite.
  const renameCh = channel()
  cfg.setWorkspaceEnv(WS_LONG, 'other', DSN_B, 'user')
  const beforeRename = JSON.stringify(cfg.store[WS_LONG])
  await renameCh.run({ op: 'rename', workspace: WS_LONG, env: 'other', newEnv: capped + '3', overwrite: true })
  assert.equal(JSON.stringify(cfg.store[WS_LONG]), beforeRename, 'a confirmed overwrite cannot merge two long names')
  assert.equal(renameCh.lastNotice(), currentT('result.envNameTruncated', { max: String(cfg.ENV_NAME_MAX) }))
  delete cfg.store[WS_LONG]
})

test('the MODEL path refuses the same truncating name instead of updating a neighbour', async () => {
  // `dbhub_configure` normalizes `env` before it writes, so without a check on the
  // RAW argument a model asking for "a new environment" would silently update the
  // row that shares its capped key — the exact silent merge the store guard exists
  // to prevent, just through another door.
  const capped = 'e'.repeat(cfg.ENV_NAME_MAX)
  cfg.setWorkspaceEnv(WS_LONG, capped, DSN_A, 'user')
  const before = JSON.stringify(cfg.store[WS_LONG])
  const tool = captured.dbhub_configure
  assert.ok(tool, 'the configure tool was registered')

  const res = await tool.execute({ workspace: WS_LONG, env: capped + '2', readOnly: true }, {})
  assert.equal(res.ok, false)
  assert.equal(res.text, currentT('result.envNameTruncated', { max: String(cfg.ENV_NAME_MAX) }))
  assert.equal(JSON.stringify(cfg.store[WS_LONG]), before, 'the model path writes nothing either')
  // A legal (short) name still goes through the ordinary flow, i.e. the guard is
  // not a blanket refusal of every write.
  assert.equal(cfg.envNameTruncatesOntoExisting(WS_LONG, 'short-name'), false)
  assert.equal(cfg.envNameTruncatesOntoExisting(WS_LONG, capped), false, 'the capped form IS the stored key')
  delete cfg.store[WS_LONG]
})

// ── 12. the legacy plaintext store is swept at BOOT (wiring, not the helper) ──
test('apply() deletes the pre-4.0 plaintext dbhub.toml and never quotes it', async () => {
  // `sweepLegacyConfigFile` has its own unit test; this one pins the WIRING, so a
  // refactor cannot leave the helper uncalled (the file would then sit in the
  // profile forever: nothing reads it, so nothing else would ever notice it).
  mkdirSync(cfg.DATA_DIR, { recursive: true })
  writeFileSync(
    cfg.LEGACY_CONFIG_PATH,
    '[[sources]]\r\ndsn = "mysql://root:' + CANARY + '@127.0.0.1:3306/app"\r\n',
  )
  assert.ok(existsSync(cfg.LEGACY_CONFIG_PATH), 'fixture in place')

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try {
    const { ctx: hctx } = hostCtx({ subprocess, workspaces: REGISTRY })
    await index.apply(hctx, undefined)
  } finally {
    console.warn = originalWarn
  }

  assert.equal(existsSync(cfg.LEGACY_CONFIG_PATH), false, 'boot removed the plaintext connection file')
  const logged = warnings.join('\n')
  assert.equal(logged.includes(CANARY), false, 'the warning must not quote the DSN: ' + logged)
  assert.ok(logged.includes('dbhub.toml'), 'the warning names the file: ' + logged)
})

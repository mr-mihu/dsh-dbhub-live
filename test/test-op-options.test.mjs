// The option half of a card `{op:'test'}` command (lib/index.mjs).
//
// A probe is the one place where "the card said nothing" and "the card said
// null" mean OPPOSITE things, so the two helpers behind it are pure and exported:
// `testOpHasOptions` decides whether the card's option block replaces the stored
// one, and `testProbeOptionsOf` resolves the three-state tunnel contract.
//
// Test isolation: index.mjs imports config.mjs, which derives its storage dir
// from DSH_HOME at import time — point it at a temp dir BEFORE importing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-testopts-'))
process.env.DSH_HOME = home

const here = dirname(fileURLToPath(import.meta.url))
const index = await import('../lib/index.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

const SSH_PASS = { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: 'CHANGE_ME' }

/** A saved row with a tunnel and the read-only flag on. */
const savedRow = () => ({ wsPath: 'D:/ws/a', env: 'prod', dsn: 'mysql://u:CHANGE_ME@127.0.0.1:3306/p', ro: true, ssh: { ...SSH_PASS } })

// ── "does the card carry options at all?" ───────────────────────────────────

test('a bare test command carries no options, so the stored row decides', () => {
  assert.equal(index.testOpHasOptions({ op: 'test', workspace: 'D:/ws/a', env: 'prod' }), false)
  assert.equal(index.testOpHasOptions(undefined), false)
  assert.equal(index.testOpHasOptions('nope'), false)
  const opts = index.testProbeOptionsOf({ op: 'test' }, savedRow())
  assert.deepEqual(opts, { ro: false, ssh: savedRow().ssh }, 'no card data means "the row as stored"')
})

test('readOnly and ssh:null are both INFORMATION, not absences', () => {
  // `readOnly: false` is a real choice (the card always sends it), and
  // `ssh: null` is "the user just cleared the tunnel".
  assert.equal(index.testOpHasOptions({ op: 'test', readOnly: false }), true)
  assert.equal(index.testOpHasOptions({ op: 'test', ssh: null }), true, 'a cleared tunnel is not "unchanged"')
})

// ── the three-state tunnel contract ─────────────────────────────────────────

test('ssh:null probes WITHOUT the stored tunnel (clear, then test)', () => {
  // The old gate was `op.ssh && typeof op.ssh === 'object'`, so the cleared-tunnel
  // command fell through to `savedRow.ssh` and the probe validated the tunnel the
  // user had just removed: a green line for a connection execution no longer uses.
  const opts = index.testProbeOptionsOf({ op: 'test', ssh: null }, savedRow())
  assert.equal(opts.ssh, null)
  assert.equal(opts.ro, false)
})

test('an ssh block from the form wins, with the stored secret merged in', () => {
  // The card cannot echo `ssh.password` back, so a form block arrives secret-less;
  // probing it as-is would fail authentication on a working tunnel.
  const opts = index.testProbeOptionsOf(
    { op: 'test', readOnly: true, ssh: { host: 'bastion.example.com', user: 'deploy', auth: 'password' } },
    savedRow(),
  )
  assert.equal(opts.ro, true)
  assert.equal(opts.ssh.host, 'bastion.example.com')
  assert.equal(opts.ssh.password, 'CHANGE_ME', 'the stored secret fills what the card could not send')
})

test('an edited tunnel still probes on a row that has no stored one', () => {
  const opts = index.testProbeOptionsOf(
    { op: 'test', ssh: { host: '192.0.2.10', user: 'ops', auth: 'key', keyPath: '~/.ssh/id_ed25519' } },
    undefined,
  )
  assert.equal(opts.ssh.user, 'ops')
  assert.equal(opts.ssh.host, '192.0.2.10')
})

test('a non-object ssh value falls back to the stored tunnel (never to a bare probe)', () => {
  const opts = index.testProbeOptionsOf({ op: 'test', ssh: 'garbage' }, savedRow())
  assert.equal(opts.ssh.user, 'deploy')
  // …and with nothing stored there is no tunnel to probe.
  assert.equal(index.testProbeOptionsOf({ op: 'test', ssh: 'garbage' }, undefined).ssh, null)
})

// ── wiring: the handler must use the helpers ────────────────────────────────

test('handleTestOp decides the probe options through the exported helpers', () => {
  // The helpers are only worth their tests if the dispatch really uses them (and
  // in that order: `opHasOptions` chooses BETWEEN the two blocks below).
  const source = readFileSync(join(here, '..', 'lib', 'index.mjs'), 'utf8')
  assert.match(source, /const opHasOptions = testOpHasOptions\(op\)/)
  assert.match(source, /const probeOptionsOf = \(savedRow\) => testProbeOptionsOf\(op, savedRow\)/)
  const decision = source.indexOf('const conn = opHasOptions')
  assert.ok(decision > 0, 'the probe must branch on opHasOptions')
  assert.match(source.slice(decision, decision + 220), /probeOptions\.ssh/)
})

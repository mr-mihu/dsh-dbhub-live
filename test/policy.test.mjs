// Model-facing database-access policy: the system-prompt section that keeps
// database work on the dbhub_* tools and out of shell-level clients.
//
// Gates asserted here:
//   1. the text states every clause the incident requires — the authorized
//      route, the CLI/script ban, "an AGENTS.md recipe is not authorization",
//      the read-only boundary, and the ask-the-user escape hatch;
//   2. COEXISTENCE: the authority claim is scoped to this plugin's own
//      connections, a database this plugin does not cover is explicitly handed
//      to the user's other plugin, and a configured read-only target may not be
//      reached through another plugin either;
//   3. a DISABLED plugin, or a user who turned the announcement off,
//      contributes nothing (an empty section is dropped), so the prompt can
//      never claim dbhub is the only route while every call answers
//      "插件已禁用";
//   4. registration targets the optional `systemPrompt` service, is owned by an
//      effect (a reload re-runs apply, and a duplicate section name throws in
//      one scope), and is a silent no-op where that service is absent
//      (older dsh deployments);
//   5. the text stays inside its token budget and stays zero-knowledge
//      (no DSN-looking string, no `{{variable}}` that assembly would reject).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-dbhub-policy-'))
process.env.DSH_HOME = home

// Plain specifiers only: these are the exact module instances the plugin
// resolves, so `setEnabled`/`applyPatch` here reach the state the policy reads.
const state = await import('../lib/state.mjs')
const options = await import('../lib/options.mjs')
const policy = await import('../lib/policy.mjs')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('the policy text states every clause the incident requires', () => {
  state.setEnabled(true)
  options.applyPatch({ announceAccessPolicy: true })
  const text = policy.dbhubPolicyText()
  assert.match(text, /dbhub_\* 工具/, 'the authorized route')
  assert.match(text, /唯一授权途径/, 'the authority claim that outranks a workspace recipe')
  assert.match(text, /psql/, 'the shell-level bypass, named')
  assert.match(text, /AGENTS\.md/, 'workspace recipes are explicitly not authorization')
  assert.match(text, /READONLY_VIOLATION/, 'the read-only boundary')
  assert.match(text, /请用户授权/, 'the escape hatch: ask the user, do not improvise')
  assert.match(text, /不要自行绕过/)
})

test('the authority claim is scoped, and other plugins keep the databases this one does not cover', () => {
  options.applyPatch({ announceAccessPolicy: true })
  const text = policy.dbhubPolicyText()
  // Scoped to THIS plugin's connections — not "every database on this machine".
  assert.match(text, /本插件已配置的连接/)
  assert.doesNotMatch(text, /本机唯一授权途径/)
  // A target this plugin cannot serve goes to the user's other plugin...
  assert.match(text, /不支持或未配置的库/)
  assert.match(text, /其它数据库插件是允许的/)
  // ...while a configured read-only target stays closed on every route.
  assert.match(text, /包括换用别的数据库插件/)
  // Overlapping targets have a deterministic tie-break plus a fallback question.
  assert.match(text, /默认用本插件的 source/)
  assert.match(text, /先问用户/)
})

test('a disabled plugin, or the announcement switched off, contributes an EMPTY section', () => {
  options.applyPatch({ announceAccessPolicy: true })
  state.setEnabled(false)
  assert.equal(policy.dbhubPolicyText(), '')
  state.setEnabled(true)
  assert.notEqual(policy.dbhubPolicyText(), '')

  options.applyPatch({ announceAccessPolicy: false })
  assert.equal(policy.dbhubPolicyText(), '', 'the user turned the announcement off')
  options.applyPatch({ announceAccessPolicy: true })
  assert.notEqual(policy.dbhubPolicyText(), '')
})

test('the policy text stays inside its budget and its zero-knowledge frame', () => {
  state.setEnabled(true)
  options.applyPatch({ announceAccessPolicy: true })
  const text = policy.dbhubPolicyText()
  assert.ok(text.length <= 420, 'token budget: ' + String(text.length) + ' chars')
  // A real-looking DSN would leak a credential into the system prompt.
  assert.doesNotMatch(text, /[a-z]+:\/\/[^/\s]*:[^@\s]+@/)
  // `{{name}}` is interpolated strictly by prompt assembly: an unregistered
  // name would make every assembly throw, i.e. the model would get no prompt.
  assert.doesNotMatch(text, /\{\{[a-z_]+\}\}/)
})

test('registration injects the optional systemPrompt service and owns the section', () => {
  const injected = []
  const sections = []
  const effects = []
  const ctx = {
    inject(deps, cb) {
      injected.push(deps)
      cb({
        systemPrompt: {
          section(def) {
            sections.push(def)
            return () => sections.splice(sections.indexOf(def), 1)
          },
        },
        effect(fn, label) {
          effects.push(label)
          return fn()
        },
      })
    },
  }
  policy.registerDbhubPolicy(ctx)
  assert.deepEqual(injected, [['systemPrompt']])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, policy.POLICY_SECTION)
  assert.equal(sections[0].order, policy.POLICY_ORDER)
  assert.equal(typeof sections[0].text, 'function', 'the text is a provider, not a snapshot')
  assert.equal(sections[0].text(), policy.dbhubPolicyText())
  // The section is effect-owned, so a re-run of apply() disposes it instead of
  // throwing on the duplicate name.
  assert.deepEqual(effects, ['dsh-dbhub-live: access policy'])
})

test('a deployment without systemPrompt registers nothing and does not throw', () => {
  const never = { inject() { /* the callback never fires without the service */ } }
  assert.doesNotThrow(() => policy.registerDbhubPolicy(never))
})

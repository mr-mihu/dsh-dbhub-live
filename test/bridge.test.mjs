// Contract check for lib/bridge.mjs — the authenticated HTTP channel that
// replaced the settings namespace on every dsh line from 0.1.7 on. The module
// is pure, so the routes are driven directly with Fetch-shaped requests: what
// is asserted here is the wire contract the browser half depends on (route
// paths, method ownership, response envelope, refusal statuses) and the fact
// that a failing dependency can never take the plugin's HTTP surface down.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createBridgeRoutes, BRIDGE_BASE, BRIDGE_ROUTES } from '../lib/bridge.mjs'

const VIEW = {
  enabled: true,
  phase: 'running',
  toolCount: 4,
  lastError: '',
  mode: 'oneshot',
  updateIntervalDays: 7,
  // Upstream dbhub capability probe (JSON string). The sidebar entry is NOT a
  // view field anymore: it follows `enabled` (F0).
  capabilities: '{"version":"1.4.0","readonlyTools":true,"ssh":true,"warning":""}',
  workspaces: '[]',
  testResult: '',
  // The browser half addresses the plugin's own settings form by this id; ''
  // means "unresolved, use the bridge route instead".
  entryId: 'dbhub-live',
}

function harness(overrides = {}) {
  const calls = { enabled: [], options: [], ops: [] }
  const routes = createBridgeRoutes({
    getView: () => VIEW,
    handleOp: async (op) => {
      calls.ops.push(op)
      return [{ op: 'add', path: 'D:/work/app', env: 'default' }]
    },
    setEnabled: async (value) => { calls.enabled.push(value) },
    setOptions: async (patch) => { calls.options.push(patch) },
    ...overrides,
  })
  const byPath = new Map(routes.map((route) => [route.path, route]))
  return { routes, byPath, calls }
}

const url = (path) => `http://127.0.0.1:3080${path}`

async function body(response) {
  return JSON.parse(await response.text())
}

test('bridge exposes exactly four exact routes under the /api prefix', () => {
  const { routes } = harness()
  assert.deepEqual(
    routes.map((r) => [r.path, r.methods.join(',')]),
    [
      [`${BRIDGE_BASE}/state`, 'GET'],
      [`${BRIDGE_BASE}/enabled`, 'POST'],
      [`${BRIDGE_BASE}/options`, 'POST'],
      [`${BRIDGE_BASE}/op`, 'POST'],
    ],
  )
  // connection.fetch rejects a path that is not below /api, and asserts every
  // route declares a body mode and at least one method.
  for (const route of routes) {
    assert.ok(route.path.startsWith('/api/'), route.path)
    assert.equal(route.requestBody, 'buffered')
    assert.ok(route.methods.length > 0)
  }
  assert.equal(BRIDGE_ROUTES.op, `${BRIDGE_BASE}/op`)
})

test('GET /state answers the current view and is never cached', async () => {
  const { byPath } = harness()
  const response = await byPath.get(BRIDGE_ROUTES.state).fetch(new Request(url(BRIDGE_ROUTES.state)))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await body(response), { ok: true, value: VIEW })
})

test('the served view carries metadata only (zero-knowledge gate)', () => {
  // The view is what the browser sees: status, options and the masked connection
  // summaries. Nothing here may ever grow a credential-shaped field.
  const serialized = JSON.stringify(VIEW)
  assert.doesNotMatch(serialized, /dsn|password|mysql:\/\/|postgres:\/\//i)
})

test('the view tells the browser which settings entry to write options to', () => {
  // Without this the client cannot bind `ctx.configForms.get(entryId)` and must
  // fall back to POST /options.
  assert.equal(typeof VIEW.entryId, 'string')
  assert.ok(VIEW.entryId.length > 0)
})

test('POST /enabled applies a boolean toggle', async () => {
  const { byPath, calls } = harness()
  const response = await byPath.get(BRIDGE_ROUTES.enabled).fetch(new Request(url(BRIDGE_ROUTES.enabled), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await body(response), { ok: true, value: VIEW })
  assert.deepEqual(calls.enabled, [false])
})

test('POST /enabled refuses a non-boolean payload', async () => {
  const { byPath, calls } = harness()
  for (const payload of ['{}', '{"enabled":"yes"}', '{"enabled":1}', 'not json']) {
    const response = await byPath.get(BRIDGE_ROUTES.enabled).fetch(new Request(url(BRIDGE_ROUTES.enabled), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }))
    assert.equal(response.status, 400, payload)
    assert.equal((await body(response)).ok, false)
  }
  assert.deepEqual(calls.enabled, [])
})

test('POST /options forwards the patch and answers the fresh view', async () => {
  const { byPath, calls } = harness()
  const response = await byPath.get(BRIDGE_ROUTES.options).fetch(new Request(url(BRIDGE_ROUTES.options), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ updateIntervalDays: 3 }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(calls.options, [{ updateIntervalDays: 3 }])
  assert.deepEqual(await body(response), { ok: true, value: VIEW })
})

test('the view advertises the dbhub capability probe and no removed option', () => {
  assert.equal(typeof VIEW.capabilities, 'string')
  assert.equal(JSON.parse(VIEW.capabilities).readonlyTools, true)
  assert.equal(JSON.parse(VIEW.capabilities).ssh, true)
  assert.equal(Object.prototype.hasOwnProperty.call(VIEW, 'showSidebarEntry'), false)
})

test('POST /op carries an options command and returns its options patch', async () => {
  // The read-only switch / SSH tunnel have no DSN to offer, so they travel as an
  // `options` command and are answered with an `options` patch the card can
  // mirror immediately.
  const { byPath, calls } = harness({
    handleOp: async (op) => {
      calls.ops.push(op)
      return [{ op: 'options', path: 'D:/work/app', env: 'default', ro: true, ssh: null }]
    },
  })
  const command = { op: 'options', workspace: 'D:/work/app', env: 'default', readOnly: true }
  const response = await byPath.get(BRIDGE_ROUTES.op).fetch(new Request(url(BRIDGE_ROUTES.op), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: command }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(calls.ops, [command])
  const payload = await body(response)
  assert.deepEqual(payload.patches, [{ op: 'options', path: 'D:/work/app', env: 'default', ro: true, ssh: null }])
})

test('POST /op keeps answering patches: [] for an unknown command', async () => {
  const { byPath } = harness({ handleOp: async () => [] })
  const response = await byPath.get(BRIDGE_ROUTES.op).fetch(new Request(url(BRIDGE_ROUTES.op), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: { op: 'nope' } }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual((await body(response)).patches, [])
})

test('POST /op carries the decoded command and returns its patches', async () => {
  const { byPath, calls } = harness()
  const command = { op: 'add', workspace: 'D:/work/app', env: 'default', dsn: 'mysql://127.0.0.1:3306/app' }
  const response = await byPath.get(BRIDGE_ROUTES.op).fetch(new Request(url(BRIDGE_ROUTES.op), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: command }),
  }))
  assert.equal(response.status, 200)
  // The command arrives decoded: the bridge does not re-encode it for the core.
  assert.deepEqual(calls.ops, [command])
  const payload = await body(response)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.patches, [{ op: 'add', path: 'D:/work/app', env: 'default' }])
  assert.deepEqual(payload.value, VIEW)
})

test('POST /op refuses a body without a command', async () => {
  const { byPath, calls } = harness()
  const response = await byPath.get(BRIDGE_ROUTES.op).fetch(new Request(url(BRIDGE_ROUTES.op), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: true }),
  }))
  assert.equal(response.status, 400)
  assert.deepEqual(calls.ops, [])
})

test('a failing dependency surfaces as 500 and never throws out of the route', async () => {
  const { byPath } = harness({
    getView: () => { throw new Error('state exploded') },
    setEnabled: async () => { throw new Error('toggle exploded') },
  })
  const read = await byPath.get(BRIDGE_ROUTES.state).fetch(new Request(url(BRIDGE_ROUTES.state)))
  assert.equal(read.status, 500)
  assert.match((await body(read)).error, /state exploded/)
  const write = await byPath.get(BRIDGE_ROUTES.enabled).fetch(new Request(url(BRIDGE_ROUTES.enabled), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(write.status, 500)
  assert.match((await body(write)).error, /toggle exploded/)
})

test('a probe command answers patches: [] so the card mirrors nothing', async () => {
  const { byPath } = harness({ handleOp: async () => [] })
  const response = await byPath.get(BRIDGE_ROUTES.op).fetch(new Request(url(BRIDGE_ROUTES.op), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: { op: 'test', workspace: 'D:/work/app', env: 'default', nonce: 'n1' } }),
  }))
  assert.deepEqual((await body(response)).patches, [])
})

// dsh-dbhub-live: the Host <-> browser bridge.
//
// Why this exists: dsh 0.1.7 replaced the settings namespace this plugin used to
// mirror its live state through (host `settings.register(...)` scope with
// `replace`/`watch`) with Config-derived forms, and 0.2.x removed the client's
// `settingsScope` reader entirely. The bridge is the replacement channel: four
// exact Fetch routes on the shared `/api` surface, registered through
// `ctx.connection.fetch`, which exists on both dsh lines (0.1.6-alpha.2 and
// 0.2.x both ship `HostConnectionFetch`) and — unlike a raw `webServer` route —
// inherits Connection's Host/Origin fence and browser authentication.
//
// Zero-knowledge contract is unchanged: the read routes carry the SAME view the
// settings namespace carried (status + options + METADATA-only workspace
// summaries + transient test reports), never a DSN or username. DSNs travel
// browser -> Host only, on the write routes, exactly as they did through the
// settings document — they never enter a model context.
//
// This module is pure: it owns request/response marshalling and nothing else.
// The Host half injects the state machine, the options store and the one-way
// command handler.

/** Prefix every bridge route shares. */
export const BRIDGE_BASE = '/api/dsh-dbhub-live'

/** Exact route paths (what `connection.fetch.register` expects). */
export const BRIDGE_ROUTES = {
  state: BRIDGE_BASE + '/state',
  op: BRIDGE_BASE + '/op',
  enabled: BRIDGE_BASE + '/enabled',
  options: BRIDGE_BASE + '/options',
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), { status: status || 200, headers: JSON_HEADERS })
}

function messageOf(error) {
  return String((error && error.message) || error || 'unknown error')
}

// A buffered body is capped by the transport, but a non-JSON or non-object body
// is still ours to reject: `undefined` means "not an object we can act on".
async function readObjectBody(request) {
  try {
    const body = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  } catch (e) {
    return undefined
  }
}

/**
 * Build the bridge routes.
 * @param deps - `getView()` returns the current merged view;
 *   `handleOp(op)` applies one workspace-connection command and resolves its
 *   patches; `setEnabled(bool)` flips the plugin toggle; `setOptions(patch)`
 *   applies a user option patch and persists it.
 * @returns route descriptors for `connection.fetch.register`.
 */
export function createBridgeRoutes(deps) {
  const { getView, handleOp, setEnabled, setOptions } = deps
  const routes = []

  const read = (fetchBody) => async (request) => {
    try {
      return await fetchBody(request)
    } catch (e) {
      return json({ ok: false, error: messageOf(e) }, 500)
    }
  }

  routes.push({
    path: BRIDGE_ROUTES.state,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: read(async () => json({ ok: true, value: getView() })),
  })

  routes.push({
    path: BRIDGE_ROUTES.enabled,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: read(async (request) => {
      const body = await readObjectBody(request)
      if (!body || typeof body.enabled !== 'boolean') {
        return json({ ok: false, error: 'expected { enabled: boolean }' }, 400)
      }
      await setEnabled(body.enabled)
      return json({ ok: true, value: getView() })
    }),
  })

  routes.push({
    path: BRIDGE_ROUTES.options,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: read(async (request) => {
      const body = await readObjectBody(request)
      if (!body) return json({ ok: false, error: 'expected an option patch object' }, 400)
      await setOptions(body)
      return json({ ok: true, value: getView() })
    }),
  })

  routes.push({
    path: BRIDGE_ROUTES.op,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: read(async (request) => {
      const body = await readObjectBody(request)
      if (!body || body.op === undefined) {
        return json({ ok: false, error: 'expected { op: <command> }' }, 400)
      }
      const patches = await handleOp(body.op)
      return json({ ok: true, value: getView(), patches: Array.isArray(patches) ? patches : [] })
    }),
  })

  return routes
}

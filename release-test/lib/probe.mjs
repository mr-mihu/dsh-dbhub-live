// HTTP + log probes. Every probe returns a check:
//   { id, status: 'pass' | 'fail' | 'warn' | 'skip' | 'info', detail, evidence? }
// 'fail' on a declared target blocks the release; 'warn' and 'skip' ask the AI
// reviewer to look; 'info' is recorded but never judged.
import fs from 'node:fs'
import path from 'node:path'
import { readIfExists } from './proc.mjs'
import { redact, tail } from './util.mjs'
import { LOG_CHANNELS, expectationsFor } from './matrix.mjs'

const check = (id, status, detail, evidence = undefined) => ({ id, status, detail, ...(evidence ? { evidence } : {}) })

const HTTP_TIMEOUT_MS = 15_000

async function httpGet(url, { cookie, redirect = 'manual' } = {}) {
  const response = await fetch(url, { redirect, headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  const body = await response.text()
  return { status: response.status, body, headers: response.headers }
}

async function httpPost(url, payload, { cookie } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const body = await response.text()
  return { status: response.status, body }
}

/** Extract the `name=value` cookie the token exchange handed out. */
export async function openSession(base, token) {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  await response.text()
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const cookie = setCookies
    .map((line) => line.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  return { cookie, status: response.status }
}

const safeParse = (text) => { try { return JSON.parse(text) } catch { return null } }

/**
 * Run every probe for one booted target.
 * `ctx` = { version, target, base, token, cookie, home, logFile, artifact, provisionMode, boot }
 */
export async function runProbes(ctx) {
  const { version, target, base, cookie, home, logFile, artifact, boot, provisionMode } = ctx
  const checks = []
  const expect = expectationsFor(target)
  const log = readIfExists(logFile)
  const pluginLog = log.split('\n').filter((line) => line.includes('[dsh-dbhub-live]')).join('\n')

  // ---- install / provisioning ------------------------------------------------
  checks.push(
    provisionMode === 'manual'
      ? check('provision.mode', 'warn', 'plugin was copied into the profile (manual mode): artifact content verified, real `dsh plugin add` path NOT exercised')
      : check('provision.mode', 'pass', `plugin installed through dsh plugin add (${provisionMode})`),
  )
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'node_modules', artifact.name, 'package.json'), 'utf8'))
    checks.push(
      installed.version === artifact.version
        ? check('provision.version', 'pass', `installed ${installed.name}@${installed.version} matches artifact`)
        : check('provision.version', 'fail', `installed ${installed.version} but artifact is ${artifact.version}`),
    )
    checks.push(
      installed.dsh?.bundle ? check('provision.bundle-manifest', 'pass', 'installed package declares dsh.bundle') : check('provision.bundle-manifest', 'fail', 'installed package has no dsh.bundle'),
    )
  } catch (error) {
    checks.push(check('provision.version', 'fail', `cannot read installed package.json: ${error.message}`))
  }

  // ---- boot timing -----------------------------------------------------------
  // A cold first boot on a fresh home has been observed at ~60s (dbhub probe +
  // client module scan); only flag genuinely slow starts so this stays a signal.
  checks.push(
    boot.readyMs > 90_000
      ? check('boot.ready', 'warn', `ready line took ${boot.readyMs}ms (>90s)`, tail(pluginLog, 1200))
      : check('boot.ready', 'pass', `ready line after ${boot.readyMs}ms`),
  )

  // ---- log channels ----------------------------------------------------------
  const apply = LOG_CHANNELS.apply.re.test(pluginLog)
  checks.push(apply ? check('log.apply', 'pass', 'host apply line present') : check('log.apply', 'fail', 'no "[dsh-dbhub-live] host apply" line in the boot log', tail(pluginLog, 1200)))

  const tools = LOG_CHANNELS.tools.re.exec(pluginLog)
  if (!tools) {
    checks.push(check('log.tools', 'fail', 'no tool-count line in the boot log', tail(pluginLog, 1200)))
  } else if (Number(tools[1]) !== 4) {
    checks.push(check('log.tools', 'fail', `plugin registered ${tools[1]} tools, expected exactly 4`))
  } else {
    checks.push(check('log.tools', 'pass', 'exactly 4 tools registered'))
  }

  const channel = (key, id, required) => {
    const found = LOG_CHANNELS[key].re.test(pluginLog)
    if (found) return check(id, 'pass', `log line present: ${LOG_CHANNELS[key].label}`)
    if (required === 'required') return check(id, 'fail', `expected log line missing: ${LOG_CHANNELS[key].label}`)
    if (required === 'optional') return check(id, 'info', `absent (optional for this version): ${LOG_CHANNELS[key].label}`)
    return check(id, 'warn', `line unexpectedly present: ${LOG_CHANNELS[key].label} — matrix says this host should not reach that channel`)
  }
  checks.push(channel('bridge', 'log.bridge', expect.bridge))
  // The legacy settings namespace and the config form are not equally
  // distinguishing: hosts have been observed exposing `settings.register` on
  // modern releases too, so presence there is recorded rather than required.
  const settingsPresent = LOG_CHANNELS.settingsNamespace.re.test(pluginLog)
  checks.push(
    settingsPresent
      ? check('log.settings-namespace', 'info', 'legacy settings namespace also registered on this host')
      : expect.settingsNamespace === 'required'
        ? check('log.settings-namespace', 'fail', 'expected legacy settings namespace registration, not found')
        : check('log.settings-namespace', 'info', 'legacy settings namespace not registered'),
  )
  checks.push(channel('configForm', 'log.config-form', expect.configForm))
  checks.push(LOG_CHANNELS.accessPolicy.re.test(pluginLog) ? check('log.access-policy', 'pass', 'access-policy system prompt section registered') : check('log.access-policy', 'info', 'access-policy line absent (artifact predates the policy section?)'))

  const bridgePresent = LOG_CHANNELS.bridge.re.test(pluginLog)
  const httpAvailable = bridgePresent || expect.bridge !== 'optional'
  if (!bridgePresent && expect.bridge === 'optional') {
    checks.push(check('http.bridge', 'skip', 'no HTTP bridge on this host (legacy settings namespace path) — HTTP API probes skipped for this target'))
  } else if (bridgePresent) {
    checks.push(check('http.bridge', 'pass', 'HTTP bridge registered on /api/dsh-dbhub-live/*'))
  } else {
    checks.push(check('http.bridge', 'fail', 'expected the HTTP bridge to register, but the boot log has no bridge line'))
  }

  // ---- HTTP API (bridge channel) --------------------------------------------
  if (httpAvailable) {
    const state = await httpGet(`${base}/api/dsh-dbhub-live/state`, { cookie })
    const stateJson = safeParse(state.body)
    if (state.status !== 200) {
      checks.push(check('http.state', 'fail', `GET /api/dsh-dbhub-live/state with a session cookie returned ${state.status}`, tail(redact(state.body), 500)))
    } else if (!stateJson?.ok) {
      checks.push(check('http.state', 'fail', 'state endpoint returned 200 but not {ok:true}', tail(redact(state.body), 500)))
    } else {
      const value = stateJson.value ?? {}
      const problems = []
      if (value.toolCount !== 4) problems.push(`toolCount=${value.toolCount}`)
      if (value.phase !== 'running') problems.push(`phase=${value.phase}`)
      if (value.enabled !== true) problems.push(`enabled=${value.enabled}`)
      if (value.mode !== 'oneshot') problems.push(`mode=${value.mode}`)
      if (value.lastError) problems.push(`lastError=${value.lastError}`)
      checks.push(
        problems.length
          ? check('http.state', 'fail', `state view is not healthy: ${problems.join(', ')}`, redact(state.body))
          : check('http.state', 'pass', 'state healthy (toolCount=4, phase=running, mode=oneshot)', redact(state.body)),
      )

      // The view carries the running build's identity on 5.2+. Asserting it is
      // how a "tested the wrong artifact" or a broken dshModern gate gets caught.
      if (value.pluginVersion === undefined) {
        checks.push(check('state.version-fields', 'info', 'view has no pluginVersion/dshVersion/dshModern fields (artifact predates them)'))
      } else {
        checks.push(
          value.pluginVersion === artifact.version
            ? check('state.plugin-version', 'pass', `running plugin version ${value.pluginVersion} matches artifact`)
            : check('state.plugin-version', 'fail', `running plugin version ${value.pluginVersion}, artifact is ${artifact.version}`),
        )
        checks.push(
          value.dshVersion === version
            ? check('state.dsh-version', 'pass', `plugin detects host ${value.dshVersion}`)
            : check('state.dsh-version', 'fail', `plugin detects host ${value.dshVersion}, expected ${version}`),
        )
        const wantModern = target.ui === 'modern'
        checks.push(
          value.dshModern === wantModern
            ? check('state.ui-mode', 'pass', `dshModern=${value.dshModern} matches the matrix (${target.ui} face)`)
            : check('state.ui-mode', 'fail', `dshModern=${value.dshModern}, but the matrix expects the ${target.ui} face for ${version}`),
        )
      }

      // zero-knowledge red line: nothing credential-shaped may reach the browser
      const leak = /:\/\/[^\s/@]+:[^\s/@]+@/.test(state.body)
      checks.push(leak ? check('http.state.no-credentials', 'fail', 'state payload contains a credentialed URL (zero-knowledge violation)') : check('http.state.no-credentials', 'pass', 'state payload carries metadata only'))
    }

    const anonymous = await httpGet(`${base}/api/dsh-dbhub-live/state`)
    checks.push(
      anonymous.status === 401
        ? check('http.auth', 'pass', 'anonymous state request is rejected with 401')
        : check('http.auth', 'fail', `anonymous state request returned ${anonymous.status}, expected 401`),
    )

    const probeDays = 3
    const optionsResponse = await httpPost(`${base}/api/dsh-dbhub-live/options`, { updateIntervalDays: probeDays }, { cookie })
    const prefsFile = path.join(home, 'storages', 'dsh-dbhub-live', 'prefs.json')
    let persisted = null
    try { persisted = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) } catch {}
    checks.push(
      optionsResponse.status === 200 && persisted?.updateIntervalDays === probeDays
        ? check('http.options.write', 'pass', `options write persisted (updateIntervalDays=${probeDays})`)
        : check('http.options.write', 'fail', `options write did not persist: HTTP ${optionsResponse.status}, prefs=${JSON.stringify(persisted)}`),
    )

    const opResponse = await httpPost(`${base}/api/dsh-dbhub-live/op`, { op: { op: '__release_test_noop__' } }, { cookie })
    const opJson = safeParse(opResponse.body)
    checks.push(
      opResponse.status === 200 && opJson?.ok === true
        ? check('http.op.invalid', 'pass', 'unknown config op is answered with ok:true and no patches')
        : check('http.op.invalid', 'fail', `unknown config op misbehaved: HTTP ${opResponse.status}`, tail(redact(opResponse.body), 400)),
    )
  }

  // ---- client bundle (served regardless of the host channel) -----------------
  const index = await httpGet(`${base}/`, { cookie })
  const manifest = /"id"\s*:\s*"dsh-dbhub-live"[^}]*"url"\s*:\s*"([^"]+)"/.exec(index.body)
  if (!manifest) {
    checks.push(check('http.bundle.manifest', 'fail', 'index HTML has no module-manifest entry for dsh-dbhub-live (client half not served)'))
  } else {
    checks.push(check('http.bundle.manifest', 'pass', `manifest entry: ${redact(manifest[1])}`))
    const bundleUrl = new URL(manifest[1], `${base}/`).toString()
    const bundle = await httpGet(bundleUrl, { cookie })
    const isJs = bundle.body.includes('__ModuleLoader__')
    checks.push(
      bundle.status === 200 && isJs && bundle.body.length > 1000
        ? check('http.bundle.fetch', 'pass', `client bundle served: HTTP 200, ${bundle.body.length} bytes, module-loader marker present`)
        : check('http.bundle.fetch', 'fail', `client bundle not usable: HTTP ${bundle.status}, ${bundle.body.length} bytes, loader marker ${isJs}`, tail(redact(bundle.body), 400)),
    )
  }

  // ---- informational ---------------------------------------------------------
  const capability = LOG_CHANNELS.capability.re.exec(pluginLog)
  checks.push(
    capability
      ? check('dbhub.capability', 'info', `dbhub detected: version=${capability[1]}`)
      : check('dbhub.capability', 'warn', 'no dbhub capability line — dbhub may be missing on this machine or the plugin failed to resolve it'),
  )

  // Unexpected errors in the plugin's own log lines are a review trigger even
  // when every structured probe passed. Known-benign legacy lines are excluded:
  // on 0.1.5/0.1.6 a successful POST /options still logs "配置表单写入失败（仅本地
  // prefs 生效）" because those hosts have no settings.configure to write back to.
  const BENIGN = /配置表单写入失败（仅本地 prefs 生效）/
  const suspicious = pluginLog.split('\n').filter((line) => !BENIGN.test(line)).filter((line) => /error|exception|unhandled|failed|失败|错误/i.test(line))
  if (suspicious.length) {
    checks.push(check('log.unexpected-errors', 'warn', `${suspicious.length} error-ish plugin log line(s)`, tail(suspicious.join('\n'), 800)))
  } else {
    checks.push(check('log.unexpected-errors', 'pass', 'no error-ish lines from the plugin'))
  }

  return checks
}

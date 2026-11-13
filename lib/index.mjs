// dsh-dbhub-live v4.0: STATELESS zero-knowledge dbhub executor + live status UI.
//
// Cordis namespace plugin (named exports, no default export). Installed as a
// dsh profile bundle: `dsh plugin --profile web add dsh-dbhub-live`.
//
// Architecture:
//   - NO resident dbhub server. Every tool call (dbhub_execute_sql /
//     dbhub_search_objects) spawns its OWN throwaway `dbhub --transport stdio
//     --dsn <dsn>` process and kills it after the call — execution is
//     stateless, concurrent (process-per-call) and fault-isolated. There is no
//     toml, no fingerprint, no idle recycle, no orphan cleanup, and no port to
//     collide on across DSH instances.
//   - Zero-knowledge model contract: the model only ever sees source handles
//     (`<workspace>[_<env>]`) and METADATA (type/host/port/database). DSNs,
//     usernames and passwords live host-side and never reach the model;
//     dbhub_configure collects the password through a UI question
//     (askUser), not through a tool argument.
//   - Config is the asset: credentials.json (workspace × environment → DSN)
//     + mise/.env auto-discovery + authorized project-file scan + the
//     settings card. Every write is atomic (tmp+rename).
//   - Lazy nothing: tools register immediately; the dbhub executable resolves
//     (persisted → mise → PATH → auto-install) on first execution.
//   - Live status: the host publishes ONE view (enabled toggle + options +
//     metadata-only workspace summaries) and fans it out through the
//     authenticated `connection.fetch` bridge at /api/dsh-dbhub-live/*. There
//     is no second channel: dsh 0.1.x is no longer supported (dsh >= 0.2.1),
//     and the old settings-namespace mirror those releases used is gone.
//
// Data (credentials.json, runtime.json, dbhub-runtime/) lives in
// $DSH_HOME/storages/dsh-dbhub-live — outside the module tree, since the
// module may be installed under the profile's node_modules (pnpm-managed)
// which must not be written to. The process environment is deliberately NOT
// consulted for connections.

import {
  maybeRefreshDbhub,
} from './runtime.mjs'
import {
  activeToolCount, refreshToolCount,
  collectSources, latestSummaries, hasRowCache, createRowMirror,
  cachedRows, resolveTestDsn,
} from './mcp.mjs'
import { registerCoreTools } from './tools.mjs'
import { registerDbhubPolicy } from './policy.mjs'
import { probeConnection, probeSshTunnel, hostTimeoutFor, PROBE_TIMEOUT_SSH_MS, defaultKeyNoteOf } from './adhoc.mjs'
import { sweepTempToml } from './toml.mjs'
import { detectDbhubCapabilities } from './capability.mjs'
import { resolveDbhubExe } from './runtime.mjs'
import { createBridgeRoutes, BRIDGE_BASE } from './bridge.mjs'
import {
  store, listWorkspaces, setWorkspaceEnv, setWorkspaceEnvOptions, removeWorkspaceEnv,
  renameWorkspaceEnv, normalizeEnvName, ENV_NAME_MAX, listWorkspaceEnvironments, resolveWorkspaceEnvs,
  envNameTruncatesOntoExisting,
  normalizeSshOptions, mergeSshOptions, scrubSecrets, sweepLegacyConfigFile, warnOnce,
  credentialsOf, resolveEnvSecrets, encryptSshSecrets, releaseSshSecrets, migrateSecrets,
  encryptDsnPassword, releaseDsnSecret,
} from './config.mjs'
import { setLocaleProvider, currentT } from './i18n.mjs'
// Version metadata (plugin/dsh/runtime) and the plugin self-update check are
// leaf modules (node builtins only), so importing them here cannot create a
// dependency cycle.
import { versionMeta } from './meta.mjs'
import { createUpdateChecker } from './update.mjs'
import * as state from './state.mjs'
import * as options from './options.mjs'

export const name = 'dsh-dbhub-live'
// Real-module Guard requires declared injection before touching `ctx.tools`;
// the timer mixin powers idle recycling.
export const inject = ['tools', 'timer']

// ── Config: the two UI options declared for the official Plugins form ─────

// The plugin's own Config: the UI options, declared as `.volatile()` fields so
// dsh serves them in the official Plugins form and commits edits straight into
// live references. `undefined` when schemastery is unavailable — the Loader
// skips validation for a plugin without a Config, and every option keeps
// working off prefs.json and the bridge.
let CONFIG_SCHEMA
try {
  const z = (await import('@deepseek-ai/schemastery')).default
  const volatileField = (field) => (typeof field.volatile === 'function' ? field.volatile() : field)
  // No defaults on purpose: an unset field must be distinguishable from an
  // explicit choice, so `configValuesOf` can tell "the operator pinned this"
  // from "nobody said anything".
  CONFIG_SCHEMA = z.object({
    updateIntervalDays: volatileField(z.number().min(0)),
    showSidebarEntry: volatileField(z.boolean()),
    announceAccessPolicy: volatileField(z.boolean()),
    // Where query-result exports are written. '' = the plugin's default
    // directory; the write path PROVES the directory is writable (see
    // options.applyPatch), so a pinned value gets the same check as a page save.
    exportDir: volatileField(z.string()),
    // Global result row cap (0 = unlimited) and batch-test concurrency (1..8).
    // Validators in options.mjs are the authority; these bounds keep the
    // official Plugins form from offering an obviously invalid edit.
    defaultMaxRows: volatileField(z.number().min(0)),
    batchConcurrency: volatileField(z.number().min(1).max(8)),
  })
} catch (e) {
  console.warn('[dsh-dbhub-live] @deepseek-ai/schemastery 不可解析，跳过 Config 声明（页面与工具不受影响）')
}

// Declared Config (named export read by the Loader); absent when schemastery
// could not be imported.
export const Config = CONFIG_SCHEMA

// The plugin's own Loader entry id — the key every settings form is addressed
// by (`settings.update(id, …)`, `ctx.configForms.get(id)`). Read from the
// running fiber so a deployment that mounts this package under a different row
// id still works; `undefined` on a fiber with no entry (and on any runtime that
// predates `fiber.entry`).
function entryIdOf(ctx) {
  try {
    const entry = ctx && ctx.fiber ? ctx.fiber.entry : undefined
    const id = entry && entry.options ? entry.options.id : entry ? entry.id : undefined
    return typeof id === 'string' && id ? id : undefined
  } catch (e) {
    return undefined
  }
}

// Resolve a workspace selector (path or title) from the card ops. An EMPTY
// selector means "the current workspace" (the card leaves the field blank by
// default): fall back to the first registered workspace instead of dropping
// the op — a blank-workspace add/remove/test was silently discarded before.
//
// An EXPLICIT selector must MATCH. It used to slide to `workspaces[0]` when it
// did not, so a stale card (renamed/deleted workspace, expired page) removed,
// overwrote or wrote a row in a DIFFERENT workspace while reporting success.
// "Not found" is returned to the caller, which answers with a visible refusal.
// Two workspaces sharing a title are likewise never guessed between: the card
// can always send the path, and guessing by list order is how the wrong
// database gets written.
//
// The SAME listing the discovery walk uses (`listWorkspaces(ctx)`, which prefers
// the live workspace registry) resolves the card's selector, so a row written by
// the card is keyed by the path the walk will look it up under. Resolving it from
// a different source left rows that only the card could see.
async function resolveWorkspaceRef(ref, ctx) {
  const workspaces = await listWorkspaces(ctx)
  const wanted = String(ref || '').trim()
  if (!wanted) return workspaces[0] || undefined
  const byPath = workspaces.find((w) => w.path === wanted)
  if (byPath) return byPath
  const byTitle = workspaces.filter((w) => w.title === wanted)
  if (byTitle.length === 1) return byTitle[0]
  // `undefined` = "cannot be resolved" (0 matches, or an ambiguous title).
  return undefined
}

// Exported for the unit tests (they drive the resolver with a stub workspace
// listing): the contract "empty = current workspace, explicit = must match"
// is far cheaper to pin here than through the whole card channel.
export { resolveWorkspaceRef, handleConfigOp }

// Hard cap for one card connection test: the probe is a throwaway dbhub +
// SELECT 1, and the tiered budget comes from adhoc.mjs (`hostTimeoutFor`) — a
// tunnelled probe gets more room because SSH setup is slower. It must stay
// comfortably BELOW the client-side watchdog (which is tiered to match) so the
// {nonce, ok, message} report always wins the race against "测试超时未返回".

// Backstop: even if the underlying dbhub spawn never settles (subprocess-
// service hiccup), the card ALWAYS receives a report inside the probe budget
// instead of letting the browser-side watchdog answer with a bare timeout.
//
// The backstop timer stays REFERENCED (an `unref()`ed one is not a backstop:
// with nothing else pending the loop drains and the process exits before it can
// fire) and is cleared as soon as the race settles, so a fast probe never leaves
// a live timer behind.
function withProbeTimeout(promise, ms) {
  let timer
  const backstop = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, message: currentT('result.testTimeout') }), ms + 500)
  })
  return Promise.race([promise, backstop]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// ── the option half of a `{op:'test'}` command ──────────────────────────────
//
// Pure and exported so the three-state contract below is testable without a
// subprocess: a probe is the one place where "the card said nothing" and "the
// card said null" mean opposite things.

/**
 * Does this card test command carry OPTION information at all?
 *
 * `ssh: null` is INFORMATION ("the user cleared the tunnel"), not an absence.
 * Gating on truthiness (`op.ssh && …`) dropped exactly that case, so "clear the
 * tunnel, then test" fell through to the stored row and probed the tunnel that
 * had just been removed — green line for a connection execution would no longer
 * use. Presence of the key is the signal, whatever its value.
 */
export function testOpHasOptions(op) {
  if (!op || typeof op !== 'object') return false
  if (op.readOnly !== undefined) return true
  return Object.prototype.hasOwnProperty.call(op, 'ssh')
}

/**
 * The option block a probe must use for a workspace × environment.
 *
 * The card never echoes a stored secret back (`connDraftOf` omits
 * `ssh.password` / `ssh.passphrase` / `keyPath` by contract), so a pre-save
 * validation of a SAVED tunnelled row arrives with a secret-less ssh block.
 * Probing that block directly fails authentication, the card reports "✗ 失败",
 * and the only way forward is "save anyway" — which is exactly how a working
 * tunnel got dropped. Merging with the stored row first (the same rule
 * `kind:'ssh'` and the options write already use) makes the probe test the
 * tunnel that will actually be saved. No stored row → the card's block is used
 * as-is.
 *
 * THREE states, because "the card sent nothing" is not "the card sent null"
 * (`connDraftOf` OMITS the key while all three SSH fields are blank):
 *   · `null`      — the user switched the tunnel OFF, so probe WITHOUT it;
 *   · an object   — the form is being edited: merge the stored secret it
 *                   cannot echo back and probe THAT;
 *   · `undefined` — the card carried no SSH information at all, so the write
 *                   this probe precedes KEEPS the stored tunnel; probing a bare
 *                   connection would validate a connection execution never
 *                   uses (R61).
 * `mergeSshOptions(null, stored)` returns `null` (it passes a non-object
 * incoming through unchanged), which is exactly how the third case used to lose
 * the tunnel.
 */
export function testProbeOptionsOf(op, savedRow) {
  const source = op && typeof op === 'object' ? op : {}
  const stored = savedRow ? savedRow.ssh : null
  const cardSsh = source.ssh
  let ssh
  if (cardSsh === null) ssh = null
  else if (cardSsh && typeof cardSsh === 'object' && !Array.isArray(cardSsh)) ssh = mergeSshOptions(cardSsh, stored) || null
  else ssh = stored || null
  return { ro: source.readOnly === true, ssh }
}

// One card connection test: { op: 'test', workspace, env, nonce } (+ optional
// `dsn` / `readOnly` / `ssh` for a PRE-SAVE validation of unsaved options).
// Resolves the REAL DSN host-side (the card only ever holds the masked summary),
// then probes it through an isolated ad-hoc connection — the persistent server is
// never restarted or otherwise touched, and a failure only ever means a red
// line on the card. The compact {nonce, ok, message} report goes back through
// `reportTest` (the transient namespace `testResult` field); nothing is
// persisted.
//
// F4: resolving WHICH dsn to probe must not re-walk every workspace. A persisted
// row is read straight from the store, a row the card already displays comes
// from the in-memory mirror, and only a genuinely never-walked environment
// triggers the discovery walk. Two milestone logs carry the two segments so the
// split is observable on a real machine.
async function handleTestOp(op, ctx, subprocess, ws, reportTest) {
  const nonce = typeof op.nonce === 'string' ? op.nonce : ''
  const report = (ok, message) => {
    if (typeof reportTest !== 'function') return
    try {
      reportTest(JSON.stringify({ nonce, ok: ok === true, message: String(message || '') }))
    } catch (e) {
      /* the callback is ours; never let reporting break the op chain */
    }
  }
  // Unsaved options the card wants validated together with the connection (the
  // SSH panel and the read-only switch both use this).
  const opHasOptions = testOpHasOptions(op)
  const probeOptionsOf = (savedRow) => testProbeOptionsOf(op, savedRow)
  // SSH secrets live in the DSH credential service: resolve the reference for
  // THIS probe only (never cache, never publish). A ref whose value is gone must
  // fail loudly here — probing with an empty password would report a misleading
  // SSH authentication failure instead of "re-enter the password".
  const creds = credentialsOf(ctx)
  const probeOnce = async (conn, envName, wsTitle, tag) => {
    let effective
    try {
      effective = await resolveEnvSecrets(creds, conn)
    } catch (e) {
      if (!(e && (e.code === 'sshSecretMissing' || e.code === 'dsnSecretMissing'))) throw e
      report(false, currentT(e.code === 'sshSecretMissing' ? 'result.sshSecretMissing' : 'result.dsnSecretMissing'))
      return
    }
    const timeoutMs = hostTimeoutFor(effective)
    const started = Date.now()
    const res = await withProbeTimeout(probeConnection(subprocess, effective, timeoutMs), timeoutMs)
    console.log('[dsh-dbhub-live] ' + currentT('log.testProbeMs', { ms: String(Date.now() - started) }))
    report(res.ok, res.message)
    if (!res.ok) console.error('[dsh-dbhub-live] ' + currentT('log.testDone', { title: wsTitle, env: envName, result: 'FAIL' + tag + ' — ' + res.message }))
    else console.log('[dsh-dbhub-live] ' + currentT('log.testDone', { title: wsTitle, env: envName, result: 'OK' + tag + ' — ' + res.message }))
  }
  try {
    // Pre-save validation path: {op:'test', dsn, nonce, workspace, env} — the
    // card gates the "add/save" button on a live probe, so an unpersisted DSN
    // can be tested without writing to the store first.  When `dsn` is given
    // we skip the persisted-row lookup entirely and probe the raw string the
    // user typed (the masked-card flow still works: `dsn` is left blank and
    // we look up the row by workspace + env like before).
    const inlineDsn = typeof op.dsn === 'string' && op.dsn.trim() ? op.dsn.trim() : ''
    if (!ws) {
      // An explicit selector that does not resolve is refused, never answered
      // from "some workspace": probing the wrong row would report a red line (or
      // a bogus green one) for a connection the user was not looking at.
      report(false, currentT('result.wsNotFound', { ws: String(op.workspace || '-') }))
      return
    }
    const envName = normalizeEnvName(op.env)
    const savedRow = listWorkspaceEnvironments(store).find((r) => r.wsPath === ws.path && r.env === envName)
    // ── SSH-layer-only test ({op:'test', kind:'ssh'}) ────────────────────────
    // Answers "is it the tunnel or the database?": reachability of the bastion,
    // the local key file, and whether dbhub can bring the tunnel up at all. The
    // ssh block comes from the form (unsaved) or, for a saved row, from the
    // store — resolved WITHOUT a discovery walk.
    if (op.kind === 'ssh') {
      const fromCard = op.ssh && typeof op.ssh === 'object' ? op.ssh : null
      let ssh = fromCard
      {
        // Same "blank secret = keep the stored one" rule as the options write:
        // testing a saved tunnel from the row editor must not fail just because
        // the form (correctly) refuses to echo the password back.
        ssh = mergeSshOptions(ssh || (savedRow ? savedRow.ssh : null), savedRow ? savedRow.ssh : null)
      }
      console.log('[dsh-dbhub-live] ' + currentT('log.testStart', { title: ws.title, env: envName }) + ' (SSH)')
      if (!ssh) {
        report(false, currentT('result.sshTestNoConfig'))
        return
      }
      // Resolve the stored secret reference for this probe (see probeOnce).
      let effectiveSsh
      try {
        effectiveSsh = await resolveEnvSecrets(creds, { dsn: '', ro: false, ssh })
      } catch (e) {
        if (!(e && e.code === 'sshSecretMissing')) throw e
        report(false, currentT('result.sshSecretMissing'))
        return
      }
      const started = Date.now()
      const res = await withProbeTimeout(probeSshTunnel(subprocess, effectiveSsh.ssh, PROBE_TIMEOUT_SSH_MS), PROBE_TIMEOUT_SSH_MS)
      console.log('[dsh-dbhub-live] ' + currentT('log.testProbeMs', { ms: String(Date.now() - started) }))
      // The merge above may have filled the conventional identity path, which the
      // probe can no longer detect on its own — so the note is computed against
      // what the CARD sent (only when it sent a tunnel block at all).
      const note = fromCard ? defaultKeyNoteOf(fromCard, ssh) : ''
      report(res.ok, res.message + note)
      const line = currentT('log.testDone', { title: ws.title, env: envName, result: (res.ok ? 'OK' : 'FAIL') + '(SSH) — ' + res.message + note })
      if (res.ok) console.log('[dsh-dbhub-live] ' + line)
      else console.error('[dsh-dbhub-live] ' + line)
      return
    }
    if (inlineDsn) {
      console.log('[dsh-dbhub-live] ' + currentT('log.testStart', { title: ws.title, env: envName }) + ' (预校验)')
      // The pre-save probe validates the EFFECTIVE options: a saved row's tunnel
      // is probed with the secret the store already holds (the card cannot send
      // it back), exactly like the save it precedes.
      const inlineOptions = probeOptionsOf(savedRow)
      await probeOnce({ dsn: inlineDsn, ro: inlineOptions.ro, ssh: inlineOptions.ssh }, envName, ws.title, '(预校验)')
      return
    }
    console.log('[dsh-dbhub-live] ' + currentT('log.testStart', { title: ws.title, env: envName }))
    // ── F4 fast path: store → already-cached row → (only then) a real walk ──
    const resolveStarted = Date.now()
    const storeRows = listWorkspaceEnvironments(store)
    let picked = resolveTestDsn({
      wsPath: ws.path,
      env: envName,
      storeRows,
      cachedRows: cachedRows(),
      hasCache: hasRowCache(),
    })
    if (!picked) {
      await collectSources(ctx, subprocess)
      // Re-read the store: a card write can land while the walk runs, and the
      // post-walk answer must not be older than the walk itself.
      picked = resolveTestDsn({
        wsPath: ws.path,
        env: envName,
        storeRows: listWorkspaceEnvironments(store),
        cachedRows: cachedRows(),
        hasCache: hasRowCache(),
      })
    }
    console.log('[dsh-dbhub-live] ' + currentT('log.testWalkMs', {
      ms: String(Date.now() - resolveStarted),
      from: picked ? picked.from : 'walk-miss',
    }))
    if (!picked) {
      report(false, currentT('result.testNoRow'))
      console.log('[dsh-dbhub-live] ' + currentT('log.testDone', { title: ws.title, env: envName, result: 'FAIL — ' + currentT('result.testNoRow') }))
      return
    }
    // An unsaved option (or tunnel) the card is validating wins over the stored
    // one; otherwise the row's own options are what execution would use. In both
    // cases a stored secret fills in what the card could not echo back — including
    // the database password, which lives behind `dsnPasswordRef`.
    const probeOptions = probeOptionsOf(savedRow)
    const conn = opHasOptions
      ? { dsn: picked.dsn, ro: probeOptions.ro, ssh: probeOptions.ssh, dsnPasswordRef: picked.dsnPasswordRef }
      : { dsn: picked.dsn, ro: picked.ro, ssh: picked.ssh, dsnPasswordRef: picked.dsnPasswordRef }
    await probeOnce(conn, envName, ws.title, '')
  } catch (e) {
    console.error('[dsh-dbhub-live] 卡片连接测试异常: ' + String((e && e.stack) || e))
    report(false, String((e && e.message) || e))
  }
}

// One card command: { op: 'add'|'set'|'options'|'rename'|'remove', … } or
// { op: 'test', … } (connection probe, zero side effects).
// `publishFast` mirrors a completed write from the cached rows right away; the
// caller publishes the walked result afterwards. Returns the applied patches
// (empty for a probe or a no-op) so the caller can mirror them immediately too.
// `rawOp` is the encoded command the settings-document channel carries and the
// decoded object the HTTP bridge carries.

/**
 * Translate the option fields of one card command into a store patch.
 * `undefined` when the command carries no option information at all — which
 * means "preserve whatever the entry already had" (D4).
 * `ssh: null` is the explicit "clear the tunnel" signal, so it must survive as
 * a defined null rather than being dropped.
 *
 * The per-environment `maxRows` is NOT accepted any more: the row cap became a
 * GLOBAL setting (`options.defaultMaxRows`), and the store field is kept only
 * for backward compatibility (older files, never written by this build). A card
 * still sending `maxRows` here is ignored like any other unknown option field.
 */
function optionsPatchOf(op) {
  const patch = {}
  // Only a real boolean counts: a malformed `readOnly: 'yes'` must be a no-op
  // rather than silently CLEARING a user's safety switch.
  if (op && op.readOnly === true) patch.readOnly = true
  else if (op && op.readOnly === false) patch.readOnly = false
  if (op && op.ssh !== undefined) patch.ssh = op.ssh === null ? null : op.ssh
  return Object.keys(patch).length > 0 ? patch : undefined
}

/** One persisted store row by workspace path × environment (host-side). */
function findRow(wsPath, env) {
  const name = normalizeEnvName(env)
  return listWorkspaceEnvironments(store).find((r) => r.wsPath === wsPath && r.env === name)
}

/**
 * The MIRROR-side version of a row patch: the same mutation, plus the host-side
 * connection data the cached rows need.
 *
 * Patches leave this module in two directions and they must not carry the same
 * payload:
 *   · to the BROWSER (`/op` response) — metadata only, so no `dsn`, no tunnel
 *     block, no secret. The card never reads that body anyway (it re-renders
 *     from the published view), and a response body is exactly where a DSN used
 *     to end up;
 *   · to the row MIRROR (`publishFast`) — host memory only, and it must be able
 *     to summarize the row it just wrote, which means it needs the real DSN.
 * The store is the authority for both: the write has already landed, so the row
 * is read back from `findRow` here instead of travelling in the patch.
 * @param patch - a secret-free row patch.
 * @returns the patch with `dsn` (add/set) and the resolved `ro`/`ssh` filled in.
 */
export function mirrorPatchOf(patch) {
  if (!patch || typeof patch !== 'object') return patch
  if (patch.op !== 'add' && patch.op !== 'set' && patch.op !== 'options') return patch
  const row = findRow(patch.path, patch.env)
  if (!row) return patch
  const next = { ...patch, ro: row.ro === true, ssh: row.ssh || null }
  if (patch.op === 'add' || patch.op === 'set') {
    next.dsn = row.dsn
    // Host-side only: the cached row must be able to resolve the same password
    // reference the store names (the returned patch never carries it).
    if (row.dsnPasswordRef) next.dsnPasswordRef = row.dsnPasswordRef
    else delete next.dsnPasswordRef
  }
  return next
}

/**
 * Apply one options-only card command (the read-only switch and/or the SSH
 * tunnel) and return the mirror patches.
 *
 * The write never touches the DSN — the UI has no connection data to offer when
 * a user flips a checkbox, and demanding one would make them re-type a password.
 * An environment that only AUTO-DISCOVERY knows has no store row to hold the
 * options, so it is promoted to a persisted row from the DSN the walk just
 * resolved (D10) — and strictly on this explicit action (listing, querying and
 * publishing never promote anything).
 *
 * Exported for the unit tests: it is pure with respect to its inputs, takes the
 * auto-discovery lookup as a parameter, and performs no publishing of its own.
 *
 * @param op - `{ env, readOnly?, ssh?, newEnv? }`.
 * @param ws - `{ path, title }` of the already-resolved workspace.
 * @param lookupAuto - `async (envName) => ({ env, dsn } | undefined)`.
 * @param creds - the optional DSH credentials service (`ctx.get('credentials')`),
 *   used to move a newly typed SSH secret out of the connection file.
 * @returns `{ patches, row?, error? }`.
 */
export async function applyOptionsOp(op, ws, lookupAuto, creds) {
  const patches = []
  const patch = optionsPatchOf(op)
  // The raw name is checked BEFORE it is normalized: the store writer only sees
  // the capped form, so a 65-character name would silently address the stored
  // 64-character row and change ITS read-only flag / tunnel. The model path asks
  // the same question with `envNameTruncatesOntoExisting` for the same reason.
  if (envNameTruncatesOntoExisting(ws.path, op.env)) return { patches: [], error: 'envNameTruncated' }
  const requestedName = normalizeEnvName(op.env)
  // "Blank secret = keep the stored value": the card cannot echo a password back,
  // so an edit that only touches the host/user/port arrives without one. Merge
  // with the stored block BEFORE validating, or a legitimate edit would be
  // rejected as an incomplete tunnel. A stored block may carry a credential
  // REFERENCE instead of the value; the merge carries either form through.
  // A non-null `ssh` is a BLOCK to validate — including a falsy one ('') — which
  // the store layer would otherwise reject as `badSsh` AFTER a rename landed.
  // The SSH blocks this command REPLACES are captured BEFORE the write so the
  // references they own can be released afterwards (an explicit `ssh:null` clear
  // orphans them too, so capture happens for every ssh field the command names).
  const beforeSsh = []
  if (patch && patch.ssh !== undefined) {
    const existing = findRow(ws.path, requestedName)
    if (existing && existing.ssh) beforeSsh.push(existing.ssh)
    if (patch.ssh !== null) {
      patch.ssh = mergeSshOptions(patch.ssh, existing ? existing.ssh : null)
      if (!normalizeSshOptions(patch.ssh)) return { patches: [], error: 'badSsh' }
    }
  }
  let envName = requestedName
  // An options write may ALSO rename: one atomic command, so the two changes
  // cannot race on the single `configOp` field. The rename runs first and the
  // options then land on the new name. A BLANK `newEnv` means "no rename" — it
  // must not be normalized to 'default', which would overwrite that row.
  const newEnvRaw = op.newEnv === undefined || op.newEnv === null ? '' : String(op.newEnv)
  // Same raw-name gate for the rename half: `normalizeEnvName` caps the name
  // before `renameWorkspaceEnv` sees it, so the truncation that would land on an
  // existing row has to be refused HERE (a confirmed overwrite must not be able
  // to merge two distinct long names).
  if (newEnvRaw.trim() && envNameTruncatesOntoExisting(ws.path, newEnvRaw)) return { patches: [], error: 'envNameTruncated' }
  const newEnv = newEnvRaw.trim() ? normalizeEnvName(newEnvRaw) : ''
  if (newEnv && newEnv !== requestedName) {
    // A confirmed rename onto an existing environment replaces that row: its SSH
    // block is released too when nothing else uses it.
    const target = newEnv !== requestedName ? findRow(ws.path, newEnv) : null
    if (target && target.ssh) beforeSsh.push(target.ssh)
    const moved = renameWorkspaceEnv(ws.path, requestedName, newEnv, { confirm: op.overwrite === true })
    if (!moved) {
      // Nothing to move: the options still apply to the existing name.
      console.log('[dsh-dbhub-live] ' + currentT('log.opRenameMissing', { title: ws.title, env: requestedName }))
    } else if (moved.renamed !== true && moved.collided === true) {
      // Renaming onto an existing environment REPLACES that connection: refuse
      // until the user confirmed (the card's warning card, or `overwrite:true`).
      return { patches: [], error: 'renameCollided', name: moved.name }
    } else if (moved.renamed === true) {
      envName = moved.name
      patches.push({ op: 'rename', path: ws.path, env: moved.name, from: requestedName })
      console.log('[dsh-dbhub-live] ' + currentT('log.opRenamed', { title: ws.title, from: requestedName, to: moved.name }))
    } else {
      // `collided === false` without a rename means both names normalize to the
      // SAME key: nothing to move, so the options land on it unchanged.
      envName = moved.name
    }
  }
  // A command that carries NO option field has nothing left to write ("no rename"
  // simply falls through the block above with `patches` empty). Writing an empty
  // patch anyway (`setWorkspaceEnvOptions(path, env, {})`) rewrote
  // credentials.json and moved `updatedAt`, so a click that changed nothing looked
  // exactly like an edit — and a redundant payload could push a row's "last
  // changed" stamp past a real one. Zero writes, zero extra patches; a rename that
  // DID land stays in `patches`, so the card still re-renders.
  if (!patch) {
    return { patches, row: findRow(ws.path, envName), noop: true }
  }
  // Only now, with every refusal behind us, does a new plaintext secret move into
  // the DSH credential service: a refused/collided command must not leave an
  // orphan credential behind. The value is stored FIRST; only then may the
  // connection file hold nothing but the reference. A blank field kept the old
  // reference during the merge, so nothing is re-encrypted or unset here.
  // The prepared patch is memoized: the promoted fallback below must not mint a
  // second reference for the same value.
  let prepared
  const readyPatch = async () => {
    if (patch.ssh === undefined || patch.ssh === null) return patch
    if (!prepared) prepared = { ...patch, ssh: await encryptSshSecrets(creds, patch.ssh) }
    return prepared
  }
  let name = findRow(ws.path, envName) ? setWorkspaceEnvOptions(ws.path, envName, await readyPatch()) : undefined
  if (!name) {
    let auto
    try {
      auto = await lookupAuto(envName)
    } catch (e) {
      auto = undefined
    }
    if (!auto) {
      // A rename that already landed is still a real store change: report it
      // rather than dropping the patch (the card would keep showing the old
      // name until some later walk).
      return { patches, error: 'needConnFirst' }
    }
    // The auto-discovered DSN carries the project's password: split it out FIRST
    // (the credential value must be stored before the connection file may name
    // only the reference), exactly like a card write.
    const replacedRow = findRow(ws.path, envName)
    const promotedDsn = await encryptDsnPassword(creds, auto.dsn)
    name = setWorkspaceEnv(ws.path, envName, promotedDsn.dsn, 'promoted', {
      ...(await readyPatch()),
      dsnPasswordRef: promotedDsn.dsnPasswordRef || null,
    })
    await releaseDsnSecret(creds, replacedRow && replacedRow.dsnPasswordRef)
    const promotedRow = findRow(ws.path, name)
    // Metadata only: `mirrorPatchOf` re-reads the DSN from the store for the
    // mirror, so the promoted row's connection never rides the patch itself.
    patches.push({
      op: 'add', path: ws.path, title: ws.title, env: name, source: 'promoted',
      ro: promotedRow ? promotedRow.ro : false,
    })
  }
  const row = findRow(ws.path, name)
  // The write landed: references the replaced/removed block no longer owns can be
  // dropped from the credential store (a ref still shared by another row is kept).
  await releaseSshSecrets(creds, beforeSsh)
  patches.push({
    op: 'options', path: ws.path, env: name,
    ro: row ? row.ro : false,
  })
  const roText = row && row.ro ? 'on' : 'off'
  const sshText = row && row.ssh ? (row.ssh.host + ':' + row.ssh.port) : 'off'
  console.log('[dsh-dbhub-live] ' + currentT('log.opOptions', { title: ws.title, env: name, ro: roText, ssh: sshText }))
  if (row && row.ssh) {
    console.log('[dsh-dbhub-live] ' + currentT('log.sshTunnelUp', { title: ws.title, env: name, host: row.ssh.host, port: String(row.ssh.port), user: row.ssh.user }))
  }
  return { patches, row }
}

/**
 * A card command that was refused or could not be completed. Carries a `code`
 * so the handler can attribute it (an empty DSN is not "unknown workspace"), plus
 * an optional NON-SECRET detail (an environment name) for the message. The
 * offending payload is never attached: it may hold a DSN or an SSH secret.
 */
function opFailure(code, detail) {
  const err = new Error(code)
  err.code = code
  err.detail = detail === undefined || detail === null ? '' : String(detail)
  return err
}

/** The localized, secret-free text of one failed card command. */
function opFailureText(code, detail) {
  if (code === 'emptyDsn') return currentT('result.emptyDsn')
  if (code === 'badSsh') return currentT('result.badSsh')
  if (code === 'needConnFirst') return currentT('result.needConnFirst')
  // A name longer than ENV_NAME_MAX that truncates onto another row: the store
  // refuses the merge, the card names the limit and the consequence.
  if (code === 'envNameTruncated') return currentT('result.envNameTruncated', { max: String(ENV_NAME_MAX) })
  if (code === 'renameCollided') return currentT('result.renameCollided', { to: String(detail || '') })
  if (code === 'renameBlankTarget') return currentT('result.renameBlankTarget')
  // An unattributed failure: the message may quote the payload, so it is scrubbed
  // like every other model/browser-facing text before it is shown.
  return currentT('result.opFailed', { msg: scrubSecrets(String(detail || code || '?'), undefined) })
}

/**
 * Apply one card command ({op:'add'|'set'|'options'|'rename'|'remove'}).
 *
 * Exported for the unit tests (they pass stub channels). Every refusal ends in a
 * user-visible receipt (`reportOpNotice`) — the card has no other way to tell a
 * silently dropped click from a successful write — and the patches that DID land
 * are always published, even when a later step of the same command fails.
 *
 * @param reportTest - `(json) => void` transient test report (probes).
 * @param publishFast - `(patches) => void` immediate mirror of a write.
 * @param reportOpNotice - `(text) => void` transient refusal/failure line.
 */
async function handleConfigOp(rawOp, ctx, subprocess, reportTest, publishFast, reportOpNotice) {
  const patches = []
  const notice = (text) => {
    if (typeof reportOpNotice === 'function') reportOpNotice(String(text || ''))
  }
  let op
  try {
    op = typeof rawOp === 'string' ? JSON.parse(String(rawOp || '')) : rawOp
  } catch (e) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opBad', { raw: scrubSecrets(String(rawOp), undefined) }))
    return patches
  }
  if (!op || typeof op !== 'object') return patches
  const ws = await resolveWorkspaceRef(op.workspace, ctx)
  if (op.op === 'test') {
    // The probe owns its own report; a missing workspace is answered there (the
    // card shows it inline) so a stale selector never looks like a dead button.
    await handleTestOp(op, ctx, subprocess, ws, reportTest)
    return patches
  }
  // A fresh command starts from a clean slate: the previous refusal must not sit
  // on the card while a new write is being applied.
  notice('')
  if (!ws) {
    console.warn('[dsh-dbhub-live] ' + currentT('log.opNoWs', { ws: scrubSecrets(String(op.workspace || ''), undefined) }))
    // The selector arrives from the browser as free text: scrub it like every
    // other browser-visible string, so a pasted DSN cannot leak its password
    // through this notice (only loopback/host metadata may reach the card).
    notice(currentT('result.wsNotFound', { ws: scrubSecrets(String(op.workspace || '-'), undefined) }))
    return patches
  }
  let failed = ''
  // The optional DSH credentials service: SSH secrets are moved out of the
  // connection file through it, and references the write orphans are released
  // afterwards. Resolved per command (a service can appear after this fiber
  // started); never cached.
  const creds = credentialsOf(ctx)
  try {
    if (op.op === 'add' || op.op === 'set') {
      const dsn = typeof op.dsn === 'string' ? op.dsn.trim() : ''
      // An empty DSN is a UI mistake, not an unresolvable workspace: attributed
      // separately so the user is told what to fix.
      if (!dsn) throw opFailure('emptyDsn')
      const renameFrom = typeof op.renameFrom === 'string' && op.renameFrom.trim() ? op.renameFrom.trim() : ''
      const targetEnv = String(op.env == null ? '' : op.env).trim()
      const source = op.source === 'collected' ? 'collected' : 'user'
      // Validate the tunnel BEFORE the rename. This refusal says "nothing was
      // changed", and a rename that had already landed would make that a lie: the
      // row would sit under the new name with no DSN update and the user would be
      // told the click did nothing. The block to merge with is the row this write
      // REPLACES — the one being renamed, or the target name itself.
      const opts = optionsPatchOf(op)
      // Rows whose stored SSH block this write may replace: the renamed row and,
      // when a confirmed rename lands on it, the overwritten target. Their refs are
      // released after the write if nothing else uses them. Captured for EVERY
      // named ssh field — an explicit `ssh:null` clear orphans them as well.
      const beforeSsh = []
      if (opts && opts.ssh !== undefined) {
        for (const name of [renameFrom, targetEnv || op.env]) {
          const candidate = name ? findRow(ws.path, name) : null
          if (candidate && candidate.ssh) beforeSsh.push(candidate.ssh)
        }
        if (opts.ssh !== null) {
          // The card never echoes a stored secret (`connDraftOf` omits it), so an
          // edit that only changes the DSN arrives with a secret-less ssh block.
          // Merging with the stored row keeps a password tunnel and a custom key
          // path instead of dropping the tunnel / resetting the path to the default.
          const storedRow = findRow(ws.path, renameFrom || op.env)
          opts.ssh = mergeSshOptions(opts.ssh, storedRow ? storedRow.ssh : null)
          if (!normalizeSshOptions(opts.ssh)) throw opFailure('badSsh')
        }
      }
      // An edit that also renamed the environment: move the row in place so the
      // new DSN lands on the new name and the old name is not left behind. One op
      // = one namespace command (two would race on the single `configOp` field).
      if (renameFrom && renameFrom !== targetEnv) {
        const moved = renameWorkspaceEnv(ws.path, renameFrom, op.env, { confirm: op.overwrite === true })
        if (!moved) {
          console.log('[dsh-dbhub-live] ' + currentT('log.opRenameMissing', { title: ws.title, env: renameFrom }))
        } else if (moved.renamed !== true && moved.collided === true) {
          // The environment it wanted to land on already exists, and replacing
          // that connection was never confirmed. `collided` (not "did not
          // rename") is the collision signal: a rename onto the row's OWN name
          // reports `{renamed:false, collided:false}` and must not be blamed on
          // a same-named neighbour that does not exist.
          throw opFailure('renameCollided', moved.name)
        } else if (moved.renamed === true) {
          patches.push({ op: 'rename', path: ws.path, env: moved.name, from: renameFrom })
          console.log('[dsh-dbhub-live] ' + currentT('log.opRenamed', { title: ws.title, from: renameFrom, to: moved.name }))
        }
        // Else: the two names normalize to the same key, so there is nothing to
        // move and the write simply continues on that name.
      }
      // Every refusal/rename decision is behind us: move a new plaintext secret
      // into the DSH credential service FIRST, then let the connection file keep
      // only the reference (see config.encryptSshSecrets / encryptDsnPassword).
      if (opts && opts.ssh !== undefined && opts.ssh !== null) {
        opts.ssh = await encryptSshSecrets(creds, opts.ssh)
      }
      // The DSN's password is split out HERE (the store holds no plaintext for a
      // row it owns), after the same point of no return as the tunnel secret.
      const priorRow = findRow(ws.path, op.env)
      const preparedDsn = await encryptDsnPassword(creds, dsn)
      let envName
      try {
        envName = setWorkspaceEnv(ws.path, op.env, preparedDsn.dsn, source, {
          ...opts,
          dsnPasswordRef: preparedDsn.dsnPasswordRef || null,
        })
      } catch (e) {
        // The store write failed after the value was stored: drop the fresh ref so
        // a refused save cannot leave an orphan credential behind.
        await releaseDsnSecret(creds, preparedDsn.dsnPasswordRef)
        throw e
      }
      const row = findRow(ws.path, envName)
      await releaseSshSecrets(creds, beforeSsh)
      // The row this write replaced: its password reference is released when no
      // other row shares it (the live store is re-read inside).
      await releaseDsnSecret(creds, priorRow && priorRow.dsnPasswordRef)
      patches.push({
        op: 'add', path: ws.path, title: ws.title, env: envName, source,
        ro: row ? row.ro : false,
      })
      console.log('[dsh-dbhub-live] ' + currentT('log.opSaved', { title: ws.title, env: envName }))
    } else if (op.op === 'options') {
      const result = await applyOptionsOp(op, ws, async (envName) => {
        const envs = await resolveWorkspaceEnvs(subprocess, ctx.get('fs'), ws.path, undefined)
        return envs.find((r) => r.env === envName)
      }, creds)
      if (result.error) failed = result.error === 'renameCollided'
        ? opFailureText('renameCollided', result.name)
        : opFailureText(result.error)
      patches.push(...result.patches)
    } else if (op.op === 'rename') {
      const from = op.env
      // A BLANK target means "no rename": normalizing it to 'default' would
      // overwrite that row, which is the bug this branch used to have.
      const toRaw = op.newEnv === undefined || op.newEnv === null ? '' : String(op.newEnv)
      if (!toRaw.trim()) throw opFailure('renameBlankTarget')
      const renamed = renameWorkspaceEnv(ws.path, from, toRaw, { confirm: op.overwrite === true })
      if (!renamed) console.log('[dsh-dbhub-live] ' + currentT('log.opRenameMissing', { title: ws.title, env: String(from || 'default') }))
      else if (renamed.renamed !== true && renamed.collided === true) {
        // `collided` is the collision signal — never "did not rename": a rename
        // onto the row's own name reports `{renamed:false, collided:false}`, and
        // reporting that as "the target already exists" blames the row itself.
        throw opFailure('renameCollided', renamed.name)
      } else if (renamed.renamed === true) {
        patches.push({ op: 'rename', path: ws.path, env: renamed.name, from: normalizeEnvName(from) })
        console.log('[dsh-dbhub-live] ' + currentT('log.opRenamed', { title: ws.title, from: String(from || 'default'), to: renamed.name }))
      }
    } else if (op.op === 'remove') {
      // A 65-character name truncates onto the stored 64-character row, so the
      // raw value is checked before the store's capped lookup deletes that OTHER
      // environment (the store gate covers raw callers; this covers the card,
      // which posts the name as typed).
      if (envNameTruncatesOntoExisting(ws.path, op.env)) throw opFailure('envNameTruncated')
      // The removed row's credential references are released AFTER the store no
      // longer names them — a ref another row shares is kept (copyFrom shares it).
      const removedRow = findRow(ws.path, op.env)
      const removed = removeWorkspaceEnv(ws.path, op.env)
      if (!removed) console.log('[dsh-dbhub-live] ' + currentT('log.opNothing', { title: ws.title }))
      else {
        await releaseSshSecrets(creds, removedRow ? removedRow.ssh : null)
        await releaseDsnSecret(creds, removedRow && removedRow.dsnPasswordRef)
        patches.push({ op: 'remove', path: ws.path, env: normalizeEnvName(op.env) })
        console.log('[dsh-dbhub-live] ' + currentT('log.opRemoved', { title: ws.title, env: String(op.env || 'default') }))
      }
    } else {
      console.warn('[dsh-dbhub-live] ' + currentT('log.opUnknown', { op: String(op.op) }))
    }
  } catch (e) {
    // Attributed, never swallowed: the old catch blamed the workspace for every
    // failure and returned [] — which also discarded a rename that had landed.
    const code = e && e.code ? String(e.code) : ''
    const detail = code ? String((e && e.detail) || '') : String((e && e.message) || e)
    failed = opFailureText(code || 'failed', detail)
    console.warn('[dsh-dbhub-live] ' + currentT('log.opFailed', {
      op: String(op.op),
      msg: scrubSecrets(detail || code, undefined),
    }))
  }
  if (failed) notice(failed)
  // Mirror the write IMMEDIATELY from the cached rows (the card shows the result
  // before the caller's discovery walk finishes). The walk itself is the caller's
  // job: it is single-flight, and it re-applies any patch that landed while it was
  // running, so no walk can publish a list without this write. A partial failure
  // still publishes what landed (e.g. a rename that preceded the failing write).
  // `mirrorPatchOf` is what bridges the two audiences: the RETURNED patches stay
  // metadata-only (they are serialized into the `/op` response), while the mirror
  // gets the row's real connection read back from the store.
  if (patches.length > 0) {
    publishFast(patches.map(mirrorPatchOf))
    console.log('[dsh-dbhub-live] ' + currentT('log.syncApplied', { n: activeToolCount() }))
    refreshToolCount()
  }
  return patches
}

// Card commands arrive as an object (the HTTP bridge posts `{ op: <command> }`)
// or as a JSON string (on 0.1.x the settings document carries the single string
// field `configOp`). Normalize both shapes in one place so the early
// `updateCheck` branch in runOp can read the command; anything unparsable falls
// through to handleConfigOp, which owns the "bad op" warning.
function opObjectOf(rawOp) {
  if (rawOp && typeof rawOp === 'object') return rawOp
  if (typeof rawOp !== 'string') return undefined
  try {
    const parsed = JSON.parse(rawOp)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch (e) {
    return undefined
  }
}

// ── live host core: one merged view, one bridge ────────────────────────────
//
// Publishing is channel-independent: the HTTP bridge is the only adapter over
// the walk / row-mirror / command core, and `view()` is the object every bridge
// route carries.
function createHostCore(ctx) {
  // Resolved per call: `subprocess` is an optional service and may arrive after
  // this fiber has started.
  const subprocessOf = () => ctx.get('subprocess')
  // Transient connection-test report (in-memory only): every publish carries
  // the latest one; the card surfaces it only for a nonce it itself dispatched,
  // so a page reload silently drops any stale report.
  let lastTestResult = ''
  // Transient refusal / failure of a card WRITE command (JSON string
  // `{ok:false, message}`; '' when the last command went through). The card has
  // no other way to distinguish "the click was refused" from "it worked" — the
  // browser half does not read op response bodies. It is not a status: the next
  // command clears it, and nothing is persisted.
  let opNotice = ''
  // Upstream dbhub capability probe (JSON string; '' until the background probe
  // finishes). The UI disables the read-only / SSH controls with a reason when
  // the installed dbhub predates the TOML dialect.
  let capabilities = ''
  // The card's own writes are held here until a walk that started after them
  // lands (see createRowMirror): a slow walk that began before a write would
  // otherwise publish a list without it, which reads as "the row appeared and
  // then vanished".
  const mirror = createRowMirror()
  // Version metadata and the plugin self-update checker are Host-lifetime
  // singletons: the installed version cannot change under a running process,
  // and one checker instance is what makes the throttle and the in-flight
  // dedupe work (a per-request instance would hit the registries on every
  // publish). `updateJson` is the browser-facing snapshot — a JSON string, ''
  // until the card asks for its first check, so boot never waits on a network.
  //
  // The supported DSH range is DECLARED in package.json (`engines.dsh`) and
  // enforced by DSH itself; the Host only reports `dshVersion` for display.
  const meta = versionMeta()
  const updateChecker = createUpdateChecker({ currentVersion: meta.pluginVersion })
  let updateJson = ''
  // checkedAt of the snapshot already written to the log: a throttled check
  // just reuses the last result, and logging it again on every page mount would
  // turn the milestone line into noise.
  let lastLoggedCheckAt = -1

  const view = () => ({
    ...state.snapshot(),
    ...options.snapshot(),
    // pluginVersion / dshVersion / runtime — plain strings. The supported DSH
    // range is NOT re-asserted here: it is declared in package.json
    // (`engines.dsh`) and DSH enforces it before the plugin is loaded.
    ...meta,
    workspaces: JSON.stringify(latestSummaries()),
    testResult: lastTestResult,
    opNotice: opNotice,
    capabilities: capabilities,
    update: updateJson,
    // The browser half needs this to address the plugin's own settings form
    // (`ctx.configForms.get(entryId)`) for option writes; '' when the entry
    // cannot be resolved, in which case it falls back to POST /options.
    entryId: entryIdOf(ctx) || '',
  })

  // The bridge is PULL-based: every rendered card GETs `/state`, so a changed
  // view needs no push. This hook exists for the mark-and-poll call sites (and
  // for the 1.5s poll to pick a change up on its next read); there is no sink.
  const publishMirror = () => {}
  // Publish a card write immediately, from the walk result cached in mcp, so
  // the card never waits for the (potentially multi-second, `mise env`-heavy)
  // discovery walk. Skipped before the first walk: an unfinished cache would be
  // published as "no connections at all".
  const publishFast = (patches) => {
    if (!Array.isArray(patches) || patches.length === 0) return false
    if (!hasRowCache()) return false
    try {
      for (const patch of patches) mirror.patch(patch)
      publishMirror()
      return true
    } catch (e) {
      console.warn('[dsh-dbhub-live] 状态快照补丁失败: ' + String((e && e.message) || e))
      return false
    }
  }
  // ONE walk at a time: overlapping walks used to race on the shared row
  // cache, and whichever finished last won — a walk started before a write
  // could therefore overwrite the row that write had just published. Extra
  // requests coalesce into a single follow-up walk.
  let walking = false
  let walkRequested = false
  const runWalk = () => {
    const startedWith = mirror.beginWalk()
    walking = true
    const settle = () => {
      mirror.endWalk(startedWith)
      publishMirror()
    }
    collectSources(ctx, subprocessOf()).then(settle, settle).finally(() => {
      walking = false
      if (walkRequested) {
        walkRequested = false
        runWalk()
      }
    })
  }
  // Every publish re-walks the connection rows, so ANY config change —
  // including one made through dbhub_configure in the chat, which writes the
  // store without touching the state machine — shows up on the card on the next
  // publish (the walk is cheap: registry + env files).
  const publish = () => {
    if (walking) {
      walkRequested = true
      return
    }
    runWalk()
  }
  const reportTest = (reportJson) => {
    lastTestResult = reportJson
    // A probe changes NO rows: mirror it, do not re-walk the workspaces.
    publishMirror()
  }
  /**
   * Record (or clear, with '') the transient refusal of a card write command and
   * republish the cheap mirror. The text is produced host-side and already free
   * of secrets: it is a localized sentence, never an echoed payload.
   */
  const reportOpNotice = (text) => {
    let next = ''
    const message = String(text || '')
    if (message) {
      try {
        next = JSON.stringify({ ok: false, message: message })
      } catch (e) {
        next = ''
      }
    }
    if (next === opNotice) return
    opNotice = next
    publishMirror()
  }
  /** Record the upstream capability probe and republish the (cheap) mirror. */
  const setCapabilities = (cap) => {
    try {
      capabilities = JSON.stringify(cap || {})
    } catch (e) {
      capabilities = ''
    }
    publishMirror()
  }
  /** Capabilities currently advertised to the card (a plain object). */
  const capabilitiesOf = () => {
    try {
      const parsed = JSON.parse(capabilities || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (e) {
      return {}
    }
  }
  // Answer the card's {op:'updateCheck'} command. The checker owns the throttle
  // and the in-flight dedupe, so repeated clicks/reloads cost one request burst;
  // `force` bypasses the throttle (the card's explicit "check now"). The result
  // is mirrored into `update` and published, then logged once — check() resolves
  // on every failure and the guard here only covers a future regression.
  const runUpdateCheck = async (force) => {
    let snap
    try {
      snap = await updateChecker.check(force === true)
    } catch (e) {
      snap = {
        latest: '',
        latestSpec: '',
        hasUpdate: false,
        checkedAt: Date.now(),
        source: '',
        error: String((e && e.message) || e),
      }
    }
    updateJson = JSON.stringify(snap)
    publishMirror()
    // One line per ACTUAL check; a throttled reuse keeps the previous line.
    if (snap.checkedAt === lastLoggedCheckAt) return snap
    lastLoggedCheckAt = snap.checkedAt
    const current = meta.pluginVersion || '?'
    if (snap.error) {
      console.warn('[dsh-dbhub-live] ' + currentT('log.appUpdateFailed', { msg: snap.error, current }))
    } else if (snap.hasUpdate) {
      console.log('[dsh-dbhub-live] ' + currentT('log.appUpdate', { current, latest: snap.latest, source: snap.source }))
    } else {
      console.log('[dsh-dbhub-live] ' + currentT('log.appUpToDate', {
        current,
        latest: snap.latest || '?',
        source: snap.source || '?',
      }))
    }
    return snap
  }
  // One card command, from whichever channel carried it. The caller owns the
  // follow-up republish; a write is already mirrored by publishFast.
  const runOp = async (rawOp) => {
    // `updateCheck` is not a workspace command: no rows change and it touches the
    // network, so it is intercepted BEFORE handleConfigOp (which would reject an
    // unknown op). It still resolves [] — a command that patches no row.
    const command = opObjectOf(rawOp)
    if (command && command.op === 'updateCheck') {
      await runUpdateCheck(command.force === true)
      return []
    }
    const patches = await handleConfigOp(rawOp, ctx, subprocessOf(), reportTest, publishFast, reportOpNotice)
    if (Array.isArray(patches) && patches.length > 0) publish()
    else publishMirror()
    return patches
  }

  return { view, publish, publishMirror, publishFast, reportTest, reportOpNotice, runOp, setCapabilities, capabilitiesOf }
}

// ── the authenticated HTTP bridge ─────────────────────────────────────────
//
// `connection.fetch` inherits Connection's Host/Origin fence and browser
// authentication; a raw `webServer` route would have neither. A host-only
// composition simply never starts this fiber — the tools keep working.
function wireHttpBridge(ctx, core) {
  ctx.inject(['connection'], (sctx) => {
    const face = sctx.connection?.fetch
    if (!face || typeof face.register !== 'function') return
    try {
      const routes = createBridgeRoutes({
        getView: core.view,
        handleOp: core.runOp,
        setEnabled: (value) => {
          state.setEnabled(value)
          core.publish()
        },
        setOptions: (patch) => {
          // A user write claims the field: persist it so the choice survives a
          // restart on a runtime without a settings document. Two kinds of
          // BUSINESS refusals are answered as `{ok:false,error}` (the bridge
          // turns that into a 200 the card can show), never thrown:
          //   · an export directory that cannot be written (`badExportDir`,
          //     message already localized by options.mjs);
          //   · a row cap / concurrency that failed its integer validator
          //     (`badMaxRows` / `badConcurrency`).
          // Every OTHER failure still propagates — a crash must not look like
          // "you typed this wrong". Nothing is written when either refuses:
          // `validatePatch` only inspects, and `applyPatch` validates `exportDir`
          // before it touches a field.
          let changed
          try {
            options.validatePatch(patch)
            changed = options.applyPatch(patch, { persist: true })
          } catch (e) {
            const code = e && e.code
            if (code === 'badExportDir' || code === 'badMaxRows' || code === 'badConcurrency') {
              return { ok: false, error: String((e && e.message) || '') }
            }
            throw e
          }
          if (changed) core.publish()
          else core.publishMirror()
          // Keep the profile patch in step with the page (best effort): the
          // official Plugins form and `dsh --dump-config` must not disagree
          // with what this page just saved.
          void writeOptionsToForm(ctx, patch)
          return { ok: true }
        },
      })
      for (const route of routes) face.register(route)
      console.log('[dsh-dbhub-live] 浏览器桥接已注册: ' + BRIDGE_BASE + '/*')
    } catch (e) {
      console.error('[dsh-dbhub-live] 桥接注册异常: ' + String((e && e.stack) || e))
    }
  })
}

// ── the official settings surface (dsh 0.1.7+/0.2.x) ──────────────────────
//
// Two things ride the settings service on those lines:
//   1. the presentation policy — this plugin ships its own page, so it must
//      switch OFF the auto-generated form for its entry (otherwise the Plugins
//      page renders a second, competing editor);
//   2. the option write-through — a page save also lands in the profile patch,
//      which is the store the standard form reads.
// Both are best effort: a deployment without the settings service (or without
// write access to the profile patch) keeps working off prefs.json.

/** Push one option patch into this entry's Config, when that is possible. */
async function writeOptionsToForm(ctx, patch) {
  const id = entryIdOf(ctx)
  if (!id) return false
  const settings = ctx.get('settings')
  if (!settings || typeof settings.update !== 'function') return false
  const clean = {}
  for (const key of Object.keys(options.snapshot())) {
    if (patch && patch[key] !== undefined) clean[key] = patch[key]
  }
  if (Object.keys(clean).length === 0) return false
  try {
    await settings.update(id, clean)
    return true
  } catch (e) {
    // A read-only deployment (or a profile patch this process may not write)
    // must not break the page: prefs.json already holds the value.
    console.warn('[dsh-dbhub-live] 配置表单写入失败（仅本地 prefs 生效）: ' + String((e && e.message) || e))
    return false
  }
}

function wireSettingsPolicy(ctx) {
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings
    if (!settings || typeof settings.configure !== 'function') return
    try {
      // `auto: false` = "this plugin draws its own page" (the plugins.row.config
      // card, the settings.section page and the sidebar panel all read the same
      // face). Without it the Plugins page also renders a generated form for the
      // same entry. Re-running after an HMR reload throws, hence the guard.
      sctx.effect(() => settings.configure({ auto: false }, ctx.fiber))
      console.log('[dsh-dbhub-live] 配置表单策略已注册: auto=false')
    } catch (e) {
      console.warn('[dsh-dbhub-live] 配置表单策略注册失败: ' + String((e && e.message) || e))
    }
  })
}

// ── background boot ────────────────────────────────────────────────────────

let bootInFlight

// Fire-and-forget one bookkeeping run: mark the plugin 'running' (there is no
// server to start — each tool call spawns its own disposable dbhub), refresh
// the tool count, sweep any generated-config leftovers from a crash, probe the
// upstream dbhub capabilities for the UI, and check for a dbhub auto-update in
// the background (fails silently; the current binary stays in use). Concurrent
// calls share the in-flight run. Failures land in the state machine, never block
// boot.
function startBackgroundBoot(ctx, subprocess, core) {
  if (!state.isEnabled() || !subprocess) return undefined
  if (bootInFlight) return bootInFlight
  bootInFlight = (async () => {
    try {
      state.clearError()
      state.setPhase('running')
      refreshToolCount()
      console.log('[dsh-dbhub-live] ' + currentT('log.loaded', { n: activeToolCount() }))
      // Stale generated TOML files (a crash between write and delete) hold no
      // secrets, but they must not accumulate in the storage dir.
      try {
        const swept = sweepTempToml()
        if (swept > 0) console.log('[dsh-dbhub-live] ' + currentT('log.tomlSwept', { n: String(swept) }))
      } catch (e) {
        /* sweeping is best effort */
      }
      // Capability probe: purely informational (the UI disables what cannot
      // work). Never fatal, and it also resolves/installs the executable early
      // so the first real call does not pay for it.
      resolveDbhubExe(subprocess).then((exe) => {
        const cap = detectDbhubCapabilities(exe)
        if (core && typeof core.setCapabilities === 'function') core.setCapabilities(cap)
        console.log('[dsh-dbhub-live] dbhub 能力探测: version=' + (cap.version || 'unknown')
          + ' readonly=' + (cap.readonlyTools ? 'yes' : 'no')
          + ' ssh=' + (cap.ssh ? 'yes' : 'no')
          + (cap.warning ? ' warning=' + cap.warning : ''))
      }).catch((e) => {
        console.warn('[dsh-dbhub-live] dbhub 能力探测失败: ' + String((e && e.message) || e))
      })
      maybeRefreshDbhub(subprocess).catch((e) => {
        console.error('[dsh-dbhub-live] ' + currentT('log.updateCheckFailed', { msg: String((e && e.message) || e) }))
      })
    } catch (e) {
      state.recordError(String((e && e.message) || e))
      console.error('[dsh-dbhub-live] ' + currentT('log.initFailed') + ': ' + String((e && e.message) || e))
    } finally {
      bootInFlight = undefined
    }
  })()
  return bootInFlight
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  console.log('[dsh-dbhub-live] ' + currentT('log.hostApply'))
  // The pre-4.0 plaintext connection file, if an upgraded profile still has one:
  // nothing reads it, and nothing ever deleted it — so boot removes it (D1) and
  // says so once, without quoting its contents. Runs HERE (not in
  // `startBackgroundBoot`) because that path is skipped for a disabled plugin or
  // a missing subprocess, and a plaintext DSN store is a liability either way.
  try {
    sweepLegacyConfigFile()
  } catch (e) {
    /* sweeping is best effort */
  }
  // Move SSH secrets and database passwords that older builds wrote to
  // credentials.json into the DSH credential service. One-shot and idempotent (a
  // row that already carries the corresponding reference is skipped),
  // fire-and-forget so an unavailable or slow service can never block boot; a
  // failure keeps the plaintext and warns once inside.
  migrateSecrets(credentialsOf(ctx)).catch(() => {
    /* the migration reports its own failures; boot must not see them */
  })
  // Host-side feedback follows the dsh UI language (settings.locale.preference).
  setLocaleProvider(() => {
    try {
      const settings = ctx.get('settings')
      if (!settings) return 'zh'
      const entry = settings.describe().find((d) => d && d.ns === 'locale')
      const preference = entry && entry.value && entry.value.preference
      return preference === 'en' ? 'en' : 'zh'
    } catch (e) {
      return 'zh'
    }
  })
  const subprocess = ctx.get('subprocess')
  registerCoreTools(ctx, subprocess)
  // The system-prompt policy is what keeps database access on these tools (and
  // out of psql/scripts); it is optional by design and contributes nothing
  // while the plugin is disabled. `latestSummaries` is handed in (not imported
  // by policy.mjs) so the policy section can name the `@` catalog without
  // putting `mcp` below `policy` in the dependency graph.
  registerDbhubPolicy(ctx, latestSummaries)
  refreshToolCount()

  // One core, one channel: every state/option change replays the walk, and the
  // walk's result is published on the HTTP bridge.
  const core = createHostCore(ctx)
  ctx.effect(() => {
    const stops = [state.subscribe(core.publish), options.subscribe(core.publish)]
    return () => {
      for (const stop of stops) stop()
    }
  })
  // Config is a write channel, not a second store: whatever it carries — a
  // cordis.yml pin, or a commit from the official Plugins form — is adopted
  // into the effective options and persisted, so the page and the standard form
  // converge on one value instead of drifting apart.
  const adoptConfig = () => {
    const patch = options.configValuesOf(config)
    if (Object.keys(patch).length === 0) return
    try {
      if (options.applyPatch(patch, { persist: true })) core.publish()
    } catch (e) {
      // An export directory pinned by a profile patch is not under the page's
      // control: an unwritable one must not break boot. Keep the current value,
      // warn once (code only — no path) and let exports use the default.
      if (!(e && e.code === 'badExportDir')) throw e
      warnOnce('export-dir-config', currentT('log.exportDirRefused', { code: String(e.detail || 'unknown') }))
    }
  }
  ctx.on('loader/volatile-update', adoptConfig)
  wireSettingsPolicy(ctx)
  wireHttpBridge(ctx, core)
  // Adopt before the first publish, so a pinned value is what the page opens on.
  adoptConfig()
  core.publish()

  if (!subprocess) {
    console.error('[dsh-dbhub-live] subprocess unavailable — 工具已注册；dbhub 首次执行时若有需要会延迟解析（需 subprocess 服务）')
    return
  }
  if (state.isEnabled()) {
    startBackgroundBoot(ctx, subprocess, core).catch(() => {
      /* recorded in state */
    })
  } else {
    console.log('[dsh-dbhub-live] ' + currentT('log.disabledBoot'))
  }
}

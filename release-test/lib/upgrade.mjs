// Cross-version upgrade tier: install an OLD plugin release, give it real data,
// then upgrade in place to the artifact under test and check nothing was lost.
//
// Why this exists: the cold-install tier always starts from an empty home, so it
// can never see the failures users actually hit — an old `credentials.json` /
// `prefs.json` that the new build must adopt, secrets that used to live in the
// connection file and now belong in the DSH credential store, or a profile that
// silently keeps serving the previous client bundle ("the UI is one release
// behind"). Those are upgrade-time regressions, and only an upgrade can find them.
//
// The old build is a REAL published artifact (npm, or a local tarball): the point
// is to migrate data written by code nobody remembers, not by a fixture.
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACTS_DIR, ensureDir, readJson, sleep } from './util.mjs'
import { run } from './proc.mjs'
import { cliEnv, npmInvocation } from './cli-install.mjs'
import { httpGet, httpPost, safeParse } from './probe.mjs'

/** The release most likely still installed in the wild when this repo upgrades. */
export const DEFAULT_BASELINE = '5.2.0'

/** Where downloaded baselines live (inside the ignored work dir, never committed). */
export const BASELINES_DIR = path.join(ARTIFACTS_DIR, 'baselines')

/** The placeholder secret seeded into the old store. Never a real value. */
export const SEED_PASSWORD = 'CHANGE_ME'

/**
 * Does this DSN still carry its password inline? (`scheme://user:pass@host/…`)
 * The new build rewrites such a DSN to `scheme://user@host/…` + a credential
 * reference, so this is the exact shape the upgrade must have removed.
 */
export function dsnHasInlinePassword(dsn) {
  if (typeof dsn !== 'string') return false
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/.test(dsn.trim())
}

/** `''`/undefined/null mean "no secret recorded" for our purposes. */
const present = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Resolve the baseline artifact: a local `.tgz`, or the published tarball for
 * `--baseline <version>` (downloaded once and cached).
 *
 * @returns {Promise<{version: string, name: string, tarball: string, source: 'file'|'npm'}>}
 */
export async function resolveBaseline({ baseline = DEFAULT_BASELINE, tarball = null, logFile } = {}) {
  if (tarball) {
    const absolute = path.resolve(tarball)
    if (!fs.existsSync(absolute)) throw new Error(`baseline tarball not found: ${absolute}`)
    const meta = await readTarballManifest(absolute, logFile)
    return { ...meta, tarball: absolute, source: 'file' }
  }

  const name = readJson(path.join(process.cwd(), 'package.json')).name ?? 'dsh-dbhub-live'
  const dir = ensureDir(BASELINES_DIR)
  const expected = path.join(dir, `${name}-${baseline}.tgz`)
  if (fs.existsSync(expected)) {
    const meta = await readTarballManifest(expected, logFile)
    return { ...meta, tarball: expected, source: 'npm' }
  }

  const { cmd, args } = npmInvocation(['pack', `${name}@${baseline}`, '--pack-destination', dir, '--loglevel=error'])
  const result = await run(cmd, args, {
    cwd: dir,
    env: cliEnv(),
    logFile,
    timeoutMs: 5 * 60_000,
    label: `npm pack ${name}@${baseline}`,
  })
  if (result.code !== 0) {
    throw new Error(`cannot fetch the baseline artifact ${name}@${baseline} (exit ${result.code}); see ${logFile}. ` +
      'Pass --baseline <published version> or --baseline-tarball <file>.')
  }
  const produced = fs.existsSync(expected)
    ? expected
    : fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  if (!produced) throw new Error(`npm pack produced no tarball for ${name}@${baseline}`)
  const meta = await readTarballManifest(produced, logFile)
  return { ...meta, tarball: produced, source: 'npm' }
}

/**
 * Read `package/package.json` out of a tarball without extracting it.
 * Falls back to the file name when tar is unavailable, but a mismatch between the
 * two is NOT silently accepted: the caller asserts the installed version anyway.
 */
async function readTarballManifest(tarball, logFile) {
  const scratchLog = logFile ?? path.join(BASELINES_DIR, 'tar-manifest.log')
  ensureDir(path.dirname(scratchLog))
  const result = await run('tar', ['-xzOf', tarball, 'package/package.json'], {
    logFile: scratchLog,
    timeoutMs: 60_000,
    label: 'tar -xzOf tarball package/package.json',
  })
  if (result.code === 0) {
    try {
      const text = fs.readFileSync(scratchLog, 'utf8')
      const start = text.lastIndexOf('{\n  "name"')
      const end = text.lastIndexOf('}')
      const pkg = JSON.parse(text.slice(start, end + 1))
      if (pkg?.name && pkg?.version) return { name: pkg.name, version: pkg.version }
    } catch {
      // fall through to the file name
    }
  }
  const match = /^(.+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(path.basename(tarball))
  if (!match) throw new Error(`cannot read name/version from ${path.basename(tarball)} — pass a proper npm tarball`)
  return { name: match[1], version: match[2] }
}

/** The `{conn, ro, ssh}` view of a /state row, minus anything unpredictable. */
export function rowSignature(row) {
  return {
    env: row.env,
    path: row.path,
    conn: row.conn,
    ro: row.ro === true,
    ssh: row.ssh
      ? {
        host: row.ssh.host ?? '',
        port: row.ssh.port ?? '',
        user: row.ssh.user ?? '',
        authKind: row.ssh.authKind ?? '',
        hasPassword: row.ssh.hasPassword === true,
        hasPassphrase: row.ssh.hasPassphrase === true,
        proxyJump: row.ssh.proxyJump ?? '',
      }
      : null,
    alias: row.alias ?? '',
    srcId: row.srcId ?? '',
    passwordUnsplit: row.passwordUnsplit === true,
  }
}

/** Parse the /state payload into its rows (the view ships `workspaces` as JSON). */
export function rowsOf(view) {
  if (!view || typeof view !== 'object') return []
  if (Array.isArray(view.workspaces)) return view.workspaces
  const parsed = safeParse(view.workspaces)
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Wait until /state shows at least `expected` rows.
 *
 * The host publishes the view it has CACHED, and the first discovery walk runs
 * asynchronously after boot (a write before that walk cannot patch a cache that
 * does not exist yet — the plugin refuses to publish "no connections at all").
 * Reading /state one tick after the seed therefore sees an empty list on a
 * perfectly good store, so both snapshots must wait for the walk to land. Bounded:
 * an empty list after the timeout is a real answer, not a reason to hang.
 */
export async function waitForRows({ base, cookie, expected, timeoutMs = 45_000, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs
  let rows = []
  for (;;) {
    const state = await httpGet(`${base}/api/dsh-dbhub-live/state`, { cookie })
    rows = rowsOf(safeParse(state.body)?.value)
    if (rows.length >= expected || Date.now() >= deadline) return rows
    await sleep(intervalMs)
  }
}

/**
 * Install real, old-shaped data through the OLD build's own HTTP API.
 *
 * Two connections in the current workspace, one read-only and one behind an SSH
 * tunnel, both with a password INLINE in the DSN — exactly what pre-6.0 builds
 * wrote. Plus two prefs so the settings store is known-populated before the
 * upgrade. Nothing here knows the new build's storage format on purpose: the data
 * must be produced by the baseline, not by the artifact under test.
 */
export async function seedOldData({ base, cookie, logFile }) {
  const mkDsn = (database) => `mysql://ops:${SEED_PASSWORD}@127.0.0.1:1/${database}`
  const ops = [
    // readOnly is spelled both ways on purpose: the field has been `readOnly`
    // through the whole 5.x/6.x line, but an even older card used `ro`, and an
    // unknown field is simply ignored — one seed works for any baseline.
    { op: 'add', env: 'prod', dsn: mkDsn('app'), readOnly: true, ro: true, source: 'user' },
    {
      op: 'add',
      env: 'tunnel',
      dsn: mkDsn('billing'),
      source: 'user',
      ssh: { host: '127.0.0.1', port: 22, user: 'jump', auth: 'password', password: SEED_PASSWORD },
    },
  ]
  const applied = []
  for (const op of ops) {
    const response = await httpPost(`${base}/api/dsh-dbhub-live/op`, { op }, { cookie })
    const json = safeParse(response.body)
    if (response.status !== 200 || !json?.ok) {
      throw new Error(`seed: POST /op add ${op.env} failed (HTTP ${response.status}): ${String(response.body).slice(0, 300)}`)
    }
    applied.push(op.env)
  }

  const options = await httpPost(`${base}/api/dsh-dbhub-live/options`, { updateIntervalDays: 3, showSidebarEntry: false }, { cookie })
  const optionsJson = safeParse(options.body)
  if (options.status !== 200 || !optionsJson?.ok) {
    throw new Error(`seed: POST /options failed (HTTP ${options.status}): ${String(options.body).slice(0, 300)}`)
  }

  // The two writes above are persisted already; this wait is only about the view
  // the host publishes (see waitForRows). Without it the snapshot is empty and
  // every later comparison is vacuous — a green run that migrated nothing.
  const rows = await waitForRows({ base, cookie, expected: ops.length })
  writeSeedLog(logFile, rows)
  if (rows.length < ops.length) {
    throw new Error(`seed: the baseline accepted the writes but /state shows ${rows.length} of ${ops.length} connection(s) after waiting — nothing would be verified`)
  }
  return {
    ops: applied,
    rows: rows.map(rowSignature),
    prefs: { updateIntervalDays: 3, showSidebarEntry: false },
  }
}

/**
 * The store's SHAPE before the upgrade (booleans + reference names only).
 * Recorded as evidence: it is what proves the migration had something to migrate.
 */
export function readStoreShape({ storeFile, envs }) {
  let store = null
  try {
    store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  } catch {
    return { readable: false, rows: {} }
  }
  const workspacePath = Object.keys(store)[0] ?? ''
  return { readable: true, rows: describeStore(store, { workspacePath, envs }) }
}

/** Evidence file for the seed: row signatures only (no DSN, no secret). */
function writeSeedLog(logFile, rows) {
  if (!logFile) return
  ensureDir(path.dirname(logFile))
  fs.writeFileSync(logFile, `${JSON.stringify(rows.map(rowSignature), null, 2)}\n`)
}

/**
 * What the store on disk looks like after the upgrade, described WITHOUT secret
 * values. The credential references are what the migration must have produced;
 * a reference NAME is not a secret (see AGENTS.md), so it may be recorded — the
 * value lives in the DSH credential store and is never read here.
 */
export function describeStore(store, { workspacePath, envs }) {
  const entry = store?.[workspacePath]
  const environments = entry?.environments ?? {}
  const rows = {}
  for (const env of envs) {
    const row = environments[env]
    if (!row) {
      rows[env] = { present: false }
      continue
    }
    rows[env] = {
      present: true,
      dsnHasInlinePassword: dsnHasInlinePassword(row.dsn),
      dsnPasswordRef: present(row.dsnPasswordRef) ? row.dsnPasswordRef : '',
      sshPasswordRef: present(row.ssh?.passwordRef) ? row.ssh.passwordRef : '',
      sshInlinePassword: present(row.ssh?.password),
      hasSsh: !!row.ssh,
      readOnly: row.readOnly === true,
      source: row.source ?? '',
    }
  }
  return rows
}

/** Does the DSH credential store hold a key by this name? Reads keys, never values. */
export function credentialStoreHasKey(text, key) {
  if (!text || !key) return false
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(text)
}

/**
 * Compare the post-upgrade state against what the seed wrote.
 * Pure: every input is already-collected data, so the rules are reviewable.
 * Problems are GROUPED so each one becomes its own check with its own fix.
 *
 * @returns {{ problems: {connections: string[], prefs: string[], bundle: string[], store: string[], probe: string[]}, facts: object }}
 */
export function compareSeeded({ seeded, rows, prefs, installedVersion, expectedVersion, storeShape, credentialText, probeResults, baselineStoreShape }) {
  const problems = { connections: [], prefs: [], bundle: [], store: [], probe: [] }
  const after = rows.map(rowSignature)
  const byEnv = new Map(after.map((row) => [row.env, row]))
  const preserved = {}

  // Nothing seeded = nothing verified. A vacuous pass here would be the worst
  // possible outcome: a green "upgrade" that never carried any data.
  if (!seeded.rows.length) {
    problems.connections.push('the baseline seeded no connections — there is no old data to carry across the upgrade')
  }

  for (const before of seeded.rows) {
    const now = byEnv.get(before.env)
    if (!now) {
      problems.connections.push(`connection "${before.env}" is gone after the upgrade`)
      preserved[before.env] = false
      continue
    }
    const same = now.path === before.path
      && now.conn === before.conn
      && now.ro === before.ro
      && JSON.stringify(now.ssh) === JSON.stringify(before.ssh)
    if (!same) problems.connections.push(`connection "${before.env}" changed: ${JSON.stringify({ before, after: now })}`)
    // The unsplit flag is about the SECRET, not about the row: it belongs to the
    // store group, where "plaintext is acceptable on a host without a credential
    // service" can be judged instead of failing the data-preservation check.
    if (now.passwordUnsplit) {
      problems.store.push(`connection "${before.env}" reports passwordUnsplit (its password is still in the connection file)`)
    }
    preserved[before.env] = same
  }

  const prefsAfter = {}
  for (const [key, value] of Object.entries(seeded.prefs)) {
    const now = prefs?.[key]
    prefsAfter[key] = now
    if (now !== value) problems.prefs.push(`${key} changed across the upgrade: ${JSON.stringify(value)} → ${JSON.stringify(now)}`)
  }
  // Not seeded — it must still be at its default rather than dropped on the floor.
  prefsAfter.announceAccessPolicy = prefs?.announceAccessPolicy
  if (prefs?.announceAccessPolicy !== true) {
    problems.prefs.push(`announceAccessPolicy is ${JSON.stringify(prefs?.announceAccessPolicy)}, expected the default true to survive`)
  }

  if (installedVersion !== expectedVersion) {
    problems.bundle.push(`the profile still runs ${installedVersion} after the upgrade, expected ${expectedVersion} — the old bundle was not replaced`)
  }

  for (const [env, shape] of Object.entries(storeShape ?? {})) {
    if (!shape.present) {
      problems.store.push(`connection "${env}" is missing from the connection store`)
      continue
    }
    const before = baselineStoreShape?.rows?.[env]
    if (shape.dsnHasInlinePassword) {
      // Distinguish "never migrated" from "the value was dropped": the second is
      // unrecoverable, the first is the documented plaintext degradation.
      problems.store.push(`connection "${env}" still stores its database password inline (the secret migration did not run)`)
    } else if (before?.dsnHasInlinePassword && !shape.dsnPasswordRef) {
      problems.store.push(`connection "${env}" lost its database password: the baseline had it inline and the upgraded store has neither the value nor a reference`)
    }
    if (!shape.dsnPasswordRef && before?.dsnPasswordRef) {
      problems.store.push(`connection "${env}" lost the database-password reference it already had`)
    }
    if (shape.dsnPasswordRef && !credentialStoreHasKey(credentialText, shape.dsnPasswordRef)) {
      problems.store.push(`connection "${env}" points at credential "${shape.dsnPasswordRef}" but the DSH credential store has no such key`)
    }
    if (env === 'tunnel') {
      if (shape.sshInlinePassword) problems.store.push('the SSH connection still stores its password inline in the connection store')
      else if (before?.sshInlinePassword && !shape.sshPasswordRef) {
        problems.store.push('the SSH connection lost its password: the baseline had it inline and the upgraded store has neither the value nor a reference')
      }
      if (shape.sshPasswordRef && !credentialStoreHasKey(credentialText, shape.sshPasswordRef)) {
        problems.store.push(`the SSH connection points at credential "${shape.sshPasswordRef}" but the DSH credential store has no such key`)
      }
    }
  }

  for (const [env, result] of Object.entries(probeResults ?? {})) {
    if (!result) continue
    if (result.ok === true) continue
    if (result.unanswered) {
      problems.probe.push(`connection "${env}": ${result.message}`)
      continue
    }
    if (/no longer in the credential store|已不在凭据库/i.test(String(result.message ?? ''))) {
      problems.probe.push(`connection "${env}" can no longer resolve its password after the upgrade: ${String(result.message).slice(0, 160)}`)
    }
  }

  // What the migration actually did, stated explicitly: "2 inline password(s)
  // moved to references" is evidence; a check that passes because the baseline
  // already used references is not, and the reviewer must be able to tell.
  const migration = Object.entries(storeShape ?? {})
    .filter(([, shape]) => shape.present)
    .map(([env, shape]) => ({
      env,
      fromInlinePassword: baselineStoreShape?.rows?.[env]?.dsnHasInlinePassword === true,
      toReference: !!shape.dsnPasswordRef,
      ssh: env === 'tunnel'
        ? {
          fromInlinePassword: baselineStoreShape?.rows?.[env]?.sshInlinePassword === true,
          toReference: !!shape.sshPasswordRef,
        }
        : undefined,
    }))
  const movedCount = migration.filter((entry) => entry.fromInlinePassword && entry.toReference).length
    + migration.filter((entry) => entry.ssh?.fromInlinePassword && entry.ssh?.toReference).length
  const nothingToMigrate = migration.length > 0 && migration.every((entry) => !entry.fromInlinePassword && (!entry.ssh || !entry.ssh.fromInlinePassword))

  return {
    problems,
    facts: {
      preserved,
      prefs: prefsAfter,
      migration,
      migrationNote: movedCount
        ? `${movedCount} inline secret(s) moved into the DSH credential store`
        : nothingToMigrate
          ? 'the baseline already stored credential references — there was no inline secret to migrate'
          : 'no secret migration was observed',
    },
  }
}

/**
 * Boot-log lines that are RED for an upgrade. Deliberately narrow: the boot log
 * carries the plugin's own warnings (Chinese copy included) and a caught failure
 * is not a crash. Only an uncaught stack, an unhandled rejection or a fatal line
 * means "the upgraded build is broken", which is exactly what this tier blocks on.
 */
const HARD_ERROR_RE = /Traceback \(most recent call last\)|UnhandledPromiseRejection|Unhandled 'error' event|Uncaught (?:Exception|Error)|\[fatal\]|^\s*(?:TypeError|ReferenceError|SyntaxError|RangeError|AssertionError): /m
// Known-benign legacy line (0.1.x hosts log a settings-form write failure by design).
const BENIGN_ERROR_RE = /配置表单写入失败（仅本地 prefs 生效）/

export function hardErrorsInBootLog(text) {
  if (!text) return []
  return String(text).split(/\r?\n/)
    .filter((line) => !BENIGN_ERROR_RE.test(line))
    .filter((line) => HARD_ERROR_RE.test(line))
}

const checkOf = (id, status, detail, evidence) => ({ id, status, detail, ...(evidence ? { evidence } : {}) })

/**
 * Can this host use the credential service AT ALL right now?
 *
 * The boot-time migration is fire-and-forget and skips (with one warning) when the
 * service is not there yet; a later write is the same `ctx.get('credentials')`
 * lookup, so writing a throwaway connection and looking at what the store kept
 * separates the two explanations for "the password stayed in the file":
 *   · the host has no usable service      → plaintext is the documented fallback;
 *   · the host has one, the migration ran too early → a real ordering bug.
 * Returns `{ available, detail }`; the throwaway row is removed again.
 */
export async function probeCredentialService({ base, cookie, storeFile, workspacePath }) {
  const env = 'zz-release-probe'
  const probe = await httpPost(`${base}/api/dsh-dbhub-live/op`, {
    op: { op: 'add', env, dsn: `mysql://ops:${SEED_PASSWORD}@127.0.0.1:1/probe`, source: 'user' },
  }, { cookie })
  if (probe.status !== 200 || !safeParse(probe.body)?.ok) {
    return { available: null, detail: `the throwaway credential probe could not be written (HTTP ${probe.status})` }
  }
  const store = readJsonSafe(storeFile)
  const row = store?.[workspacePath]?.environments?.[env]
  const available = !!row?.dsnPasswordRef
  await httpPost(`${base}/api/dsh-dbhub-live/op`, { op: { op: 'remove', env } }, { cookie })
  return {
    available,
    detail: available
      ? 'a connection written after boot stored a credential reference, so the service is usable now (the boot migration may have run before it was available)'
      : 'a connection written after boot kept its password inline, so this host exposes no usable `credentials` service to the plugin',
  }
}

/**
 * The upgrade half of the checks: what survived, what migrated, what the
 * upgraded build serves. `runProbes` answers "does this build work at all";
 * this answers "did the data come with it".
 *
 * @param {{ base: string, cookie: string, home: string, seeded: object, baseline: object,
 *           artifact: object, bootLog: string, storeFile: string, prefsFile: string, credentialFile: string }} ctx
 */
export async function verifyUpgrade(ctx) {
  const { base, cookie, home, seeded, baseline, artifact, bootLog, baselineStoreShape } = ctx
  // Same wait as the seed: the upgraded host re-walks its workspaces, and reading
  // /state one tick after the ready line would compare against an empty view.
  const rows = await waitForRows({ base, cookie, expected: seeded.rows.length })
  const prefs = readJsonSafe(ctx.prefsFile)
  const store = readJsonSafe(ctx.storeFile)
  const credentialText = readTextSafe(ctx.credentialFile)
  const installedVersion = readJsonSafe(path.join(home, 'profiles', 'web', 'node_modules', artifact.name, 'package.json'))?.version ?? ''

  const workspacePath = rows[0]?.path ?? seeded.rows[0]?.path ?? ''
  const storeShape = describeStore(store, { workspacePath, envs: seeded.rows.map((row) => row.env) })

  const probeResults = {}
  for (const [index, row] of seeded.rows.entries()) {
    probeResults[row.env] = await probeConnection({ base, cookie, env: row.env, nonce: `upgrade-${index}-${Date.now()}` })
  }

  // The throwaway write runs AFTER the store snapshot above, so it cannot pollute
  // the before/after comparison; it only answers "is the service usable at all?".
  const serviceProbe = await probeCredentialService({ base, cookie, storeFile: ctx.storeFile, workspacePath })

  const { problems, facts } = compareSeeded({
    seeded,
    rows,
    prefs,
    installedVersion,
    expectedVersion: artifact.version,
    storeShape,
    credentialText,
    probeResults,
    baselineStoreShape,
  })

  const hardErrors = hardErrorsInBootLog(bootLog)
  const probeSummary = Object.fromEntries(Object.entries(probeResults).map(([env, result]) => [
    env,
    {
      ok: result.ok,
      // A connection refusal is the EXPECTED outcome (the seed points at a closed
      // port): what matters is that the host resolved the stored secret and
      // started dbhub instead of answering "re-read your password".
      outcome: result.ok === true ? 'connected' : /no longer in the credential store|已不在凭据库/i.test(result.message) ? 'secret-missing' : 'attempted',
      message: String(result.message ?? '').slice(0, 200),
    },
  ]))

  // A password left in the connection file is only a BUG when this host can use
  // the credential service; when it genuinely has none, plaintext is the
  // documented fallback and the honest verdict is "the migration could not be
  // exercised here" (warn), not a red that blames the plugin for a host gap.
  const plaintextOnly = problems.store.length > 0
    && problems.store.every((problem) => /still stores its .* inline|reports passwordUnsplit/.test(problem))
  const serviceUsable = serviceProbe.available === true
  const credentialBootLines = String(bootLog ?? '').split(/\r?\n/)
    .filter((line) => /凭据服务不可用|credentials service is unavailable/i.test(line))
  const storeEvidence = JSON.stringify({ before: baselineStoreShape, after: storeShape, serviceProbe, credentialBootLines }, null, 2)
  const storeCheck = !problems.store.length
    ? checkOf('upgrade.store-migrated', 'pass', `secrets are references now, not inline values — ${facts.migrationNote}`, JSON.stringify({ before: baselineStoreShape, after: storeShape, migration: facts.migration }, null, 2))
    : plaintextOnly && serviceProbe.available === false
      ? checkOf(
        'upgrade.store-migrated',
        'warn',
        `this host offers no \`credentials\` service to the plugin (${serviceProbe.detail}), so the secret migration could not run: the plaintext layout was kept and warned once, as documented. Re-run on a host whose credential service works to exercise the migration.`,
        storeEvidence,
      )
      : plaintextOnly && serviceProbe.available === null
        ? checkOf('upgrade.store-migrated', 'warn', `the old password(s) stayed in the connection file and the credential service could not be probed (${serviceProbe.detail}) — judge this by hand`, storeEvidence)
        : checkOf(
          'upgrade.store-migrated',
          'fail',
          serviceUsable
            ? `the old plaintext password(s) stayed in the connection file: the plugin saw the credentials service as unavailable when it ran its boot migration, but a connection written afterwards DID get a reference — the migration skipped these rows and nothing retried it in that process, so users get a mixed store plus a \`passwordUnsplit\` marker.${credentialBootLines.length ? ` Boot log: ${credentialBootLines[0].trim().slice(0, 120)}` : ''}`
            : problems.store.join(' | '),
          storeEvidence,
        )

  const checks = [
    problems.connections.length
      ? checkOf('upgrade.connections', 'fail', problems.connections.join(' | '), JSON.stringify({ seeded: seeded.rows, after: rows.map(rowSignature) }, null, 2))
      : checkOf('upgrade.connections', 'pass', `${seeded.rows.length} seeded connection(s) survived with read-only flag and tunnel intact (${seeded.rows.map((r) => r.env).join(', ')})`),
    problems.prefs.length
      ? checkOf('upgrade.prefs', 'fail', problems.prefs.join(' | '), JSON.stringify({ seeded: seeded.prefs, after: prefs }, null, 2))
      : checkOf('upgrade.prefs', 'pass', `preferences kept: ${Object.entries(facts.prefs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`),
    problems.bundle.length
      ? checkOf('upgrade.bundle-version', 'fail', problems.bundle.join(' | '), `installed=${installedVersion} baseline=${baseline.version} artifact=${artifact.version}`)
      : checkOf('upgrade.bundle-version', 'pass', `the profile runs ${installedVersion} (upgraded from ${baseline.version}); no stale bundle left behind`),
    storeCheck,
    problems.probe.length
      ? checkOf('upgrade.secret-resolve', 'fail', problems.probe.join(' | '), JSON.stringify(probeSummary, null, 2))
      : checkOf('upgrade.secret-resolve', 'pass', `stored secrets still resolve for execution (${Object.entries(probeSummary).map(([env, r]) => `${env}: ${r.outcome}`).join(', ')})`),
    hardErrors.length
      ? checkOf('upgrade.boot-log', 'fail', `${hardErrors.length} hard error line(s) in the upgrade boot log`, hardErrors.slice(0, 10).join('\n'))
      : checkOf('upgrade.boot-log', 'pass', 'no uncaught error / unhandled rejection / fatal line in the upgrade boot log'),
  ]

  return {
    checks,
    afterUpgrade: {
      rows: rows.map(rowSignature),
      prefs,
      installedVersion,
      storeShape,
      probes: probeSummary,
      hardErrors,
      migrationNote: facts.migrationNote,
      credentialService: serviceProbe,
    },
    facts,
  }
}

const readJsonSafe = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const readTextSafe = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Probe one connection through the plugin's own test op, which resolves the
 * stored secret exactly like an execution would (a missing reference fails
 * WITHOUT spawning dbhub, so "it tried to connect" is the positive signal).
 */
export async function probeConnection({ base, cookie, env, nonce }) {
  const response = await httpPost(`${base}/api/dsh-dbhub-live/op`, { op: { op: 'test', env, nonce } }, { cookie })
  const view = safeParse(response.body)?.value
  const report = safeParse(view?.testResult)
  if (!report || report.nonce !== nonce) {
    return { ok: false, message: `no test report for "${env}" (HTTP ${response.status})`, unanswered: true }
  }
  return { ok: report.ok === true, message: String(report.message ?? '') }
}

// Matrix loading, validation and expectation derivation.
//
// matrix.json is the single source of truth for "which DSH versions do we claim
// to support". Everything else — the harness, the generated support table, the
// release preflight — derives from it, so the claim cannot drift away from what
// was actually tested.
import path from 'node:path'
import { REPO_ROOT, parseVersion, readJson, sha256Text } from './util.mjs'
import { compareVersions, officialPeerRanges, satisfies, selfTest } from './semver.mjs'

export const MATRIX_FILE = path.join(REPO_ROOT, 'release-test', 'matrix.json')
export const PACKAGE_FILE = path.join(REPO_ROOT, 'package.json')

const TIERS = new Set(['declared', 'advisory'])
const ERAS = new Set(['legacy', 'config-form', 'modern'])
const UIS = new Set(['legacy', 'modern'])
const EXPECTATIONS = new Set(['required', 'optional', 'absent'])

// dshModern gate in lib/meta.mjs: >= 0.2.1, prereleases included.
export const isModernUi = (version) => compareVersions(version, '0.2.1-0') >= 0

export function loadMatrix(file = MATRIX_FILE) {
  const matrix = readJson(file)
  if (matrix.schemaVersion !== 1) throw new Error(`matrix.json: unsupported schemaVersion ${matrix.schemaVersion}`)
  if (!Array.isArray(matrix.targets) || matrix.targets.length === 0) throw new Error('matrix.json: targets must be a non-empty array')
  return matrix
}

export const matrixHash = (matrix) => sha256Text(JSON.stringify(matrix))

/** Structural validation — throws with every problem listed. */
export function validateMatrix(matrix, pkg = readJson(PACKAGE_FILE)) {
  const problems = []
  const seen = new Set()
  for (const [index, target] of matrix.targets.entries()) {
    const at = `targets[${index}]`
    if (!target.version || !parseVersion(target.version)) problems.push(`${at}: missing/invalid version`)
    else {
      if (seen.has(target.version)) problems.push(`${at}: duplicate version ${target.version}`)
      seen.add(target.version)
    }
    if (!TIERS.has(target.tier)) problems.push(`${at}: tier must be one of ${[...TIERS].join(', ')}`)
    if (!ERAS.has(target.era)) problems.push(`${at}: era must be one of ${[...ERAS].join(', ')}`)
    if (!UIS.has(target.ui)) problems.push(`${at}: ui must be one of ${[...UIS].join(', ')}`)
    if (!target.why) problems.push(`${at}: "why" must say where the claim comes from (README / package.json / dist-tag)`)
    for (const [key, value] of Object.entries(target.expect ?? {})) {
      if (!EXPECTATIONS.has(value)) problems.push(`${at}.expect.${key}: must be one of ${[...EXPECTATIONS].join(', ')}`)
    }
    // ui must agree with the plugin's own dshModern gate
    if (target.version && target.ui && UIS.has(target.ui)) {
      const expected = isModernUi(target.version) ? 'modern' : 'legacy'
      if (target.ui !== expected) problems.push(`${at}: ui must be "${expected}" for ${target.version} (lib/meta.mjs dshModern gate)`)
    }
    // a declared target must state what it expects from each host channel
    if (target.tier === 'declared') {
      for (const key of ['bridge', 'settingsNamespace', 'configForm']) {
        if (!target.expect?.[key]) problems.push(`${at}: declared target must declare expect.${key}`)
      }
    }
  }

  const semverFailures = selfTest()
  if (semverFailures.length) problems.push(`semver self-test failed: ${semverFailures.join('; ')}`)

  if (problems.length) {
    const error = new Error(`matrix validation failed:\n - ${problems.join('\n - ')}`)
    error.problems = problems
    throw error
  }
  return matrix
}

/**
 * Claim drift: the matrix says we support X, the manifest says something else.
 *
 * These are WARNINGS at run time — you can still test while a claim is being
 * fixed — but the release preflight treats them as blocking, because shipping a
 * claim that the peer ranges contradict is exactly the "declared a version that
 * cannot install" failure this whole system exists to prevent.
 */
export function matrixClaimWarnings(matrix, pkg = readJson(PACKAGE_FILE)) {
  const warnings = []
  const inMatrix = new Set(matrix.targets.map((t) => t.version))

  for (const version of Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})) {
    if (!inMatrix.has(version)) {
      warnings.push({
        id: `claim:compat-missing:${version}`,
        detail: `package.json dsh.compatibility.dshReleases advertises ${version}, but matrix.json has no such target — test it or drop the claim`,
      })
    }
  }
  for (const target of matrix.targets) {
    if (!target.version) continue
    // Only the harness-versioned packages matter here. @deepseek-ai/cordis and
    // @deepseek-ai/schemastery are library versions unrelated to a DSH release,
    // and comparing a DSH version against them would report noise as failure.
    const failing = []
    for (const [name, range] of officialPeerRanges(pkg)) {
      if (!/^@deepseek-ai\/dsh-/.test(name)) continue
      let satisfied
      try {
        satisfied = satisfies(target.version, range)
      } catch (error) {
        warnings.push({ id: `claim:peer-unparseable:${target.version}`, detail: `${target.version}: cannot evaluate ${name}@${range} — ${error.message}` })
        continue
      }
      if (!satisfied) failing.push(`${name}@${range}`)
    }
    if (failing.length) {
      warnings.push({
        id: `claim:peer-excludes:${target.version}`,
        detail:
          `${target.version} is declared supported but does NOT satisfy ${failing.join(' and ')} — ` +
          'installing this plugin on that harness fails with ERESOLVE; fix the range or drop the claim',
      })
    }
  }
  return warnings
}

/** Resolve which targets to run: --only wins, then --tier, else all. */
export function selectTargets(matrix, { only = [], tier = null } = {}) {
  let targets = matrix.targets
  if (tier && tier !== 'all') {
    const accepted = tier === 'declared' ? ['declared'] : [tier]
    targets = targets.filter((t) => accepted.includes(t.tier))
  }
  if (only.length) {
    const wanted = new Set(only)
    const missing = only.filter((v) => !matrix.targets.some((t) => t.version === v))
    if (missing.length) throw new Error(`unknown target version(s): ${missing.join(', ')} (see release-test/matrix.json)`)
    targets = targets.filter((t) => wanted.has(t.version))
  }
  if (!targets.length) throw new Error('no targets selected')
  return targets
}

/**
 * Log channels are named by behavior, not by line text, so wording changes in
 * the plugin do not silently weaken the test: if the line regex stops matching,
 * the check fails and someone updates the plugin or the harness deliberately.
 */
export const LOG_CHANNELS = {
  apply: { label: 'host apply', re: /\[dsh-dbhub-live\]\s+host apply/ },
  tools: { label: '4 tools registered', re: /\[dsh-dbhub-live\].*?(\d+)\s*个工具/ },
  settingsNamespace: { label: 'legacy settings namespace registered', re: /状态命名空间已注册|settings 命名空间已注册/ },
  configForm: { label: 'config-form policy registered', re: /配置表单策略已注册/ },
  bridge: { label: 'HTTP bridge registered', re: /浏览器桥接已注册/ },
  capability: { label: 'dbhub capability probe', re: /dbhub 能力探测[:：]\s*version=([^\s]+)/ },
  accessPolicy: { label: 'model access policy prompt section', re: /模型侧访问策略已注册/ },
}

export function expectationsFor(target) {
  const expect = target.expect ?? {}
  return {
    bridge: expect.bridge ?? (target.era === 'legacy' ? 'optional' : 'required'),
    settingsNamespace: expect.settingsNamespace ?? (target.era === 'legacy' ? 'optional' : 'absent'),
    configForm: expect.configForm ?? (target.era === 'legacy' ? 'absent' : 'required'),
  }
}

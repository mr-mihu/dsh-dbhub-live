// Pinned CLI provisioning: one throwaway @deepseek-ai/dsh install per version.
//
// Why not the user's installed `dsh`? Because a release test must not be able to
// pass by testing the wrong harness. Each target gets its own npm prefix under
// .release-test/cache/tools, pinned to the exact version in matrix.json.
import fs from 'node:fs'
import path from 'node:path'
import { TOOLS_DIR, NPM_CACHE, ensureDir, isWindows, readJson, writeJson } from './util.mjs'
import { run } from './proc.mjs'
import { compareVersions, satisfies } from './semver.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
export const markerFile = (version) => path.join(TOOLS_DIR, `dsh-${version}`, '.installed.json')
export const binPath = (version) => path.join(TOOLS_DIR, `dsh-${version}`, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

export function cliEnv(extra = {}) {
  ensureDir(NPM_CACHE)
  return {
    ...process.env,
    // Keep every npm/pnpm cache inside the workspace: sandboxed shells cannot
    // write to the real user cache, and CI benefits from a local cache too.
    npm_config_cache: NPM_CACHE,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...extra,
  }
}

export function installedVersion(version) {
  const marker = markerFile(version)
  if (!fs.existsSync(marker)) return null
  try {
    const meta = readJson(marker)
    return meta.version === version && fs.existsSync(binPath(version)) ? meta : null
  } catch {
    return null
  }
}

/**
 * Install the pinned CLI unless a valid marker already exists.
 * --ignore-scripts is deliberate: the CLI's dependency tree contains install
 * scripts, and a release test has no business running arbitrary postinstall
 * hooks; the parts of the CLI we exercise (profile boot, plugin mounting, web
 * server) do not need them. Pass --with-scripts to opt in.
 */
export async function ensureCli(version, { logFile, force = false, withScripts = false } = {}) {
  const existing = installedVersion(version)
  if (existing && !force) return { version, reused: true, dir: path.dirname(markerFile(version)), ...existing }

  const dir = ensureDir(path.join(TOOLS_DIR, `dsh-${version}`))
  writeJson(path.join(dir, 'package.json'), { name: 'dsh-cli-pin', private: true, description: `pinned @deepseek-ai/dsh@${version} for release-test` })

  const args = ['install', `${DSH_PACKAGE}@${version}`, '--no-audit', '--no-fund', '--loglevel=error']
  if (!withScripts) args.push('--ignore-scripts')

  const invocation = npmInvocation(args)
  const result = await run(invocation.cmd, invocation.args, {
    cwd: dir,
    env: cliEnv(),
    logFile,
    timeoutMs: 20 * 60_000,
    label: `npm install ${DSH_PACKAGE}@${version}`,
  })
  if (result.code !== 0) {
    throw new Error(`pinned CLI install failed for ${version} (exit ${result.code}); see ${logFile}`)
  }
  if (!fs.existsSync(binPath(version))) throw new Error(`pinned CLI installed but ${binPath(version)} is missing`)

  // Record the resolved version so a re-run can trust the cache.
  const pkg = readJson(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (pkg.version !== version) {
    throw new Error(`pinned CLI resolved ${pkg.version}, expected ${version}`)
  }
  const meta = { version, installedAt: new Date().toISOString(), dir }
  writeJson(markerFile(version), meta)
  return { version, reused: false, dir, ...meta }
}

/** Locate npm-cli.js so npm can be spawned through node, avoiding Windows .cmd
 *  shims (Node refuses to spawn those without a shell) and pipe limitations. */
export function findNpmCli() {
  const candidates = []
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath)
  const nodeDir = path.dirname(process.execPath)
  candidates.push(
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  )
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {}
  }
  return null
}

/** `npm` must be spawned through node's npm-cli.js when possible: .cmd shims are
 *  rejected by Node's spawn on Windows unless a shell is involved. */
export function npmInvocation(args) {
  const cli = findNpmCli()
  if (cli) return { cmd: process.execPath, args: [cli, ...args], viaCli: true }
  if (isWindows) return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args], viaCli: false }
  return { cmd: 'npm', args, viaCli: false }
}

/** Does this version even exist on the registry? Cheap pre-flight check. */
export async function assertPublished(version, { logFile, registry } = {}) {
  const { cmd, args } = npmInvocation(['view', `${DSH_PACKAGE}@${version}`, 'version', ...(registry ? [`--registry=${registry}`] : [])])
  const result = await run(cmd, args, { env: cliEnv(), logFile, timeoutMs: 120_000, label: `npm view ${DSH_PACKAGE}@${version}` })
  if (result.code !== 0) throw new Error(`@deepseek-ai/dsh@${version} not found on the registry`)
  return true
}

/** Current dist-tags, for the "is the matrix still current?" drift report. */
export async function distTags({ logFile } = {}) {
  const { cmd, args } = npmInvocation(['view', DSH_PACKAGE, 'dist-tags', '--json'])
  const file = logFile.replace(/\.log$/, '.stdout.json')
  const result = await run(cmd, args, { env: cliEnv(), logFile: file, timeoutMs: 120_000, label: 'npm view dist-tags' })
  if (result.code !== 0) return null
  try {
    // npm writes the JSON body into the log after our framing; keep the last object.
    const text = fs.readFileSync(file, 'utf8')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export { satisfies, compareVersions }

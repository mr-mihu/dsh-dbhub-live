// Isolated DSH home per target, plus plugin provisioning into its web profile.
//
// Isolation is the whole point: a release test must never be able to touch the
// developer's real profile (the harness is fail-loud, so a bad plugin kills the
// GUI, not just a test). Every target gets .release-test/homes/dsh-<version>.
import fs from 'node:fs'
import path from 'node:path'
import { HOMES_DIR, NPM_CACHE, PNPM_STORE, REPO_ROOT, ensureDir, readJson, writeJson } from './util.mjs'
import { run } from './proc.mjs'
import { binPath, cliEnv } from './cli-install.mjs'
import { cliInvocation } from './cli-source.mjs'

export const homeDir = (version) => path.join(HOMES_DIR, `dsh-${version}`)
export const webProfileDir = (version) => path.join(homeDir(version), 'profiles', 'web')
/**
 * cwd for every dsh invocation.
 *
 * Deliberately NOT the repo root: dsh layers `<cwd>/.env` into the process env,
 * and this repo keeps a local, gitignored `.env` with a DSH_* variable for the
 * desensitization gate. dsh refuses DSH_* from a .env file (it is
 * environment-owned), so booting from the repo root would fail for a reason that
 * has nothing to do with the plugin under test. A neutral workspace also mirrors
 * a user session more closely.
 */
export const workspaceDir = (version) => path.join(homeDir(version), 'workspace')

/** Env for every dsh invocation: isolated home, no inherited profile selection. */
export function dshEnv(version, extra = {}) {
  const env = {
    ...process.env,
    DSH_HOME: homeDir(version),
    npm_config_cache: NPM_CACHE,
    npm_config_store_dir: PNPM_STORE,
    ...extra,
  }
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  delete env.DSH_SNAPSHOT
  return env
}

export function prepareHome(version, { clean = true } = {}) {
  const dir = homeDir(version)
  if (clean && fs.existsSync(dir)) {
    try {
      // maxRetries absorbs the transient Windows lock right after a killed run.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    } catch (error) {
      throw new Error(
        `cannot clear ${dir} (${error.code ?? error.message}). A leftover dsh web process is probably still running with this ` +
        `directory as its cwd; close it (or kill the stale node process) and rerun.`,
      )
    }
  }
  ensureDir(dir)
  ensureDir(workspaceDir(version))
  return dir
}

/**
 * Materialize the web profile without starting a server.
 * `--dump-config` composes the profile (creating profiles/web from the shipped
 * template) and exits — much faster and quieter than booting to get the same
 * directory. Returns the profile dir.
 */
export async function createProfile(version, { logFile, cli } = {}) {
  const invocation = cliInvocation(cli, ['--profile', 'web', '--dump-config'])
  const result = await run(invocation.cmd, invocation.args, {
    cwd: workspaceDir(version),
    env: dshEnv(version),
    logFile,
    timeoutMs: 180_000,
    label: `dsh@${version} --profile web --dump-config`,
  })
  if (result.code !== 0) throw new Error(`profile creation failed for ${version} (exit ${result.code}); see ${logFile}`)
  const dir = webProfileDir(version)
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`profile created but ${path.join(dir, 'package.json')} is missing`)
  }
  return dir
}

function patchProfileManifest(profileDir, { name, version }) {
  const file = path.join(profileDir, 'package.json')
  const pkg = readJson(file)
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: version }
  const bundles = pkg.dsh?.profile?.bundles ?? []
  if (!bundles.includes(name)) {
    pkg.dsh = pkg.dsh ?? {}
    pkg.dsh.profile = pkg.dsh.profile ?? {}
    pkg.dsh.profile.bundles = [...bundles, name]
  }
  writeJson(file, pkg)
}

/** Extract the plugin tarball straight into the profile's node_modules. */
async function provisionManual({ version, tarball, logFile, pluginName }) {
  const dest = path.join(webProfileDir(version), 'node_modules', pluginName)
  fs.rmSync(dest, { recursive: true, force: true })
  ensureDir(dest)
  const result = await run('tar', ['-xzf', tarball, '-C', dest, '--strip-components=1'], {
    env: process.env,
    logFile,
    timeoutMs: 120_000,
    label: 'tar -xzf plugin.tgz',
  })
  if (result.code !== 0) throw new Error(`failed to extract plugin tarball (exit ${result.code}); see ${logFile}`)
  const installed = readJson(path.join(dest, 'package.json'))
  patchProfileManifest(webProfileDir(version), { name: installed.name, version: installed.version })
  return installed
}

/**
 * Provision the plugin into the profile.
 * mode:
 *   auto   — try the real `dsh plugin add` path first, fall back to manual
 *            (sandboxes and offline machines cannot run pnpm reliably)
 *   cli    — require the real install path: this is what users do
 *   manual — deterministic file copy; verifies the artifact content only
 */
export async function provisionPlugin({ version, tarball, pluginName, mode = 'auto', logFile, cli }) {
  const notes = []
  if (mode === 'cli' || mode === 'auto') {
    const spec = tarball
    const invocation = cliInvocation(cli, ['plugin', '--profile', 'web', 'add', spec, '--store-dir', PNPM_STORE])
    const result = await run(invocation.cmd, invocation.args, {
      cwd: workspaceDir(version),
      env: dshEnv(version, { npm_config_store_dir: PNPM_STORE }),
      logFile,
      timeoutMs: 10 * 60_000,
      label: `dsh@${version} plugin add <tarball>`,
    })
    if (result.code === 0) {
      const installed = readJson(path.join(webProfileDir(version), 'node_modules', pluginName, 'package.json'))
      return { mode: 'cli', installed, notes }
    }
    if (mode === 'cli') {
      throw new Error(`dsh plugin add failed for ${version} (exit ${result.code}); see ${logFile}`)
    }
    notes.push('dsh plugin add failed (usually pnpm sandbox limits) — fell back to manual provisioning; the real install path was NOT exercised for this target')
  }
  const installed = await provisionManual({ version, tarball, logFile, pluginName })
  return { mode: 'manual', installed, notes }
}

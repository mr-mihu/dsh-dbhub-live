// Build the artifact under test. The release test must exercise what users
// install, not the working tree: we run `npm pack` and test the tarball.
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACTS_DIR, REPO_ROOT, ensureDir, readJson, sha256 } from './util.mjs'
import { run } from './proc.mjs'
import { cliEnv, npmInvocation } from './cli-install.mjs'

export const packageMeta = () => {
  const pkg = readJson(path.join(REPO_ROOT, 'package.json'))
  return {
    name: pkg.name,
    version: pkg.version,
    compatibility: pkg.dsh?.compatibility?.dshReleases ?? {},
    peerDependencies: pkg.peerDependencies ?? {},
  }
}

/**
 * npm pack the repo into .release-test/cache/artifacts and return its metadata.
 * `npm pack` runs prepack/prepare but NOT prepublishOnly, so this mirrors what a
 * user downloads from npm or a GitHub release.
 */
export async function packPlugin({ logFile, force = false } = {}) {
  const pkg = packageMeta()
  const dir = ensureDir(ARTIFACTS_DIR)
  const expected = path.join(dir, `${pkg.name}-${pkg.version}.tgz`)
  if (fs.existsSync(expected) && !force) {
    return { ...pkg, tarball: expected, size: fs.statSync(expected).size, sha256: sha256(expected), reused: true }
  }
  const args = ['pack', '--pack-destination', dir, '--loglevel=error']
  const { cmd, args: fullArgs } = npmInvocation(args)
  const result = await run(cmd, fullArgs, {
    cwd: REPO_ROOT,
    env: cliEnv(),
    logFile,
    timeoutMs: 5 * 60_000,
    label: 'npm pack',
  })
  if (result.code !== 0) throw new Error(`npm pack failed (exit ${result.code}); see ${logFile}`)
  if (!fs.existsSync(expected)) {
    // Fall back to the newest tarball in the destination, so a renamed package
    // does not fail confusingly.
    const candidates = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => path.join(dir, f))
    if (!candidates.length) throw new Error(`npm pack produced no tarball in ${dir}`)
    const newest = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    return { ...pkg, tarball: newest, size: fs.statSync(newest).size, sha256: sha256(newest), reused: false }
  }
  return { ...pkg, tarball: expected, size: fs.statSync(expected).size, sha256: sha256(expected), reused: false }
}

/** Use an existing tarball (e.g. the GitHub release asset) instead of packing. */
export function useTarball(file) {
  const absolute = path.resolve(file)
  if (!fs.existsSync(absolute)) throw new Error(`tarball not found: ${absolute}`)
  const pkg = packageMeta()
  return { ...pkg, tarball: absolute, size: fs.statSync(absolute).size, sha256: sha256(absolute), reused: true }
}

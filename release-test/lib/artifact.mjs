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

/**
 * Read the plugin's OWN `package.json` out of a tarball, without extracting it.
 *
 * A tarball must describe itself. Taking the version from the working tree (as
 * `useTarball` used to) labels a stale artifact with the current version, which is
 * how "we tested rc.8" can actually mean "we tested rc.7 twice".
 */
export async function readTarballPackage(tarball, { logFile } = {}) {
  const scratch = logFile ?? path.join(ARTIFACTS_DIR, `tar-read-${Date.now()}.log`)
  ensureDir(path.dirname(scratch))
  const result = await run('tar', ['-xzOf', tarball, 'package/package.json'], {
    logFile: scratch,
    timeoutMs: 60_000,
    label: 'tar -xzOf tarball package/package.json',
  })
  if (result.code !== 0) return null
  try {
    // The log carries our framing plus the JSON body: the first `{` … last `}`.
    const text = fs.readFileSync(scratch, 'utf8')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Use an existing tarball (e.g. the GitHub release asset) instead of packing.
 * Returns the tarball's REAL metadata; the repo manifest is only a fallback.
 */
export async function useTarball(file, { logFile } = {}) {
  const absolute = path.resolve(file)
  if (!fs.existsSync(absolute)) throw new Error(`tarball not found: ${absolute}`)
  const manifest = await readTarballPackage(absolute, { logFile })
  const pkg = packageMeta()
  return {
    name: manifest?.name ?? pkg.name,
    version: manifest?.version ?? pkg.version,
    compatibility: manifest?.dsh?.compatibility?.dshReleases ?? pkg.compatibility,
    peerDependencies: manifest?.peerDependencies ?? pkg.peerDependencies,
    tarball: absolute,
    size: fs.statSync(absolute).size,
    sha256: sha256(absolute),
    reused: true,
    // Callers compare this with package.json: a mismatch means the artifact is not
    // the commit under test, which the report must say out loud.
    manifestRead: !!manifest?.version,
  }
}

// Host patches for SANDBOX-ONLY limitations.
//
// These are never needed on a normal machine or in CI. They exist because this
// Windows sandbox cannot expose directory junctions to Node: lstatSync() reports
// isSymbolicLink() === false, so dsh-app-boot's module-fallback healer sees the
// junctions it wrote on the previous launch as "not a symlink" and aborts:
//   "dsh: <home>/profiles/node_modules/@deepseek-ai/dsh exists and is not a
//    symlink or dsh-managed module proxy"
// and, because the fallback closure walks dependencies+peerDependencies only,
// optional platform packages (koffi/sharp native binaries) are left out and the
// plugin tree fails to load with "Cannot find the native Koffi module".
//
// Two surgical edits in the CACHED CLI copy (never the user's install):
//   1. profileDependencyNames(): also walk optionalDependencies.
//   2. ensureSymlink(): accept an already-present directory.
//
// Both are resolved-path-neutral and do not touch plugin loading, the HTTP
// surface or the profile tree. The report records that a target needed it.
import fs from 'node:fs'
import path from 'node:path'

const DEP_OLD = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];'
const DEP_NEW = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]; /* SANDBOX-PATCH optional platform packages */'
const SYM_OLD = 'if (!stat.isSymbolicLink()) {\n\t\t\tif ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error('
const SYM_NEW = 'if (!stat.isSymbolicLink()) {\n\t\t\t/* SANDBOX-PATCH: junctions are opaque to lstat here; accept an existing directory */\n\t\t\tif (stat.isDirectory()) return;\n\t\t\tif ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error('

/**
 * Apply the sandbox host patch to a cached CLI install.
 * Idempotent. Returns { applied, alreadyPatched, edits, warnings }.
 */
export function applySandboxHostPatch(toolDir) {
  const file = path.join(toolDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  const result = { file, applied: false, alreadyPatched: false, edits: 0, warnings: [] }
  if (!fs.existsSync(file)) {
    result.warnings.push(`no dsh-app-boot in ${toolDir} — nothing to patch`)
    return result
  }
  let src = fs.readFileSync(file, 'utf8')
  if (src.includes('SANDBOX-PATCH')) {
    result.alreadyPatched = true
    return result
  }
  if (src.includes(DEP_OLD)) {
    src = src.replace(DEP_OLD, DEP_NEW)
    result.edits += 1
  } else {
    result.warnings.push('optionalDependencies pattern not found (CLI layout changed?)')
  }
  if (src.includes(SYM_OLD)) {
    src = src.replace(SYM_OLD, SYM_NEW)
    result.edits += 1
  } else {
    result.warnings.push('ensureSymlink pattern not found (CLI layout changed?)')
  }
  if (result.edits > 0) {
    fs.writeFileSync(file, src, 'utf8')
    result.applied = true
  }
  return result
}

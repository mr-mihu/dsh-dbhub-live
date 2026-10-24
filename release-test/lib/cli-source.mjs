// Where does the pinned DSH CLI for a target come from?
//
// Two sources, same probes:
//   mise — the version was pre-installed once (`mise -C release-test install`)
//          and is run on demand: `mise x npm:@deepseek-ai/dsh@<ver> -- dsh …`.
//          Nothing is installed during a test run; versions live in mise's data
//          dir and can coexist without being "activated".
//   npm  — fallback for machines without mise (or CI before the mise step):
//          one throwaway install per version under .release-test/cache/tools.
//
// `auto` prefers mise and only falls back when the version is genuinely absent,
// recording that in the report so a reviewer can see which path was exercised.
import { run } from './proc.mjs'
import { ensureCli, binPath } from './cli-install.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
export const MISE_TOOL = `npm:${DSH_PACKAGE}`

export const miseExe = () => process.env.MISE_EXE || 'mise'

/** Command + args prefix that runs this target's dsh with the given dsh args. */
export function cliInvocation(cli, extraArgs) {
  if (cli.kind === 'mise') {
    return { cmd: cli.misePath, args: ['x', `${MISE_TOOL}@${cli.version}`, '--', 'dsh', ...extraArgs] }
  }
  return { cmd: process.execPath, args: [binPath(cli.version), ...extraArgs] }
}

async function detectMise(logFile) {
  const result = await run(miseExe(), ['--version'], { logFile, timeoutMs: 30_000, label: 'mise --version' })
  if (result.code !== 0) return null
  return miseExe()
}

async function miseHasVersion(version, logFile) {
  const result = await run(miseExe(), ['where', `${MISE_TOOL}@${version}`], {
    logFile,
    timeoutMs: 60_000,
    label: `mise where ${MISE_TOOL}@${version}`,
  })
  return result.code === 0
}

/**
 * Resolve the CLI for a target.
 * @returns {{kind:'mise'|'npm', version:string, misePath?:string, dir?:string, notes:string[]}}
 */
export async function resolveCli(version, { source = 'auto', logFile, force = false, skipInstall = false } = {}) {
  const notes = []
  if (source !== 'npm') {
    const misePath = await detectMise(logFile)
    if (misePath) {
      if (await miseHasVersion(version, logFile)) {
        return { kind: 'mise', version, misePath, notes }
      }
      if (source === 'mise') {
        throw new Error(
          `mise does not have ${MISE_TOOL}@${version} installed. Pre-install it once:  mise -C release-test install  ` +
          `(or: mise install ${MISE_TOOL}@${version})  — or run with --cli-source npm.`,
        )
      }
      notes.push(`mise found but ${version} is not pre-installed — fell back to a throwaway npm install for this target`)
    } else if (source === 'mise') {
      throw new Error('--cli-source mise was requested but `mise` is not on PATH (set MISE_EXE to its path)')
    } else {
      notes.push('mise not found on PATH — used a throwaway npm install')
    }
  }

  if (skipInstall) throw new Error(`--skip-install was given, but ${version} has no npm-installed CLI in the cache and mise does not have it`)
  const installed = await ensureCli(version, { logFile, force })
  return { kind: 'npm', version, dir: installed.dir, reused: installed.reused, notes }
}

/** Describe the source for reports/console. */
export function describeCli(cli) {
  if (cli.kind === 'mise') return `mise:${cli.version} (pre-installed, not activated)`
  return `npm:${cli.version}${cli.reused ? ' (cached throwaway install)' : ' (throwaway install)'}`
}

export { MISE_TOOL as MISE_PACKAGE, DSH_PACKAGE }

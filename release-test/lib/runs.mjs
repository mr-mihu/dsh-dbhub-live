// Locating past runs. Reports are directories under .release-test/reports,
// named <timestamp>-<matrixhash>; history.jsonl is the cheap index.
import fs from 'node:fs'
import path from 'node:path'
import { REPORTS_DIR, readJson } from './util.mjs'

const RUN_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/

export function listRuns() {
  if (!fs.existsSync(REPORTS_DIR)) return []
  return fs
    .readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_RE.test(entry.name))
    .map((entry) => {
      const dir = path.join(REPORTS_DIR, entry.name)
      let report = null
      try {
        report = readJson(path.join(dir, 'report.json'))
      } catch {}
      return { runId: entry.name, dir, report, mtimeMs: fs.statSync(dir).mtimeMs }
    })
    .sort((a, b) => a.runId.localeCompare(b.runId))
}

export function latestRun() {
  return listRuns().at(-1) ?? null
}

/** Newest run whose report actually contains this target version. */
export function latestRunFor(version) {
  const runs = listRuns().reverse()
  return runs.find((run) => run.report?.targets?.some((t) => t.version === version)) ?? null
}

export function runPath(idOrPath) {
  if (!idOrPath) return null
  const direct = path.isAbsolute(idOrPath) ? idOrPath : path.resolve(process.cwd(), idOrPath)
  if (fs.existsSync(direct)) return direct
  const byId = path.join(REPORTS_DIR, idOrPath)
  return fs.existsSync(byId) ? byId : null
}

export { RUN_RE }

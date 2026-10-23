// Minimal semver comparator + range matcher.
//
// We need one thing the registry cannot tell us: given a DSH version we claim to
// support, does it satisfy our declared peerDependencies range? That question is
// exactly where node-semver's prerelease rule bites (a range only admits a
// prerelease version when some comparator on the SAME major.minor.patch tuple
// carries a prerelease tag). Rather than pull a dependency into a plugin repo
// that has none, this implements the subset of semver the manifest actually uses.
//
// Implemented grammar: OR groups separated by `||`; each group is whitespace
// separated comparators with >=, >, <=, <, =, exact, ^, ~; `*` means any.
// Not implemented (and rejected loudly): hyphen ranges, `x` ranges, build metadata
// semantics beyond ignoring it.
import { parseVersion } from './util.mjs'

const isNumeric = (id) => /^\d+$/.test(id)

/** semver precedence compare for prerelease identifier lists. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // release > prerelease
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = isNumeric(x)
    const yn = isNumeric(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1 // numeric identifiers sort lower than alphanumeric
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** -1 | 0 | 1, semver precedence (build metadata ignored). */
export function compareVersions(a, b) {
  return compareParsed(parseVersion(a), parseVersion(b))
}

function compareParsed(pa, pb) {
  if (!pa || !pb) throw new Error(`invalid version: ${!pa ? 'lhs' : 'rhs'}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

const sameTuple = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch

/** Parse one comparator token into { op, version } — throws on unsupported syntax. */
function parseComparator(token) {
  if (token === '*' || token === '') return { op: '*', version: null }
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
  if (!m) throw new Error(`unsupported comparator: ${token}`)
  const op = m[1] ?? '='
  const raw = m[2]
  const version = parseVersion(raw)
  if (!version) throw new Error(`unsupported version in comparator: ${token}`)
  if (raw.includes('x') || raw.includes('X') || raw.includes(' - ')) {
    throw new Error(`unsupported range syntax (x-ranges/hyphen ranges): ${token}`)
  }
  return { op, version }
}

/** Build a plain (non-prerelease) version object for computed bounds. */
const bound = (major, minor, patch) => ({ major, minor, patch, prerelease: [] })

/** Expand ^ / ~ into plain comparator lists. */
function expandComparator({ op, version }) {
  const { major, minor, patch } = version
  if (op === '^') {
    // caret: no change to the left-most non-zero element
    const upper = major > 0
      ? bound(major + 1, 0, 0)
      : minor > 0
        ? bound(major, minor + 1, 0)
        : bound(major, minor, patch + 1)
    return [{ op: '>=', version }, { op: '<', version: upper }]
  }
  if (op === '~') {
    return [{ op: '>=', version }, { op: '<', version: bound(major, minor + 1, 0) }]
  }
  return [{ op, version }]
}

const satisfiesComparator = (candidate, { op, version }) => {
  if (op === '*') return true
  const cmp = compareParsed(candidate, version)
  switch (op) {
    case '>=': return cmp >= 0
    case '>': return cmp > 0
    case '<=': return cmp <= 0
    case '<': return cmp < 0
    case '=': return cmp === 0
    default: throw new Error(`unsupported operator: ${op}`)
  }
}

/**
 * node-semver satisfaction including the prerelease rule.
 * A version with a prerelease tag satisfies a range only when at least one
 * comparator in the matched OR-group is on the same [major,minor,patch] tuple
 * and itself carries a prerelease tag.
 */
export function satisfies(version, range) {
  const candidate = parseVersion(version)
  if (!candidate) throw new Error(`invalid version: ${version}`)
  const groups = String(range).split('||').map((g) => g.trim()).filter(Boolean)
  for (const group of groups) {
    const comparators = group.split(/\s+/).filter(Boolean).map(parseComparator).flatMap(expandComparator)
    const allPass = comparators.every((c) => satisfiesComparator(candidate, c))
    if (!allPass) continue
    if (candidate.prerelease.length === 0) return true
    const prereleaseComparatorExists = comparators.some(
      (c) => c.version?.prerelease?.length > 0 && sameTuple(c.version, candidate),
    )
    if (prereleaseComparatorExists) return true
    // try the next OR-group; this one matched numerically but fails the prerelease rule
  }
  return false
}

/** All `@deepseek-ai/*` peer ranges from a package.json object. */
export function officialPeerRanges(pkg) {
  return Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/'))
}

export function validRange(range) {
  try {
    String(range).split('||').forEach((g) => g.trim() && g.trim().split(/\s+/).filter(Boolean).forEach(parseComparator))
    return true
  } catch {
    return false
  }
}

// --- self-check vectors -----------------------------------------------------
// These are the exact facts that made the old range wrong; keep them as tests.
export const SELF_TEST = [
  // [version, range, expected]
  ['0.1.5', '>=0.1.5-rc.1 <0.3.0-0', true],
  ['0.1.5-rc.1', '>=0.1.5-rc.1 <0.3.0-0', true],
  ['0.1.6-alpha.2', '>=0.1.5-rc.1 <0.3.0-0', false],
  ['0.2.0-rc.2', '>=0.1.5-rc.1 <0.3.0-0', false],
  ['0.2.0', '>=0.1.5-rc.1 <0.3.0-0', true],
  ['0.2.1-alpha.1', '>=0.1.5-rc.1 <0.3.0-0', false],
  ['0.2.1', '>=0.1.5-rc.1 <0.3.0-0', true],
  ['0.3.0-rc.1', '>=0.1.5-rc.1 <0.3.0-0', false],
  // an explicit prerelease branch on each tuple fixes the silent exclusion
  ['0.1.6-alpha.2', '>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.2.0-0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.3.0-0', true],
  ['0.2.0-rc.2', '>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.2.0-0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.3.0-0', true],
  ['0.2.1-alpha.1', '>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.2.0-0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.3.0-0', true],
  ['0.3.0-rc.1', '>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.2.0-0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.3.0-0', false],
  ['1.2.3', '^1.2.0', true],
  ['2.0.0', '^1.2.0', false],
  ['1.2.9', '~1.2.0', true],
  ['1.3.0', '~1.2.0', false],
]

export function selfTest() {
  const failures = []
  for (const [version, range, expected] of SELF_TEST) {
    let actual
    try {
      actual = satisfies(version, range)
    } catch (error) {
      failures.push(`${version} ${range}: threw ${error.message}`)
      continue
    }
    if (actual !== expected) failures.push(`${version} ${range}: expected ${expected}, got ${actual}`)
  }
  return failures
}

#!/usr/bin/env node
// What changed upstream since this port's baseline, limited to what is ported.
//
//   npm run upstream:diff            # stat + commit log
//   npm run upstream:diff -- --full  # the whole patch
//
// Upstream is a git remote of this repository (default name `upstream`, pointing
// at the clone you keep outside DSH). It is a read-only source of commits: never
// merge it, never base a branch on it — this port shares no history with it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Every git call runs against THIS repository, not against whatever directory the
// caller happens to be in: `git sync` is invoked from inside the upstream clone.
const REPO = fileURLToPath(new URL('.', import.meta.url))

const REMOTE = process.env.TE_UPSTREAM_REMOTE ?? 'upstream'
// The four mechanisms this port tracks. Everything else upstream (host adapters,
// paid judge/proposer, repomap) is deliberately not ported.
const PATHS = [
  'tokeneconomizer/plugin/config.py',
  'tokeneconomizer/microskills',
  'tokeneconomizer/toolprune',
  'tokeneconomizer/loopguard',
]

const baseline = readFileSync(new URL('./.upstream-baseline', import.meta.url), 'utf8').trim().split(/\s+/)[0]
const git = (...args) =>
  execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}

// Fetch first: a remote that exists but was never fetched is the common case, and
// it must not look like a missing remote. Silent success yields empty output, so
// only `null` (a non-zero exit) may be read as failure.
if (tryGit('fetch', '--quiet', REMOTE) === null) {
  console.warn(`[upstream] could not fetch '${REMOTE}'; comparing against the last fetched refs.\n`)
}

const head = tryGit('rev-parse', `${REMOTE}/main`)
if (!head) {
  console.error(
    `Cannot read ${REMOTE}/main. Point this port at your upstream clone:\n` +
      `  git remote add ${REMOTE} /home/ducvu/Heigat-home/project/TokenEconomizer\n` +
      `  git fetch ${REMOTE}\n` +
      `or, without a local clone:\n` +
      `  git remote add ${REMOTE} https://github.com/microsoft/TokenEconomizer.git`,
  )
  process.exit(2)
}
const range = `${baseline}..${REMOTE}/main`
const paths = ['--', ...PATHS]
const stat = tryGit('diff', '--stat', range, ...paths)
const log = tryGit('log', '--oneline', range, ...paths) ?? ''

console.log(`baseline  ${baseline}`)
console.log(`upstream  ${head}  (${REMOTE}/main)`)
console.log('')

if (!baseline) {
  console.log('No baseline recorded: put the commit this port was made against in .upstream-baseline.')
} else if (tryGit('rev-parse', '--verify', `${baseline}^{commit}`) === null) {
  console.log(`Baseline ${baseline} is not in this repository's object store; bump .upstream-baseline.`)
} else if (!stat) {
  console.log('Up to date: no ported file changed since the baseline.')
} else {
  console.log(stat)
  if (log) console.log(`\n${log}`)
  if (process.argv.includes('--full')) console.log(`\n${tryGit('diff', range, ...paths) ?? ''}`)
  console.log(
    '\nPort in this order: config.mjs defaults -> *.mjs rules -> notice wording.\n' +
      'Then npm run check && npm test, bump .upstream-baseline, and commit.',
  )
}

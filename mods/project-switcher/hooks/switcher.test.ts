import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { absolutePath, clonePath, projectRows, registeredProjects, repoSlug, type Run } from './switcher.ts'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

/** A fake tracker: per repo, the answers `gh` gives; a repo with `null` cannot be reached. */
function tracker(repos: Record<string, { ready: number; prs: number; runs: object[] } | null>): Run {
  return async command => {
    const at = command.indexOf('--repo')
    const repo = at === -1 ? command[3]! : command[at + 1]!
    const known = repos[repo]
    if (known === null || known === undefined) return { exitCode: 1, stdout: '', stderr: 'Could not resolve to a Repository' }
    if (command[1] === 'repo') return ok('main\n')
    if (command[1] === 'issue') return ok(`${known.ready}\n`)
    if (command[1] === 'pr') return ok(`${known.prs}\n`)
    return ok(JSON.stringify(known.runs))
  }
}

describe('registeredProjects', () => {
  it('lists every project with its turbo flag, absent meaning off', () => {
    const text = JSON.stringify({ projects: [{ repo: 'o/a', turbo: true }, { repo: 'o/b' }] })
    assert.deepEqual(registeredProjects(text), [
      { repo: 'o/a', turbo: true },
      { repo: 'o/b', turbo: false },
    ])
  })

  it('throws for a document that is no registry', () => {
    assert.throws(() => registeredProjects('not json'), /not valid JSON/)
    assert.throws(() => registeredProjects('{}'), /no projects list/)
  })

  it('names the entry that is malformed rather than dropping every project', () => {
    const text = JSON.stringify({ projects: [{ repo: 'o/a' }, { repo: 'nope' }] })
    assert.throws(() => registeredProjects(text), /entry 2 .*"nope"/)
  })
})

describe('projectRows', () => {
  const projects = [
    { repo: repoSlug('o/a'), turbo: true },
    { repo: repoSlug('o/b'), turbo: false },
    { repo: repoSlug('o/gone'), turbo: true },
  ]
  const run = tracker({
    'o/a': { ready: 3, prs: 2, runs: [{ status: 'completed', conclusion: 'success' }] },
    'o/b': { ready: 0, prs: 0, runs: [{ status: 'completed', conclusion: 'failure' }] },
    'o/gone': null,
  })

  it('lists every project with ready count, open PR count, CI state and turbo flag', async () => {
    const rows = await projectRows(run, projects.slice(0, 2))
    assert.deepEqual(rows, [
      { reachable: true, repo: 'o/a', turbo: true, ready: 3, openPullRequests: 2, ci: 'passing' },
      { reachable: true, repo: 'o/b', turbo: false, ready: 0, openPullRequests: 0, ci: 'failing' },
    ])
  })

  it('reads the newest verdict of a push run, passing over cancelled and skipped runs', async () => {
    const rows = await projectRows(
      tracker({ 'o/a': { ready: 0, prs: 0, runs: [{ status: 'completed', conclusion: 'cancelled' }, { status: 'completed', conclusion: 'success' }] } }),
      projects.slice(0, 1),
    )
    assert.deepEqual(rows.map(row => row.reachable && row.ci), ['passing'])
  })

  it('asks for push runs only, so other workflows do not stand for CI', async () => {
    const asked: string[][] = []
    await projectRows(async command => (asked.push(command), tracker({ 'o/a': { ready: 0, prs: 0, runs: [] } })(command)), projects.slice(0, 1))
    const list = asked.find(command => command[1] === 'run')!
    assert.equal(list[list.indexOf('--event') + 1], 'push')
  })

  it('reads a running or absent CI run as such', async () => {
    const rows = await projectRows(
      tracker({ 'o/a': { ready: 0, prs: 0, runs: [{ status: 'in_progress', conclusion: '' }] }, 'o/b': { ready: 0, prs: 0, runs: [] } }),
      projects.slice(0, 2),
    )
    assert.deepEqual(rows.map(row => row.reachable && row.ci), ['running', 'none'])
  })

  it('shows a project the tracker cannot reach as unreachable, not dropped', async () => {
    const rows = await projectRows(run, projects)
    assert.equal(rows.length, 3)
    assert.equal(rows[2]!.reachable, false)
    assert.equal(rows[2]!.repo, 'o/gone')
    assert.equal(rows[2]!.turbo, true)
  })
})

describe('clonePath', () => {
  it('puts the clone under the managed location by slug', () => {
    assert.equal(clonePath(absolutePath('/home/me/side-projects/'), repoSlug('o/a')), '/home/me/side-projects/o/a')
  })
})

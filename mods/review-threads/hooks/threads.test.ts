import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  commentArgs,
  confirmationFor,
  parseDraftPullRequests,
  pullRequestLines,
  pullRequestNumber,
  readArgs,
  repoSlug,
} from './threads.ts'

const thread = (isResolved: boolean, body: string, path = 'src/a.ts') => ({
  isResolved,
  path,
  comments: { nodes: [{ body }] },
})
const pr = (number: number, isDraft: boolean, labels: string[], threads: ReturnType<typeof thread>[]) => ({
  number,
  title: `PR ${number}`,
  isDraft,
  labels: { nodes: labels.map(name => ({ name })) },
  reviewThreads: { nodes: threads },
})
const answer = (...nodes: ReturnType<typeof pr>[]) =>
  JSON.stringify({ data: { repository: { pullRequests: { nodes } } } })

describe('parseDraftPullRequests', () => {
  it('lists draft pull requests only, with their unresolved thread count and summaries', () => {
    const { pullRequests: listed } = parseDraftPullRequests(
      answer(
        pr(5, true, [], [thread(false, 'Rename this\nbecause'), thread(true, 'done'), thread(false, 'Missing test', 'b.ts')]),
        pr(4, false, [], [thread(false, 'ready, so left out')]),
      ),
    )
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.number, 5)
    assert.deepEqual(listed[0]?.openThreads, [
      { path: 'src/a.ts', summary: 'Rename this' },
      { path: 'b.ts', summary: 'Missing test' },
    ])
  })

  it('shortens a long first line', () => {
    const [only] = parseDraftPullRequests(answer(pr(1, true, [], [thread(false, 'x'.repeat(200))]))).pullRequests
    assert.equal(only?.openThreads[0]?.summary.length, 80)
  })

  it('marks a pull request labelled needs-rebase and no other', () => {
    const [labelled, plain] = parseDraftPullRequests(answer(pr(2, true, ['needs-rebase'], []), pr(1, true, ['reviewed'], []))).pullRequests
    assert.equal(labelled?.needsRebase, true)
    assert.equal(plain?.needsRebase, false)
  })

  it('says when the repo host held more pull requests or threads than were read', () => {
    const cut = (connection: object) => ({ ...connection, pageInfo: { hasNextPage: true } })
    const raw = JSON.parse(answer(pr(3, true, [], [thread(false, 'Rename this')])))
    const prs = raw.data.repository.pullRequests
    prs.nodes[0].reviewThreads = cut(prs.nodes[0].reviewThreads)
    const read = parseDraftPullRequests(JSON.stringify({ data: { repository: { pullRequests: cut(prs) } } }))
    assert.equal(read.cut, true)
    assert.equal(read.pullRequests[0]?.threadsCut, true)
    assert.equal(parseDraftPullRequests(answer(pr(3, true, [], []))).cut, false)
    assert.deepEqual(pullRequestLines(read.pullRequests[0]!)[0], '#3 PR 3 — 1+ open threads')
  })

  it('throws on an answer with no pull requests', () => {
    assert.throws(() => parseDraftPullRequests('{"errors":[]}'), /No pull requests/)
  })
})

describe('pullRequestLines', () => {
  it('names the count, the label and each open thread', () => {
    const [only] = parseDraftPullRequests(answer(pr(5, true, ['needs-rebase'], [thread(false, 'Rename this')]))).pullRequests
    assert.deepEqual(pullRequestLines(only!), ['#5 PR 5 — 1 open thread [needs-rebase]', '  src/a.ts: Rename this'])
  })

  it('says so when no thread is open', () => {
    const [only] = parseDraftPullRequests(answer(pr(6, true, [], []))).pullRequests
    assert.deepEqual(pullRequestLines(only!), ['#6 PR 6 — no open threads'])
  })
})

describe('the buttons', () => {
  const repo = repoSlug('acme/pilot')
  const number = pullRequestNumber(9)

  it('post the matching comment on the chosen pull request', () => {
    assert.deepEqual(commentArgs(repo, number, 'apply-review'), ['pr', 'comment', '9', '--repo', 'acme/pilot', '--body', '/apply-review'])
    assert.deepEqual(commentArgs(repo, number, 'rebase'), ['pr', 'comment', '9', '--repo', 'acme/pilot', '--body', '/rebase'])
  })

  it('ask first, naming the comment and the pull request', () => {
    assert.equal(confirmationFor('rebase', number), 'Post /rebase on pull request #9?')
  })

  it('read the repo host for the repo', () => {
    assert.deepEqual(readArgs(repo).slice(-4), ['-F', 'owner=acme', '-F', 'name=pilot'])
  })
})

describe('the brands', () => {
  it('refuse values of the wrong shape', () => {
    assert.throws(() => repoSlug('https://github.com/a/b'), TypeError)
    assert.throws(() => pullRequestNumber(0), TypeError)
  })
})

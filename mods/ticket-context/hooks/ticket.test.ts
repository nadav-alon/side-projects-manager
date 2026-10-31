import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeTicket, issueRef, parseBlockers, parseIssue, referencesIn, repoSlug } from './ticket.ts'

const REPO = repoSlug('acme/pilot')

describe('referencesIn', () => {
  it('reads owner/repo#n and a bare #n, each once, in order', () => {
    const found = referencesIn('see acme/pilot#42, then #7 and acme/pilot#42 and #7')
    assert.deepEqual(found.map(r => [r.repo, r.number]), [['acme/pilot', 42], [null, 7]])
  })

  it('ignores a # inside a word or a path', () => {
    for (const text of ['foo.bar/baz#3x', 'foo#3', 'a/b/c#4', 'file.ts#5', 'issue 42', 'src/a#b']) {
      assert.deepEqual(referencesIn(text), [], text)
    }
  })

  it('ignores an [Image #n] placeholder but still reads a real #n beside it', () => {
    assert.deepEqual(referencesIn('look [Image #1]'), [])
    assert.deepEqual(referencesIn('[Image #1] fix #7 [Image #2]'), [{ repo: null, number: 7 }])
    assert.deepEqual(referencesIn('[Image #1] see #1'), [{ repo: null, number: 1 }])
  })

  it('ignores #0', () => {
    assert.deepEqual(referencesIn('#0'), [])
  })
})

describe('parseIssue', () => {
  it('reads a null body as empty and missing labels as none', () => {
    assert.deepEqual(parseIssue('{"title":"T","body":null}'), { title: 'T', body: '', labels: [] })
  })

  it('reads label names', () => {
    assert.deepEqual(parseIssue('{"title":"T","body":"b","labels":[{"name":"x"}]}').labels, ['x'])
  })

  it('throws, naming the cause, without a title', () => {
    assert.throws(() => parseIssue('{"body":"b"}'), /without a title/)
  })
})

describe('parseBlockers', () => {
  it('keeps owner/repo#n lines and drops the rest', () => {
    assert.deepEqual(parseBlockers('acme/pilot#7\n\n  other/x#1 \nnonsense\n'), ['acme/pilot#7', 'other/x#1'])
  })
})

describe('describeTicket', () => {
  const ref = issueRef(REPO, referencesIn('#5')[0].number)

  it('says none and (no body) for an empty ticket', () => {
    const text = describeTicket(ref, { title: 'T', body: ' ', labels: [], blockers: [] })
    assert.match(text, /Labels: none/)
    assert.match(text, /Blocked by: none/)
    assert.match(text, /\(no body\)/)
  })

  it('says unknown when the blockers could not be fetched', () => {
    assert.match(describeTicket(ref, { title: 'T', body: 'b', labels: ['x'], blockers: null }), /Blocked by: unknown/)
  })
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { avoidedTermsIn, avoidedUses, issueTextOf, proseOf } from './terms.ts'

const CONTEXT = `# Glossary

**Invocation**:
One firing of the morning loop.
_Avoid_: run, execution, session

**Project**:
A repo under management.
_Avoid_: repo (when the project is meant), app

**Morning loop**:
The job.
`

describe('avoidedTermsIn', () => {
  it('pairs each avoided term with the entry it is avoided for', () => {
    assert.deepEqual(avoidedTermsIn(CONTEXT).filter(t => t.preferred === 'Invocation').map(t => t.avoided), ['run', 'execution', 'session'])
  })

  it('drops a term whose avoidance depends on what is meant', () => {
    assert.equal(avoidedTermsIn(CONTEXT).some(t => t.avoided === 'repo'), false)
    assert.equal(avoidedTermsIn(CONTEXT).some(t => t.avoided === 'app' && t.preferred === 'Project'), true)
  })

  it('drops a term that is itself a glossary entry', () => {
    const terms = avoidedTermsIn('**Invocation**:\nOne firing.\n_Avoid_: run, summary\n\n**Run**:\nA ticket.\n\n**Summary**:\nThe tally.\n')
    assert.deepEqual(terms, [])
    const real = avoidedTermsIn(readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8'))
    assert.equal(real.some(t => t.avoided === 'run' || t.avoided === 'summary'), false)
  })

  it('finds nothing in a document with no glossary', () => {
    assert.deepEqual(avoidedTermsIn('# Notes\n\nNothing here.\n'), [])
  })

  it("reads this repo's CONTEXT.md", () => {
    const terms = avoidedTermsIn(readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8'))
    assert.equal(terms.some(t => t.avoided === 'execution' && t.preferred === 'Invocation'), true)
  })
})

const TERMS = avoidedTermsIn(CONTEXT)

describe('avoidedUses', () => {
  it('names the avoided term and the preferred one', () => {
    assert.deepEqual(avoidedUses('Each run ends in a summary.', TERMS), [{ avoided: 'run', preferred: 'Invocation' }])
  })

  it('matches without case and reports a term once', () => {
    assert.equal(avoidedUses('Run it. Then run it again.', TERMS).length, 1)
  })

  it('reports a term avoided for two entries once, naming both', () => {
    const two = [{ avoided: 'task', preferred: 'Run' }, { avoided: 'task', preferred: 'Job' }]
    assert.deepEqual(avoidedUses('a task', two), [{ avoided: 'task', preferred: 'Run" or "Job' }])
  })

  it('does not flag a term inside an identifier', () => {
    assert.deepEqual(avoidedUses('see runId, run_id, rerun and sessions-list', TERMS), [])
  })
})

describe('proseOf', () => {
  it('leaves out fenced code and inline code in a document', () => {
    assert.equal(avoidedUses(proseOf('a.md', 'Use `run` here.\n```ts\nconst run = 1\n```\nDone.'), TERMS).length, 0)
  })

  it('keeps the prose of a document', () => {
    assert.equal(avoidedUses(proseOf('docs/a.md', 'Every run counts.'), TERMS).length, 1)
  })

  it('keeps only the comments of source code', () => {
    const source = 'const run = 1 // one run\n/* a session\n   spans lines */\nconst session = 2\n'
    assert.deepEqual(avoidedUses(proseOf('a.ts', source), TERMS).map(t => t.avoided), ['run', 'session'])
    assert.deepEqual(avoidedUses(proseOf('a.ts', 'const run = session()\n'), TERMS), [])
  })

  it('keeps the comments of a hash-commented file', () => {
    assert.equal(avoidedUses(proseOf('a.yml', 'run: x\n# the execution\n'), TERMS).length, 1)
  })

  it('leaves out an indented fence and a fence closed by a longer one', () => {
    assert.equal(avoidedUses(proseOf('a.md', '- item\n  ```ts\n  const run = 1\n  ```\n'), TERMS).length, 0)
    assert.equal(avoidedUses(proseOf('a.md', '````md\n```\nrun\n```\n````\nDone.'), TERMS).length, 0)
  })

  it('does not read a URL as a comment', () => {
    assert.deepEqual(avoidedUses(proseOf('a.ts', 'const url = "http://host/run"\n'), TERMS), [])
  })

  it('leaves out CONTEXT.md, which lists the avoided terms', () => {
    assert.equal(proseOf('/repo/CONTEXT.md', '_Avoid_: run'), '')
  })
})

describe('issueTextOf', () => {
  it('keeps the title and body values, not the other flags', () => {
    const command = 'gh issue edit 12 --add-label ready --title "Each run" -b \'a session\' --repo o/run'
    assert.equal(issueTextOf(command), 'Each run\na session')
  })
})

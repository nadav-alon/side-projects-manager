import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { avoidedTermsIn } from './terms.ts'

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
    assert.deepEqual(avoidedTermsIn(CONTEXT).map(t => t.avoided).includes('repo'), false)
    assert.equal(avoidedTermsIn(CONTEXT).some(t => t.avoided === 'app' && t.preferred === 'Project'), true)
  })

  it('finds nothing in a document with no glossary', () => {
    assert.deepEqual(avoidedTermsIn('# Notes\n\nNothing here.\n'), [])
  })

  it("reads this repo's CONTEXT.md", () => {
    const terms = avoidedTermsIn(readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8'))
    assert.equal(terms.some(t => t.avoided === 'execution' && t.preferred === 'Invocation'), true)
  })
})

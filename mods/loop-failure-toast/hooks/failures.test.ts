import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseFailure, repeatingFailures } from './failures.ts'

const START = 'Invocation started.'
const SANDBOX = 'Failed nadav-alon/home-catalogue #7: the sandbox image could not build'
const keys = (lines: string[], threshold = 3) =>
  repeatingFailures(lines, threshold).map(f => `${f.repo}#${f.number}: ${f.reason}`)

describe('parseFailure', () => {
  it('reads project, ticket and reason', () => {
    assert.deepEqual(parseFailure(`${SANDBOX}.`), {
      repo: 'nadav-alon/home-catalogue',
      number: 7,
      reason: 'the sandbox image could not build',
    })
  })

  it('reads nothing from other lines', () => {
    assert.equal(parseFailure('Working nadav-alon/home-catalogue #7.'), undefined)
    assert.equal(parseFailure(START), undefined)
  })
})

describe('repeatingFailures', () => {
  const failing = [START, 'Working a/b #1.', `${SANDBOX}.`]

  it('names a failure repeated across the threshold of consecutive invocations', () => {
    assert.deepEqual(keys([...failing, ...failing, ...failing]), [
      'nadav-alon/home-catalogue#7: the sandbox image could not build',
    ])
  })

  it('names nothing below the threshold', () => {
    assert.deepEqual(keys([...failing, ...failing]), [])
  })

  it('counts several failing iterations of one invocation once', () => {
    assert.deepEqual(keys([START, `${SANDBOX}.`, `${SANDBOX}.`, `${SANDBOX}.`]), [])
  })

  it('names nothing when the reasons differ', () => {
    const other = (reason: string) => [START, `Failed a/b #1: ${reason}.`]
    assert.deepEqual(keys([...other('one'), ...other('two'), ...other('three')]), [])
  })

  it('names nothing when the tickets differ', () => {
    const on = (n: number) => [START, `Failed a/b #${n}: boom.`]
    assert.deepEqual(keys([...on(1), ...on(2), ...on(3)]), [])
  })

  it('stops naming a failure once an invocation completes without it', () => {
    assert.deepEqual(keys([...failing, ...failing, ...failing, START, 'Working a/b #2.', START]), [])
  })

  it('keeps naming a failure while the latest invocation has not yet failed', () => {
    assert.equal(keys([...failing, ...failing, ...failing, START]).length, 1)
  })

  it('names a failure again when it starts repeating after a break', () => {
    const broken = [...failing, ...failing, ...failing, START, START]
    assert.deepEqual(keys(broken), [])
    assert.equal(keys([...broken, ...failing, ...failing, ...failing]).length, 1)
  })

  it('ignores lines from an invocation whose start the log no longer holds', () => {
    assert.deepEqual(keys([`${SANDBOX}.`, ...failing, ...failing]), [])
  })
})

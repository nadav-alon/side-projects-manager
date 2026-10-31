import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { failureKey, parseFailure, repeatingFailures } from './failures.ts'

const START = 'Invocation started.'
const SANDBOX = 'Failed nadav-alon/home-catalogue #7: the sandbox image could not build'
const repeated = (lines: string[], threshold = 3) =>
  repeatingFailures(lines, threshold).repeating.map(f => `${f.repo}#${f.number}: ${f.reason}`)

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
    assert.deepEqual(repeated([...failing, ...failing, ...failing]), [
      'nadav-alon/home-catalogue#7: the sandbox image could not build',
    ])
  })

  it('names nothing below the threshold', () => {
    assert.deepEqual(repeated([...failing, ...failing]), [])
  })

  it('counts several failing iterations of one invocation once', () => {
    assert.deepEqual(repeated([START, `${SANDBOX}.`, `${SANDBOX}.`, `${SANDBOX}.`]), [])
  })

  it('names nothing when the reasons differ', () => {
    const other = (reason: string) => [START, `Failed a/b #1: ${reason}.`]
    assert.deepEqual(repeated([...other('one'), ...other('two'), ...other('three')]), [])
  })

  it('names nothing when the tickets differ', () => {
    const on = (n: number) => [START, `Failed a/b #${n}: boom.`]
    assert.deepEqual(repeated([...on(1), ...on(2), ...on(3)]), [])
  })

  it('stops naming a failure once an invocation completes without it', () => {
    assert.deepEqual(repeated([...failing, ...failing, ...failing, START, 'Working a/b #2.', START]), [])
  })

  it('keeps naming a failure while the latest invocation has not yet failed', () => {
    assert.equal(repeated([...failing, ...failing, ...failing, START]).length, 1)
  })

  it('names a failure again when it starts repeating after a break', () => {
    const broken = [...failing, ...failing, ...failing, START, START]
    assert.deepEqual(repeated(broken), [])
    assert.equal(repeated([...broken, ...failing, ...failing, ...failing]).length, 1)
  })

  it('ignores lines from an invocation whose start the log no longer holds', () => {
    assert.deepEqual(repeated([`${SANDBOX}.`, ...failing, ...failing]), [])
  })
})

describe('repeatingFailures on a log as the loop writes it', () => {
  const run = [
    START,
    'Working nadav-alon/home-catalogue #7.',
    'Starting a container for nadav-alon/home-catalogue #7, held to $2.',
    `${SANDBOX}.`,
    'nadav-alon/home-catalogue #7 spent 1.2k tokens.',
    'Stood down on nadav-alon/other #3: the budget is spent (1k of 2k tokens spendable, 1k charged as the run estimate). Resets 2026-01-01T00:00:00.000Z.',
  ]

  it('reads the failure through the lines that name none', () => {
    assert.deepEqual(repeated([...run, ...run, ...run]), ['nadav-alon/home-catalogue#7: the sandbox image could not build'])
  })
})

describe('repeatingFailures ended', () => {
  const failing = [START, 'Working a/b #1.', `${SANDBOX}.`]
  const key = failureKey(parseFailure(`${SANDBOX}.`)!)
  const ended = (lines: string[]) => repeatingFailures(lines).ended(key)

  it('is ended by a complete invocation that ran without the failure', () => {
    assert.equal(ended([...failing, ...failing, ...failing, START, 'Working a/b #2.', START]), true)
  })

  it('is not ended by the latest invocation, which may still be running', () => {
    assert.equal(ended([...failing, ...failing, ...failing, START]), false)
  })

  it('is not ended when the log has scrolled the streak\'s start out', () => {
    assert.equal(ended([...failing, ...failing, START, 'Working a/b #2.']), false)
  })
})

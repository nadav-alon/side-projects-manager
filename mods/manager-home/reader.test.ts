import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_FIVE_HOUR_ALLOWANCE,
  DEFAULT_FIVE_HOUR_RESERVE_FRACTION,
  managerHomeReader,
  type HomeFs,
} from './reader.ts'

const HOME = '/home/manager'

/** A fake file interface over `files`, keyed by absolute path; `directories` lists names by directory. */
function fakeFs(files: Record<string, string>, directories: Record<string, string[]> = {}): HomeFs {
  return {
    async read(path) {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    async list(path) {
      const names = directories[path]
      if (names === undefined) throw new Error(`ENOENT: ${path}`)
      return names.map((name) => ({ name }))
    },
  }
}

const reader = (files: Record<string, string> = {}, directories: Record<string, string[]> = {}) =>
  managerHomeReader(fakeFs(files, directories), HOME)

const closed = {
  openedAt: '2026-01-01T00:00:00.000Z',
  process: 1,
  closedAt: '2026-01-01T00:05:00.000Z',
  outcome: 'dry-queue',
  projects: [],
}
const open = { openedAt: '2026-01-02T09:00:00.000Z', process: 4242, runs: [] }

describe("the manager home's defaults", () => {
  it('match the budget the manager runs under', () => {
    assert.equal(DEFAULT_FIVE_HOUR_ALLOWANCE, 15_000_000)
    assert.equal(DEFAULT_FIVE_HOUR_RESERVE_FRACTION, 0)
  })
})

describe('the in-flight invocation', () => {
  it('is the open journal record, with the worked-today entries the state names it as recording', async () => {
    const state = {
      projects: {},
      workedToday: {
        day: '2026-01-02',
        tickets: [
          { repo: 'o/a', number: 1, recordedBy: { openedAt: open.openedAt, process: 4242 } },
          { repo: 'o/a', number: 2, recordedBy: { openedAt: open.openedAt, process: 4242 } },
          { repo: 'o/b', number: 3, recordedBy: { openedAt: closed.openedAt, process: 1 } },
          { repo: 'o/b', number: 4 },
        ],
      },
    }
    const found = await reader({
      [`${HOME}/journal.json`]: JSON.stringify({ records: [closed, open] }),
      [`${HOME}/state.json`]: JSON.stringify(state),
    }).inFlightInvocation()

    assert.deepEqual(found, { openedAt: new Date(open.openedAt), pid: 4242, workedTodayEntries: 2, runs: [], freed: [] })
  })

  it('names the iterations running and the entries freed, leaving out what it cannot read', async () => {
    const record = {
      ...open,
      runs: [
        { kind: 'implementation', repo: 'o/a', number: 7, startedAt: open.openedAt, transcriptDirectory: '/t' },
        { kind: 'review', repo: 'o/b', number: 8 },
        { kind: 'odd', repo: 'o/e', number: 5 },
        { repo: 'o/c' },
      ],
      freed: [{ repo: 'o/d', number: 9 }, 'junk'],
    }
    const found = await reader({ [`${HOME}/journal.json`]: JSON.stringify({ records: [record] }) }).inFlightInvocation()

    assert.deepEqual(found?.runs, [
      { kind: 'implementation', repo: 'o/a', number: 7 },
      { kind: 'review', repo: 'o/b', number: 8 },
    ])
    assert.deepEqual(found?.freed, [{ repo: 'o/d', number: 9 }])
  })

  it('counts no worked-today entries when the state document is missing or garbled', async () => {
    const journal = { [`${HOME}/journal.json`]: JSON.stringify({ records: [open] }) }
    const expected = { openedAt: new Date(open.openedAt), pid: 4242, workedTodayEntries: 0, runs: [], freed: [] }

    assert.deepEqual(await reader(journal).inFlightInvocation(), expected)
    assert.deepEqual(await reader({ ...journal, [`${HOME}/state.json`]: '{nope' }).inFlightInvocation(), expected)
  })

  it('is nothing known when every record is closed', async () => {
    const files = { [`${HOME}/journal.json`]: JSON.stringify({ records: [closed] }) }
    assert.equal(await reader(files).inFlightInvocation(), undefined)
  })

  for (const [what, files] of [
    ['the home is missing', {}],
    ['the journal is garbled', { [`${HOME}/journal.json`]: '{nope' }],
    ['the journal has no records list', { [`${HOME}/journal.json`]: '{}' }],
    ['the open record has no readable opening', { [`${HOME}/journal.json`]: JSON.stringify({ records: [{ process: 1 }] }) }],
  ] as const) {
    it(`is nothing known when ${what}`, async () => {
      assert.equal(await reader(files).inFlightInvocation(), undefined)
    })
  }
})

describe("the 5-hour window's usage", () => {
  const now = new Date('2026-01-02T12:00:00.000Z')
  const state = {
    projects: {
      'o/a': { runs: [{ at: '2026-01-02T06:59:00.000Z', tokensUsed: 900 }, { at: '2026-01-02T08:00:00.000Z', tokensUsed: 100 }] },
      'o/b': { runs: [{ at: '2026-01-02T11:00:00.000Z', tokensUsed: 20 }, { at: '2026-01-02T12:30:00.000Z', tokensUsed: 7 }] },
    },
  }
  const stateRuns = { runs: [{ at: '2026-01-02T11:00:00.000Z', tokensUsed: 20 }] }
  const stateFile = { [`${HOME}/state.json`]: JSON.stringify(state) }

  it("sums the runs recorded in the five hours up to now, against the budget's figures", async () => {
    const budget = { fiveHourAllowance: 1000, fiveHourReserveFraction: 0.25 }
    const usage = await reader({ ...stateFile, [`${HOME}/budget.json`]: JSON.stringify(budget) }).fiveHourUsage(now)

    assert.deepEqual(usage, { tokensUsed: 120, allowance: 1000, reserveFraction: 0.25, reserveReached: false })
  })

  it('falls back to the default budget when there is no budget document', async () => {
    assert.deepEqual(await reader(stateFile).fiveHourUsage(now), {
      tokensUsed: 120,
      allowance: DEFAULT_FIVE_HOUR_ALLOWANCE,
      reserveFraction: DEFAULT_FIVE_HOUR_RESERVE_FRACTION,
      reserveReached: false,
    })
  })

  it('counts a project with no runs as having none', async () => {
    const files = { [`${HOME}/state.json`]: JSON.stringify({ projects: { 'o/a': {}, 'o/b': stateRuns } }) }
    const usage = await reader(files).fiveHourUsage(now)
    assert.equal(usage?.tokensUsed, 20)
  })

  it("ignores the budget's weekly figures", async () => {
    const budget = { weeklyAllowance: 5, reserveFraction: 0.5 }
    const usage = await reader({ ...stateFile, [`${HOME}/budget.json`]: JSON.stringify(budget) }).fiveHourUsage(now)
    assert.equal(usage?.allowance, DEFAULT_FIVE_HOUR_ALLOWANCE)
  })

  for (const [what, files] of [
    ['the home is missing', {}],
    ['the state document is missing', { [`${HOME}/budget.json`]: '{}' }],
    ['the state document is garbled', { [`${HOME}/state.json`]: '{nope' }],
    ['a run is garbled', { [`${HOME}/state.json`]: JSON.stringify({ projects: { 'o/a': { runs: [{ at: 'soon' }] } } }) }],
    ['the budget document is garbled', { ...stateFile, [`${HOME}/budget.json`]: '{nope' }],
    ['the budget names a reserve outside its range', { ...stateFile, [`${HOME}/budget.json`]: '{"fiveHourReserveFraction":1}' }],
    ['the budget names a non-numeric allowance', { ...stateFile, [`${HOME}/budget.json`]: '{"fiveHourAllowance":"lots"}' }],
    ['the budget names a fractional allowance', { ...stateFile, [`${HOME}/budget.json`]: '{"fiveHourAllowance":1.5}' }],
    ['the budget names a zero allowance', { ...stateFile, [`${HOME}/budget.json`]: '{"fiveHourAllowance":0}' }],
    ['the budget names a field the manager does not know', { ...stateFile, [`${HOME}/budget.json`]: '{"reserve":0.5}' }],
    ['the budget is not an object', { ...stateFile, [`${HOME}/budget.json`]: '[]' }],
    ['a project has runs that are not a list', { [`${HOME}/state.json`]: JSON.stringify({ projects: { 'o/a': { runs: 3 } } }) }],
  ] as const) {
    it(`is nothing known when ${what}`, async () => {
      assert.equal(await reader(files).fiveHourUsage(now), undefined)
    })
  }
})

describe('the trigger log', () => {
  const log = `${HOME}/trigger.log`

  it('returns the recent non-empty lines in order', async () => {
    const lines = await reader({ [log]: 'one\n\ntwo\nthree\nfour\n' }).recentTriggerLog(3)
    assert.deepEqual(lines, ['two', 'three', 'four'])
  })

  it('returns every line when fewer than the limit exist, and none for a limit of zero', async () => {
    assert.deepEqual(await reader({ [log]: 'one\ntwo\n' }).recentTriggerLog(), ['one', 'two'])
    assert.deepEqual(await reader({ [log]: 'one\n' }).recentTriggerLog(0), [])
  })

  it('is nothing known when the log or the home is missing', async () => {
    assert.equal(await reader().recentTriggerLog(), undefined)
  })
})

describe('the discoveries folder', () => {
  const root = `${HOME}/discoveries`

  it('lists the files of each run directory, sorted', async () => {
    const found = await reader({}, { [root]: ['run-b', 'run-a'], [`${root}/run-a`]: ['2.json', '1.json'], [`${root}/run-b`]: ['1.json'] }).discoveries()
    assert.deepEqual(found, ['run-a/1.json', 'run-a/2.json', 'run-b/1.json'])
  })

  it('skips a run directory that cannot be listed', async () => {
    const found = await reader({}, { [root]: ['gone', 'run-a'], [`${root}/run-a`]: ['1.json'] }).discoveries()
    assert.deepEqual(found, ['run-a/1.json'])
  })

  it('lists an empty folder as empty, not as nothing known', async () => {
    assert.deepEqual(await reader({}, { [root]: [] }).discoveries(), [])
  })

  it('is nothing known when the folder or the home is missing', async () => {
    assert.equal(await reader().discoveries(), undefined)
  })
})

describe('a home given with trailing slashes', () => {
  it('is read the same', async () => {
    const files = { [`${HOME}/trigger.log`]: 'one\n' }
    assert.deepEqual(await managerHomeReader(fakeFs(files), `${HOME}//`).recentTriggerLog(), ['one'])
  })
})

describe("the 5-hour window's usage with the session logs", () => {
  const now = new Date('2026-01-02T12:00:00.000Z')
  const LOGS = '/home/dev/.claude/projects'
  const line = (at: string, usage: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { usage } })
  const state = {
    projects: {
      'o/a': { runs: [{ at: '2026-01-02T09:30:00.000Z', tokensUsed: 100 }, { at: '2026-01-02T07:00:00.000Z', tokensUsed: 5000 }] },
    },
  }
  const logs = {
    // The block opens at 09:00; the 03:00 block ended at 08:00.
    [`${LOGS}/p1/s1.jsonl`]: [
      line('2026-01-02T03:00:00.000Z', { input_tokens: 9999, output_tokens: 9999 }),
      line('2026-01-02T09:00:00.000Z', { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 }),
      'not json',
      JSON.stringify({ type: 'user', timestamp: '2026-01-02T09:30:00.000Z' }),
    ].join('\n'),
    [`${LOGS}/p2/s2.jsonl`]: line('2026-01-02T10:00:00.000Z', { input_tokens: 1, output_tokens: 1 }),
    [`${LOGS}/p2/notes.txt`]: 'ignored',
  }
  const directories = { [LOGS]: ['p1', 'p2'], [`${LOGS}/p1`]: ['s1.jsonl'], [`${LOGS}/p2`]: ['s2.jsonl', 'notes.txt'] }
  const home = (extra: Record<string, string> = {}) =>
    managerHomeReader(fakeFs({ [`${HOME}/state.json`]: JSON.stringify(state), ...logs, ...extra }, directories), HOME, LOGS)

  it("adds the developer's interactive use of the open block to the runs since it opened", async () => {
    // Developer: 10 + 2*5 + 4*1.25 + 100*0.1 = 35, plus 1 + 5 = 6, rounded once = 41; own: 100 (the 07:00 run is before the block).
    assert.equal((await home().fiveHourUsage(now))?.tokensUsed, 141)
  })

  it('counts only the own runs once the block has ended', async () => {
    const later = new Date('2026-01-02T14:30:00.000Z')
    assert.equal((await home().fiveHourUsage(later))?.tokensUsed, 0)
  })

  it('is nothing known when the session logs cannot be listed', async () => {
    const lonely = managerHomeReader(fakeFs({ [`${HOME}/state.json`]: JSON.stringify(state) }), HOME, LOGS)
    assert.equal(await lonely.fiveHourUsage(now), undefined)
  })
})

describe("the 5-hour window's usage with an observed reset", () => {
  const now = new Date('2026-01-02T12:00:00.000Z')
  const LOGS = '/logs'
  const line = (at: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: 10, output_tokens: 0 } } })
  const state = { projects: { 'o/a': { runs: [{ at: '2026-01-02T08:00:00.000Z', tokensUsed: 1000 }] } } }
  const withReset = (observedResetAt: string) =>
    managerHomeReader(
      fakeFs(
        {
          [`${HOME}/state.json`]: JSON.stringify(state),
          [`${HOME}/budget.json`]: JSON.stringify({ observedResetAt }),
          // One block from 07:00; a message at 09:00 and one at 11:00 fall in it.
          [`${LOGS}/p/s.jsonl`]: [line('2026-01-02T07:00:00.000Z'), line('2026-01-02T09:00:00.000Z'), line('2026-01-02T11:00:00.000Z')].join('\n'),
        },
        { [LOGS]: ['p'], [`${LOGS}/p`]: ['s.jsonl'] },
      ),
      HOME,
      LOGS,
    )

  it('takes a reset still to come as the end of the open block', async () => {
    // The block opened at 08:00 (13:00 less 5 hours): 09:00 and 11:00 messages, and the 08:00 run.
    const usage = await withReset('2026-01-02T13:00:00Z').fiveHourUsage(now)
    assert.equal(usage?.tokensUsed, 1020)
    assert.equal('observedResetAt' in (usage ?? {}), false)
  })

  it('drops the messages before a reset already past', async () => {
    // Only the 09:00 message and later count; the block opens at 09:00, so the 08:00 run is before it.
    const usage = await withReset('2026-01-02T08:30:00Z').fiveHourUsage(now)
    assert.equal(usage?.tokensUsed, 20)
  })

  for (const [what, observed] of [
    ['more than five hours ahead', '2026-01-02T17:00:01Z'],
    ['without a zone', '2026-01-02T13:00:00'],
    ['not an instant', 'soon'],
  ] as const) {
    it(`is nothing known when the reset is ${what}`, async () => {
      assert.equal(await withReset(observed).fiveHourUsage(now), undefined)
    })
  }
})

describe("the 5-hour window's reserve", () => {
  const now = new Date('2026-01-02T12:00:00.000Z')
  const usedWith = (budget: object, tokensUsed: number) =>
    reader({
      [`${HOME}/state.json`]: JSON.stringify({ projects: { 'o/a': { runs: [{ at: '2026-01-02T11:00:00.000Z', tokensUsed }] } } }),
      [`${HOME}/budget.json`]: JSON.stringify(budget),
    }).fiveHourUsage(now)

  it('is reached only once the tokens used exceed the allowance less the reserve rounded up', async () => {
    const budget = { fiveHourAllowance: 1001, fiveHourReserveFraction: 0.5 } // spendable: 1001 - 501 = 500
    assert.equal((await usedWith(budget, 500))?.reserveReached, false)
    assert.equal((await usedWith(budget, 501))?.reserveReached, true)
  })
})

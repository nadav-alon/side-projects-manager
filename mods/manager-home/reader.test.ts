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
        { kind: 'work', repo: 'o/a', number: 7, startedAt: open.openedAt, transcriptDirectory: '/t' },
        { kind: 'review', repo: 'o/b', number: 8 },
        { repo: 'o/c' },
      ],
      freed: [{ repo: 'o/d', number: 9 }, 'junk'],
    }
    const found = await reader({ [`${HOME}/journal.json`]: JSON.stringify({ records: [record] }) }).inFlightInvocation()

    assert.deepEqual(found?.runs, [
      { kind: 'work', repo: 'o/a', number: 7 },
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

    assert.deepEqual(usage, { tokensUsed: 120, allowance: 1000, reserveFraction: 0.25 })
  })

  it('falls back to the default budget when there is no budget document', async () => {
    assert.deepEqual(await reader(stateFile).fiveHourUsage(now), {
      tokensUsed: 120,
      allowance: DEFAULT_FIVE_HOUR_ALLOWANCE,
      reserveFraction: DEFAULT_FIVE_HOUR_RESERVE_FRACTION,
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

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseUsageWindows } from '../../src/adapters/usage-ledger/parse-usage-windows.ts'
import { budgetStatus } from '../../src/budget-gate.ts'
import { DEFAULT_BUDGET, reserveFraction, tokenCount, type RunCost } from '../../src/ports/index.ts'
import { managerHomeReader, type HomeFs } from './reader.ts'

// The reader carries its own copy of the gate's 5-hour arithmetic, because a mod cannot import
// `src/`. These tests feed both the same session logs and state, so a change to the gate's weights,
// block rules or reserve arithmetic that the copy does not follow fails here.

const HOME = '/home/manager'
const LOGS = '/home/claude/projects'
const NOW = new Date('2026-09-10T12:00:00.000Z')

function logLine(timestamp: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', timestamp, message: { usage } })
}

// Two blocks with a 6-hour gap between them; the later one opens at 09:00. The cache fields make
// the weighted figures fractional, so the rounding is checked too.
const SESSION_LOGS = [
  logLine('2026-09-10T02:00:00.000Z', { input_tokens: 1_000, output_tokens: 500, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 90_000 }),
  logLine('2026-09-10T03:00:00.000Z', { input_tokens: 2_000, output_tokens: 700, cache_read_input_tokens: 51_001 }),
  logLine('2026-09-10T09:00:00.000Z', { input_tokens: 1_234, output_tokens: 567, cache_creation_input_tokens: 8_901, cache_read_input_tokens: 23_457 }),
  logLine('2026-09-10T10:30:00.000Z', { input_tokens: 333, output_tokens: 1_111, cache_creation_input_tokens: 777, cache_read_input_tokens: 99_999 }),
  logLine('2026-09-10T11:30:00.000Z', { input_tokens: 55, output_tokens: 66, cache_read_input_tokens: 12_345 }),
].join('\n')

const RUNS = [
  { at: '2026-09-10T08:00:00.000Z', tokensUsed: 4_000 },
  { at: '2026-09-10T09:30:00.000Z', tokensUsed: 3_001 },
  { at: '2026-09-10T11:00:00.000Z', tokensUsed: 2_002 },
]

const OBSERVED_RESETS: Record<string, string | undefined> = {
  'no observed reset': undefined,
  'a reset that has passed': '2026-09-10T10:00:00.000Z',
  'a reset still to come': '2026-09-10T13:00:00.000Z',
}

function fakeFs(files: Record<string, string>, directories: Record<string, string[]>): HomeFs {
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

/** What the reader says of the shared logs and runs under the given figures. */
async function readerSays(allowance: number, reserve: number, observedResetAt: string | undefined) {
  const fs = fakeFs(
    {
      [`${HOME}/state.json`]: JSON.stringify({ projects: { 'o/a': { runs: RUNS } } }),
      [`${HOME}/budget.json`]: JSON.stringify({
        fiveHourAllowance: allowance,
        fiveHourReserveFraction: reserve,
        ...(observedResetAt === undefined ? {} : { observedResetAt }),
      }),
      [`${LOGS}/p/s.jsonl`]: SESSION_LOGS,
    },
    { [LOGS]: ['p'], [`${LOGS}/p`]: ['s.jsonl'] },
  )
  return managerHomeReader(fs, HOME, LOGS).fiveHourUsage(NOW)
}

/** What the gate says of the same logs and runs under the same figures. */
function gateSays(allowance: number, reserve: number, observedResetAt: string | undefined) {
  const windows = parseUsageWindows([SESSION_LOGS], NOW, observedResetAt === undefined ? undefined : new Date(observedResetAt))
  const ownSpend: RunCost[] = RUNS.map((run) => ({ at: new Date(run.at), tokensUsed: tokenCount(run.tokensUsed) }))
  const budget = { ...DEFAULT_BUDGET, fiveHourAllowance: tokenCount(allowance), fiveHourReserveFraction: reserveFraction(reserve) }
  return budgetStatus(windows, budget, ownSpend).fiveHour
}

describe("the reader's 5-hour figure", () => {
  for (const [name, observedResetAt] of Object.entries(OBSERVED_RESETS)) {
    it(`matches the gate's tokens used under ${name}`, async () => {
      const gate = gateSays(DEFAULT_BUDGET.fiveHourAllowance, 0, observedResetAt)
      const reader = await readerSays(DEFAULT_BUDGET.fiveHourAllowance, 0, observedResetAt)

      assert.notEqual(gate.tokensUsed, 0)
      assert.equal(reader?.tokensUsed, gate.tokensUsed)
    })

    it(`matches the gate's reserve verdict on either side of the line under ${name}`, async () => {
      const used = gateSays(DEFAULT_BUDGET.fiveHourAllowance, 0, observedResetAt).tokensUsed

      for (const [allowance, reserve] of [[used, 0], [used - 1, 0], [used * 2, 0.5], [used * 2 - 2, 0.5]] as const) {
        const gate = gateSays(allowance, reserve, observedResetAt)
        const reader = await readerSays(allowance, reserve, observedResetAt)

        assert.equal(reader?.reserveReached, gate.reserveReached, `allowance ${allowance}, reserve ${reserve}`)
      }
    })
  }

  it('differs between the observed resets, so the fixture exercises each', () => {
    const used = Object.values(OBSERVED_RESETS).map((reset) => gateSays(DEFAULT_BUDGET.fiveHourAllowance, 0, reset).tokensUsed)

    assert.equal(new Set(used).size, used.length)
  })
})

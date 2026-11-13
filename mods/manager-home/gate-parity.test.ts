import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseUsageWindows } from '../../src/adapters/usage-ledger/parse-usage-windows.ts'
import { budgetStatus } from '../../src/budget-gate.ts'
import { DEFAULT_BUDGET, DISCOVERY_KINDS, reserveFraction, tokenCount, type ReserveFraction, type RunCost, type TokenCount } from '../../src/ports/index.ts'
import { managerHomeReader, type HomeFs } from './reader.ts'
import { DISCOVERY_KINDS as MOD_DISCOVERY_KINDS } from './types.ts'

// The reader carries its own copy of the gate's 5-hour arithmetic, because a mod cannot import
// `src/`. These tests feed both the same session logs and state, so a change to the gate's weights,
// block rules or reserve arithmetic that the copy does not follow fails here.

const HOME = '/home/manager'
const LOGS = '/home/claude/projects'
const NOW = new Date('2026-09-10T12:00:00.000Z')

function logLine(timestamp: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', timestamp, message: { usage } })
}

// Messages by the gate's block rule, each measured against the one that opened its block:
//   P 01:00 opens a block; Q 04:30 joins it; R 06:00 is exactly 5h on, so it opens the next, which
//   U 08:30 and S 10:30 join (4.5h on); T 11:30 is 5.5h on, so it opens the block open at 12:00.
// Measured against the previous message instead, one block would run P to T and have ended; read with
// `>` at 5h, R would join P's block and U would open the one open now. The open block's lines carry
// cache reads of x.4 tokens' weight, so one line, two and three sum to .4, .8 and 1.2: rounding each
// line, or up, or down, gives a different total in at least one of the three observed-reset cases.
const SESSION_LOGS = [
  logLine('2026-09-10T01:00:00.000Z', { input_tokens: 1_000, output_tokens: 500, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 90_000 }),
  logLine('2026-09-10T04:30:00.000Z', { input_tokens: 2_000, output_tokens: 700, cache_read_input_tokens: 51_001 }),
  logLine('2026-09-10T06:00:00.000Z', { input_tokens: 1_234, output_tokens: 567, cache_creation_input_tokens: 8_900, cache_read_input_tokens: 23_457 }),
  logLine('2026-09-10T08:30:00.000Z', { input_tokens: 111, output_tokens: 222, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 12_344 }),
  logLine('2026-09-10T10:30:00.000Z', { input_tokens: 333, output_tokens: 1_111, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 20_004 }),
  logLine('2026-09-10T11:30:00.000Z', { input_tokens: 55, output_tokens: 66, cache_creation_input_tokens: 400, cache_read_input_tokens: 30_014 }),
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

interface Figures {
  allowance: TokenCount
  reserve: ReserveFraction
  observedResetAt: string | undefined
}

const figures = (allowance: number, reserve: number, observedResetAt: string | undefined): Figures => ({
  allowance: tokenCount(allowance),
  reserve: reserveFraction(reserve),
  observedResetAt,
})

/** What the reader says of the shared logs and runs under the given figures. */
async function readerSays({ allowance, reserve, observedResetAt }: Figures) {
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
function gateSays({ allowance, reserve, observedResetAt }: Figures) {
  const windows = parseUsageWindows([SESSION_LOGS], NOW, observedResetAt === undefined ? undefined : new Date(observedResetAt))
  const ownSpend: RunCost[] = RUNS.map((run) => ({ at: new Date(run.at), tokensUsed: tokenCount(run.tokensUsed) }))
  const budget = { ...DEFAULT_BUDGET, fiveHourAllowance: allowance, fiveHourReserveFraction: reserve }
  return budgetStatus(windows, budget, ownSpend).fiveHour
}

describe("the reader's 5-hour figure", () => {
  for (const [name, observedResetAt] of Object.entries(OBSERVED_RESETS)) {
    it(`matches the gate's tokens used under ${name}`, async () => {
      const gate = gateSays(figures(DEFAULT_BUDGET.fiveHourAllowance, 0, observedResetAt))
      const reader = await readerSays(figures(DEFAULT_BUDGET.fiveHourAllowance, 0, observedResetAt))

      assert.notEqual(gate.tokensUsed, 0)
      assert.equal(reader?.tokensUsed, gate.tokensUsed)
    })

    it(`matches the gate's reserve verdict on either side of the line under ${name}`, async () => {
      const used = gateSays(figures(DEFAULT_BUDGET.fiveHourAllowance, 0, observedResetAt)).tokensUsed

      for (const [allowance, reserve] of [[used, 0], [used - 1, 0], [used * 2, 0.5], [used * 2 - 2, 0.5], [used * 2 - 1, 0.5]] as const) {
        const gate = gateSays(figures(allowance, reserve, observedResetAt))
        const reader = await readerSays(figures(allowance, reserve, observedResetAt))

        assert.equal(reader?.reserveReached, gate.reserveReached, `allowance ${allowance}, reserve ${reserve}`)
      }
    })
  }

  it('differs between the observed resets, so the fixture exercises each', () => {
    const used = Object.values(OBSERVED_RESETS).map((reset) => gateSays(figures(DEFAULT_BUDGET.fiveHourAllowance, 0, reset)).tokensUsed)

    assert.equal(new Set(used).size, used.length)
  })
})

describe("the reader's discovery kinds", () => {
  it("are the kinds the manager files", () => {
    assert.deepEqual([...MOD_DISCOVERY_KINDS], [...DISCOVERY_KINDS])
  })
})

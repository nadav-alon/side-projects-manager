import type { RenderElement } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const ABOVE_PROMPT = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} },
} as const

type On = Parameters<TestBody>[1]

const NOW = Date.parse('2026-10-30T12:00:00Z')

/** Stands for the engine beneath the mod: a manager home holding `files`, read through `$.fs`. */
function engine(on: On, files: Record<string, string>): void {
  mock.clock(on, { now: NOW })
  on('fs.read', (_$, e) => {
    const text = Object.entries(files).find(([name]) => e.path.endsWith(`/${name}`))?.[1]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` } as never
    return { value: text } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
}

const state = (tokens: number) =>
  JSON.stringify({ projects: { 'acme/pilot': { runs: [{ at: '2026-10-30T10:00:00Z', tokensUsed: tokens }] } } })

test('the band shows the window usage as a share of the allowance', async ($, on) => {
  engine(on, { 'state.json': state(3_000_000), 'budget.json': '{"fiveHourAllowance":10000000}' })

  const ui = await $.ui.mount({ plugin: 'budget-band', surface: 'terminal', ...ABOVE_PROMPT })
  const band = await ui.find({ type: 'Text' })
  expect(band?.text.trim()).toBe('5h window: 30% used')
})

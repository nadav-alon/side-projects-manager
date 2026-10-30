import type { RenderElement } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const ABOVE_PROMPT = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} },
} as const

type On = Parameters<TestBody>[1]

const NOW = Date.parse('2026-10-30T12:00:00Z')

/** Stands for the engine beneath the mod: a manager home holding `files`, and a band already drawn when `drawn`. */
function engine(on: On, files: Record<string, string>, drawn = false): void {
  mock.clock(on, { now: NOW })
  on('fs.read', (_$, e) => {
    const text = Object.entries(files).find(([name]) => e.path.endsWith(`/${name}`))?.[1]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` } as never
    return { value: text } as never
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, {}, drawn ? h(Text, {}, ' grill: acme/pilot#42 ') : undefined) as RenderElement
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

test('the band turns yellow once usage enters the loop reserve', async ($, on) => {
  const files = {
    'state.json': state(7_900_000),
    'budget.json': '{"fiveHourAllowance":10000000,"fiveHourReserveFraction":0.2}',
  }
  engine(on, files)
  const before = await $.ui.mount({ plugin: 'budget-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect((await before.find({ type: 'Text' }))?.props.backgroundColor).toBe('green')
  await before.unmount()

  files['state.json'] = state(8_000_000)
  const after = await $.ui.mount({ plugin: 'budget-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect((await after.find({ type: 'Text' }))?.props.backgroundColor).toBe('yellow')
})

test('nothing is drawn when the state or the budget cannot be read', async ($, on) => {
  const files: Record<string, string> = {}
  engine(on, files)
  const missing = await $.ui.mount({ plugin: 'budget-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect(await missing.find({ type: 'Text' })).toBeUndefined()
  await missing.unmount()

  files['state.json'] = state(1_000_000)
  files['budget.json'] = '{ not json'
  const garbled = await $.ui.mount({ plugin: 'budget-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect(await garbled.find({ type: 'Text' })).toBeUndefined()
})

test('a band drawn beneath it still draws', async ($, on) => {
  engine(on, { 'state.json': state(3_000_000), 'budget.json': '{"fiveHourAllowance":10000000}' }, true)

  const ui = await $.ui.mount({ plugin: 'budget-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect((await ui.find({ type: 'Text', text: /5h window/ }))?.text.trim()).toBe('5h window: 30% used')
  expect((await ui.find({ type: 'Text', text: /grill/ }))?.text.trim()).toBe('grill: acme/pilot#42')
})

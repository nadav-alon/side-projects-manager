import type { RenderElement } from 'claude-code'
import { expect, test, type TestBody } from 'claude-code/testing'

const site = (hasSurvey: boolean) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} },
  }) as const
const ABOVE_PROMPT = site(false)

type On = Parameters<TestBody>[1]

/** Stands for the engine beneath the mod: the toasts it shows are collected. */
function engine(on: On): string[] {
  const toasts: string[] = []
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return {} as never
  })
  return toasts
}

test('the band appears after a mode skill and not before', async ($, on) => {
  engine(on)
  const before = await $.ui.mount({ plugin: 'mode-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect(await before.find({ type: 'Text' })).toBeUndefined()
  await before.unmount()

  await $.skill.prompt({ skill: 'grilling', text: 'Grill me on acme/pilot#42' })

  const after = await $.ui.mount({ plugin: 'mode-band', surface: 'terminal', ...ABOVE_PROMPT })
  const band = await after.find({ type: 'Text' })
  expect(band?.text.trim()).toBe('grill: acme/pilot#42')
  expect(band?.props.backgroundColor).toBe('magenta')
  await after.unmount()
})

test('another mode skill replaces the band and a toast says so once', async ($, on) => {
  const toasts = engine(on)
  await $.skill.prompt({ skill: 'grilling', text: 'acme/pilot#42' })
  await $.skill.prompt({ skill: 'grilling', text: 'acme/pilot#43' })
  await $.skill.prompt({ skill: 'triage', text: 'triage acme/pilot#7' })

  const ui = await $.ui.mount({ plugin: 'mode-band', surface: 'terminal', ...ABOVE_PROMPT })
  const band = await ui.find({ type: 'Text' })
  expect(band?.text.trim()).toBe('triage: acme/pilot#7')
  expect(band?.props.backgroundColor).toBe('yellow')
  expect(toasts).toEqual(['Session mode: grill', 'Session mode: triage'])
})

test('a skill that is no mode leaves no band', async ($, on) => {
  engine(on)
  await $.skill.prompt({ skill: 'commit', text: 'acme/pilot#42' })

  const ui = await $.ui.mount({ plugin: 'mode-band', surface: 'terminal', ...ABOVE_PROMPT })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
})

test('a survey keeps its place', async ($, on) => {
  engine(on)
  await $.skill.prompt({ skill: 'standup', text: '' })

  const ui = await $.ui.mount({
    plugin: 'mode-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: site(true).props,
  })
  expect(await ui.find({ type: 'Text', text: /standup/ })).toBeUndefined()
})

import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const FAILING = ['Invocation started.', 'Failed a/b #7: the sandbox image could not build.']

/**
 * Stands for the engine beneath the mod: `log` is the trigger log's lines, `tick()` fires one poll
 * of the mod's timer and resolves once the poll has finished, and the toasts the mod makes are collected.
 */
function engine(on: On, log: string[]) {
  const toasts: string[] = []
  let release = () => {}
  let polled = () => {}
  let ticked = new Promise<void>(resolve => (release = resolve))

  on('session.start', () => ({ cwd: '/session' }))
  on('fs.read', () => ({ value: log.join('\n') }) as never)
  on('clock.every', async () => {
    await ticked
    ticked = new Promise<void>(resolve => (release = resolve))
    polled()
    return { value: undefined } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return {
    toasts,
    tick: () => {
      const done = new Promise<void>(resolve => (polled = resolve))
      release()
      return done
    },
  }
}

test('a failure repeated across three invocations toasts, naming project, ticket and reason', async ($, on) => {
  const { toasts } = engine(on, [...FAILING, ...FAILING, ...FAILING])
  await $.session.start({ cwd: '/session' } as never)

  expect(toasts).toEqual(['a/b #7 keeps failing: the sandbox image could not build'])
})

test('the same repeating failure toasts once, not on every new entry', async ($, on) => {
  const log = [...FAILING, ...FAILING, ...FAILING]
  const { toasts, tick } = engine(on, log)
  await $.session.start({ cwd: '/session' } as never)

  log.push(...FAILING)
  await tick()
  expect(toasts.length).toBe(1)
})

test('a failure that stops repeating, then starts again, toasts again', async ($, on) => {
  const log = [...FAILING, ...FAILING, ...FAILING]
  const { toasts, tick } = engine(on, log)
  await $.session.start({ cwd: '/session' } as never)

  log.push('Invocation started.', 'Invocation started.')
  await tick()
  log.push(...FAILING, ...FAILING, ...FAILING)
  await tick()
  expect(toasts.length).toBe(2)
})

test('differing failures do not toast', async ($, on) => {
  const other = (n: number) => ['Invocation started.', `Failed a/b #${n}: boom.`]
  const { toasts } = engine(on, [...other(1), ...other(2), ...other(3)])
  await $.session.start({ cwd: '/session' } as never)

  expect(toasts).toEqual([])
})

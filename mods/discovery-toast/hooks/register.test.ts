import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/**
 * Stands for the engine beneath the mod: `files` is the discoveries folder (run directory to file
 * names), `tick()` fires one poll of the mod's timer, and the status entries and toasts the mod
 * makes are collected.
 */
function engine(on: On, files: Record<string, string[]>) {
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[] }
  let release = () => {}
  let ticked = new Promise<void>(resolve => (release = resolve))

  on('session.start', () => ({ cwd: '/session' }))
  on('fs.list', (_$, e) => {
    const parts = e.path.split('/')
    const inside = parts.at(-2) === 'discoveries' ? files[parts.at(-1)!] : parts.at(-1) === 'discoveries' ? Object.keys(files) : undefined
    if (inside === undefined) throw new Error('missing')
    return { value: inside.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('clock.every', async () => {
    await ticked
    ticked = new Promise<void>(resolve => (release = resolve))
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined } as never
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined } as never
  })
  return { seen, tick: () => release() }
}

test('discoveries already present are counted and not toasted', async ($, on) => {
  const { seen } = engine(on, { 'run-a': ['1.json', '2.json'] })
  await $.session.start({ cwd: '/session' } as never)

  expect(seen.statuses.at(-1)).toBe('2 pending discoveries')
  expect(seen.toasts).toEqual([])
})

test('no discoveries leave the status clear', async ($, on) => {
  const { seen } = engine(on, {})
  await $.session.start({ cwd: '/session' } as never)

  expect(seen.statuses.at(-1)).toBeUndefined()
})

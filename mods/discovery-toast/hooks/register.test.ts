import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/**
 * Stands for the engine beneath the mod: `files` is the discoveries folder (run directory to file
 * names), `tick()` fires one poll of the mod's timer and resolves once the poll has set the status, and the status entries and toasts the mod
 * makes are collected.
 */
function engine(
  on: On,
  files: Record<string, string[]>,
  {
    unreadable = { isSo: false },
    contents = {},
    isHome = true,
    home = '',
  }: { unreadable?: { isSo: boolean }; contents?: Record<string, string>; isHome?: boolean; home?: string } = {},
) {
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[] }
  const listed: string[] = []
  let release = () => {}
  let polled = () => {}
  let ticked = new Promise<void>(resolve => (release = resolve))

  on('session.start', () => ({ cwd: '/session' }))
  on('command.register', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: home, stderr: '' } }) as never)
  on('fs.list', (_$, e) => {
    listed.push(e.path)
    const parts = e.path.split('/')
    const inside = parts.at(-2) === 'discoveries' ? files[parts.at(-1)!] : parts.at(-1) === 'discoveries' ? Object.keys(files) : undefined
    if (inside === undefined || unreadable.isSo) throw new Error('missing')
    return { value: inside.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('/journal.json') && isHome) return { value: '{}' } as never
    const text = contents[e.path.split('/').slice(-2).join('/')]
    if (text === undefined) throw new Error('missing')
    return { value: text } as never
  })
  on('clock.every', async () => {
    await ticked
    ticked = new Promise<void>(resolve => (release = resolve))
    return { value: undefined } as never
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    polled()
    return { value: undefined } as never
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined } as never
  })
  return {
    seen,
    listed,
    tick: () => {
      const done = new Promise<void>(resolve => (polled = resolve))
      release()
      return done
    },
  }
}

test('discoveries already present are counted and not toasted', async ($, on) => {
  const { seen } = engine(on, { 'run-a': ['1.json', '2.json'] })
  await $.session.start({ cwd: '/session' } as never)

  expect(seen.statuses.at(-1)).toBe('2 pending discoveries (newest: run-a/2.json)')
  expect(seen.toasts).toEqual([])
})

test('the status names the newest pending discovery by its kind and title', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json', '3.json'] }
  const contents = {
    'run-a/1.json': JSON.stringify({ kind: 'clarification', title: 'Old' }),
    'run-a/4.json': JSON.stringify({ kind: 'correction', title: 'Wrong scope' }),
    'run-a/3.json': 'garbled',
  }
  const { seen, tick } = engine(on, files, { contents })
  await $.session.start({ cwd: '/session' } as never)
  expect(seen.statuses.at(-1)).toBe('2 pending discoveries (newest: run-a/3.json)')

  files['run-a']!.push('4.json')
  await tick()
  expect(seen.statuses.at(-1)).toBe('3 pending discoveries (newest: correction: Wrong scope)')

  files['run-a'] = ['1.json']
  await tick()
  expect(seen.statuses.at(-1)).toBe('1 pending discovery (newest: clarification: Old)')
})

test('a long title is truncated to one line in the status', async ($, on) => {
  const title = `${'long '.repeat(30)}\nsecond line`
  const { seen } = engine(on, { 'run-a': ['1.json'] }, { contents: { 'run-a/1.json': JSON.stringify({ kind: 'suggestion', title }) } })
  await $.session.start({ cwd: '/session' } as never)

  const status = seen.statuses.at(-1)!
  expect(status).toBe(`1 pending discovery (newest: suggestion: ${'long '.repeat(5)}long…)`)
  expect(status).not.toContain('\n')
})

test('the newest discovery in a run is the highest numbered, not the last listed', async ($, on) => {
  const { seen } = engine(on, { 'run-a': ['1.json', '10.json', '9.json'] })
  await $.session.start({ cwd: '/session' } as never)

  expect(seen.statuses.at(-1)).toBe('3 pending discoveries (newest: run-a/10.json)')
})

test('across run folders the newest is the one first seen last', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json', '10.json'] }
  const { seen, tick } = engine(on, files)
  await $.session.start({ cwd: '/session' } as never)

  files['run-b'] = ['2.json']
  await tick()
  expect(seen.statuses.at(-1)).toBe('3 pending discoveries (newest: run-b/2.json)')
})

test('no discoveries leave the status clear', async ($, on) => {
  const { seen } = engine(on, {})
  await $.session.start({ cwd: '/session' } as never)

  expect(seen.statuses).toEqual([undefined])
})

test('a discovery that appears while the session is open toasts once, naming it', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json'] }
  const { seen, tick } = engine(on, files)
  await $.session.start({ cwd: '/session' } as never)

  files['run-a']!.push('2.json')
  await tick()
  expect(seen.toasts).toEqual(['New discovery: run-a/2.json'])
  expect(seen.statuses.at(-1)).toBe('2 pending discoveries (newest: run-a/2.json)')

  await tick()
  expect(seen.toasts).toEqual(['New discovery: run-a/2.json'])
})

test('a new discovery toasts its kind and title', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json'] }
  const contents = { 'run-a/2.json': JSON.stringify({ kind: 'suggestion', title: 'Cache the lookup', body: 'x' }) }
  const { seen, tick } = engine(on, files, { contents })
  await $.session.start({ cwd: '/session' } as never)

  files['run-a']!.push('2.json')
  await tick()
  expect(seen.toasts).toEqual(['suggestion: Cache the lookup'])
})

test('a long title is truncated to one line in the toast', async ($, on) => {
  const title = `${'long '.repeat(30)}\nsecond line`
  const files: Record<string, string[]> = { 'run-a': [] }
  const contents = { 'run-a/1.json': JSON.stringify({ kind: 'suggestion', title }) }
  const { seen, tick } = engine(on, files, { contents })
  await $.session.start({ cwd: '/session' } as never)

  files['run-a'] = ['1.json']
  await tick()
  expect(seen.toasts).toEqual([`suggestion: ${'long '.repeat(5)}long…`])
})

test('a new discovery that cannot be read as one toasts its path', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': [] }
  const contents = { 'run-a/1.json': 'not json', 'run-a/2.json': JSON.stringify({ kind: 'suggestion' }), 'run-a/3.json': JSON.stringify({ kind: 'remark', title: 'Not a kind' }) }
  const { seen, tick } = engine(on, files, { contents })
  await $.session.start({ cwd: '/session' } as never)

  files['run-a'] = ['1.json', '2.json', '3.json']
  await tick()
  expect(seen.toasts).toEqual([
    'New discovery: run-a/1.json',
    'New discovery: run-a/2.json',
    'New discovery: run-a/3.json',
  ])
})

test('the status clears when the pending discoveries are read away', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json'] }
  const { seen, tick } = engine(on, files)
  await $.session.start({ cwd: '/session' } as never)

  delete files['run-a']
  await tick()
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('a discovery that goes and comes back is not toasted twice', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json', '2.json'] }
  const { seen, tick } = engine(on, files)
  await $.session.start({ cwd: '/session' } as never)

  files['run-a'] = ['1.json']
  await tick()
  files['run-a'] = ['1.json', '2.json']
  await tick()
  expect(seen.toasts).toEqual([])
  expect(seen.statuses.at(-1)).toBe('2 pending discoveries (newest: run-a/2.json)')
})

test('a folder unreadable at start has an empty baseline, so what it later holds toasts', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json'] }
  const unreadable = { isSo: true }
  const { seen, tick } = engine(on, files, { unreadable })
  await $.session.start({ cwd: '/session' } as never)
  expect(seen.statuses).toEqual([])

  unreadable.isSo = false
  await tick()
  expect(seen.toasts).toEqual(['New discovery: run-a/1.json'])
  expect(seen.statuses.at(-1)).toBe('1 pending discovery (newest: run-a/1.json)')
})

test('/discoveries lists each pending discovery with its run, kind, title and body', async ($, on) => {
  const files: Record<string, string[]> = { 'run-a': ['1.json'], 'run-b': ['1.json'] }
  const contents = {
    'run-a/1.json': JSON.stringify({ kind: 'suggestion', title: 'Cache the lookup', body: 'Reads repeat.' }),
    'run-b/1.json': JSON.stringify({ kind: 'correction', title: 'Wrong scope', body: 'The ticket names two seams.' }),
  }
  engine(on, files, { contents })
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe(
    'run-a/1.json — suggestion: Cache the lookup\nReads repeat.\n\nrun-b/1.json — correction: Wrong scope\nThe ticket names two seams.',
  )
})

test('/discoveries says in one line when none are pending', async ($, on) => {
  engine(on, {})
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe('No pending discoveries.')
})

test('/discoveries lists a file that cannot be read or parsed by its path, with a note', async ($, on) => {
  const contents = { 'run-a/2.json': JSON.stringify({ kind: 'suggestion', title: 'Fine', body: 'ok' }), 'run-a/1.json': 'not json' }
  engine(on, { 'run-a': ['1.json', '2.json', '3.json'] }, { contents })
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe(
    [
      'run-a/1.json — could not be read or parsed as a discovery',
      'run-a/2.json — suggestion: Fine\nok',
      'run-a/3.json — could not be read or parsed as a discovery',
    ].join('\n\n'),
  )
})

test('/discoveries lists valid JSON that is not a discovery by its path, and one with no body without a body', async ($, on) => {
  const contents = {
    'run-a/1.json': JSON.stringify({ kind: 'idea', title: 'Unknown kind', body: 'x' }),
    'run-a/2.json': JSON.stringify({ kind: 'suggestion', body: 'No title' }),
    'run-a/3.json': JSON.stringify({ kind: 'correction', title: 'No body' }),
  }
  engine(on, { 'run-a': ['1.json', '2.json', '3.json'] }, { contents })
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe(
    [
      'run-a/1.json — could not be read or parsed as a discovery',
      'run-a/2.json — could not be read or parsed as a discovery',
      'run-a/3.json — correction: No body',
    ].join('\n\n'),
  )
})

test('/discoveries orders a run\'s files by number, so 2.json comes before 10.json', async ($, on) => {
  const doc = (title: string) => JSON.stringify({ kind: 'suggestion', title, body: '.' })
  const contents = { 'run-a/2.json': doc('Second'), 'run-a/10.json': doc('Tenth') }
  engine(on, { 'run-a': ['10.json', '2.json'] }, { contents })
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe('run-a/2.json — suggestion: Second\n.\n\nrun-a/10.json — suggestion: Tenth\n.')
})

test('/discoveries says there is no manager home to read outside one', async ($, on) => {
  engine(on, {}, { unreadable: { isSo: true }, isHome: false })
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe('There is no manager home to read discoveries from.')
})

test('/discoveries says none are pending in a manager home with no discoveries folder', async ($, on) => {
  engine(on, {}, { unreadable: { isSo: true } })
  await $.session.start({ cwd: '/session' } as never)

  const out = await $.command.run({ command: 'discoveries' })
  expect(out.text).toBe('No pending discoveries.')
})

test('the discoveries folder is read from SIDE_PROJECTS_MANAGER_HOME when it is set', async ($, on) => {
  const { listed } = engine(on, { 'run-a': ['1.json'] }, { home: '/elsewhere/home' })
  await $.session.start({ cwd: '/session' } as never)

  expect(listed).toContain('/elsewhere/home/discoveries')
})

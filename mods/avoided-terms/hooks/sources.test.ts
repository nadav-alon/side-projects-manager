import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { vocabularySources, type Engine } from './sources.ts'
import { usesIn } from './vocabulary.ts'
import { ghWrites } from './writes.ts'

interface Fake {
  engine: Engine
  ran: string[][]
}

/** An engine whose processes answer from `answers`, keyed by the command's first two words, and whose files are `files`. */
function fake(answers: Record<string, { exitCode: number; stdout: string }>, files: Record<string, string>): Fake {
  const ran: string[][] = []
  return {
    ran,
    engine: {
      session: { cwd: async () => '/home/manager' },
      fs: { read: async path => files[path] ?? null },
      process: {
        run: async argv => {
          ran.push(argv)
          return answers[argv.slice(0, 2).join(' ')] ?? { exitCode: 1, stdout: '' }
        },
      },
    },
  }
}

const ANSWERS = {
  'sh -c': { exitCode: 0, stdout: '\n/work\n/home/me' },
  'gh repo': { exitCode: 0, stdout: 'acme/Manager\n' },
  'printenv GH_REPO': { exitCode: 1, stdout: '' },
}
const FILES = {
  '/home/manager/CONTEXT.md': '**Alert**:\nx\n_Avoid_: config\n',
  '/work/acme/Home/CONTEXT.md': '**Alert**:\nx\n_Avoid_: widget\n',
}

describe('vocabularySources', () => {
  it('reads the managed location, the session repo and GH_REPO through the shell', async () => {
    const { engine, ran } = fake(ANSWERS, FILES)
    const from = vocabularySources(engine, '/opt/manager')
    assert.equal(await from.managed(), '/work')
    assert.equal(await from.session(), 'acme/Manager')
    assert.equal(await from.environment(), null)
    assert.deepEqual(ran, [['sh', '-c', ran[0]![2]!], ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], ['printenv', 'GH_REPO']])
    assert.match(ran[0]![2]!, /SIDE_PROJECTS_MANAGER_HOME.*SIDE_PROJECTS_MANAGED_LOCATION.*HOME/)
  })

  it('falls back to HOME, then the checkout root, for the managed location', async () => {
    const home = fake({ 'sh -c': { exitCode: 0, stdout: '\n\n/home/me' } }, {})
    assert.equal(await vocabularySources(home.engine, '/opt/manager').managed(), '/home/me/side-projects')
    const none = fake({ 'sh -c': { exitCode: 0, stdout: '\n\n' } }, {})
    assert.equal(await vocabularySources(none.engine, '/opt/manager').managed(), '/opt/manager/side-projects')
  })

  it('rejects when the session repo cannot be read, and maps an unreadable file to null', async () => {
    const { engine } = fake({}, {})
    const from = vocabularySources(engine, '/opt/manager')
    await assert.rejects(from.session())
    assert.equal(await from.read('/nowhere'), null)
  })

  it('drives a write to another repo end to end', async () => {
    const { engine } = fake(ANSWERS, FILES)
    const writes = ghWrites('gh issue comment https://github.com/acme/Home/issues/5 --body "a widget"')
    assert.deepEqual((await usesIn(writes, vocabularySources(engine, '/opt/manager'))).map(use => use.avoided), ['widget'])
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { repoSlug, type RepoSlug } from './repo.ts'
import { absolutePath } from './switcher.ts'
import { usesIn, type VocabularySources } from './vocabulary.ts'
import { ghWrites } from './writes.ts'

const glossary = (avoided: string) => `**Alert**:\nx\n_Avoid_: ${avoided}\n`

const sources = (files: Record<string, string>, over: Partial<VocabularySources> = {}): VocabularySources => ({
  cwd: async () => '/home/manager',
  managed: async () => absolutePath('/work'),
  session: async () => repoSlug('acme/Manager'),
  environment: async () => null,
  read: async path => files[path] ?? null,
  ...over,
})

const FILES = {
  '/home/manager/CONTEXT.md': glossary('config'),
  '/work/acme/Home/CONTEXT.md': glossary('widget'),
}

/** The terms `command`'s text uses, whichever of `config` and `widget` it says. */
const avoided = async (command: string, from: VocabularySources, trail = { moved: false }) =>
  (await usesIn(ghWrites(`${command} --body "config widget"`, trail), from)).map(use => use.avoided)

const slug = (value: string): RepoSlug => repoSlug(value)

describe('usesIn', () => {
  it("checks a write naming no repo against the session's CONTEXT.md", async () => {
    assert.deepEqual(await avoided('gh issue create', sources(FILES)), ['config'])
  })

  it("checks a write naming another repo against that repo's clone, under the slug as written", async () => {
    assert.deepEqual(await avoided('gh issue create -R acme/Home', sources(FILES)), ['widget'])
    assert.deepEqual(await avoided('gh issue create -R acme/home', sources(FILES)), [])
  })

  it("keeps the session's own vocabulary for a write naming the session's repo, in any case", async () => {
    assert.deepEqual(await avoided('gh issue create -R ACME/manager', sources(FILES)), ['config'])
  })

  it('checks a write by the repo an issue URL, GH_REPO= or GH_REPO in the environment names', async () => {
    assert.deepEqual(await avoided('gh issue comment https://github.com/acme/Home/issues/5', sources(FILES)), ['widget'])
    assert.deepEqual(await avoided('GH_REPO=acme/Home gh issue create', sources(FILES)), ['widget'])
    assert.deepEqual(await avoided('gh issue create', sources(FILES, { environment: async () => slug('acme/Home') })), ['widget'])
  })

  it('leaves a write unchecked when the shell has moved, so the repo it writes to is unknown', async () => {
    assert.deepEqual(await avoided('cd /work/acme/Home && gh issue create', sources(FILES)), [])
    const trail = { moved: false }
    await avoided('cd /work/acme/Home', sources(FILES), trail)
    assert.deepEqual(await avoided('gh issue create', sources(FILES), trail), [])
  })

  it('leaves a write unchecked when the other repo has no clone or no CONTEXT.md', async () => {
    assert.deepEqual(await avoided('gh issue create -R acme/other', sources(FILES)), [])
    assert.deepEqual(await avoided('gh issue create -R acme/Home', sources({}, { read: async () => { throw new Error('gone') } })), [])
  })

  it("checks each write against its own repo's vocabulary", async () => {
    const writes = ghWrites('gh issue create -R acme/Home --body widget && gh issue create --body "widget config"')
    assert.deepEqual((await usesIn(writes, sources(FILES))).map(use => use.avoided), ['widget', 'config'])
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { termsForCommand, type VocabularySources } from './vocabulary.ts'

const glossary = (avoided: string) => `**Alert**:\nx\n_Avoid_: ${avoided}\n`

const sources = (files: Record<string, string>, over: Partial<VocabularySources> = {}): VocabularySources => ({
  cwd: async () => '/home/manager',
  managed: async () => '/work',
  sessionRepo: async () => 'acme/manager',
  read: async path => files[path] ?? null,
  ...over,
})

const FILES = {
  '/home/manager/CONTEXT.md': glossary('config'),
  '/work/acme/home/CONTEXT.md': glossary('widget'),
}

const avoided = async (command: string, from: VocabularySources) => (await termsForCommand(command, from)).map(t => t.avoided)

describe('termsForCommand', () => {
  it("checks a command naming no repo against the session's CONTEXT.md", async () => {
    assert.deepEqual(await avoided('gh issue create --body x', sources(FILES)), ['config'])
  })

  it("checks a command naming another repo against that repo's clone", async () => {
    assert.deepEqual(await avoided('gh issue create -R acme/home --body x', sources(FILES)), ['widget'])
  })

  it("keeps the session's own vocabulary for a command naming the session's repo", async () => {
    assert.deepEqual(await avoided('gh issue create -R Acme/Manager --body x', sources(FILES)), ['config'])
  })

  it('leaves a command unchecked when the other repo has no clone or no CONTEXT.md', async () => {
    assert.deepEqual(await avoided('gh issue create -R acme/other --body x', sources(FILES)), [])
    assert.deepEqual(await avoided('gh issue create -R acme/home --body x', sources({}, { read: async () => { throw new Error('gone') } })), [])
  })

  it('leaves it unchecked when the managed location is unknown', async () => {
    assert.deepEqual(await avoided('gh issue create -R acme/home --body x', sources(FILES, { managed: async () => null })), [])
  })
})

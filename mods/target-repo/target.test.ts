import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ghRepoPrefix, movesShell, targetRepo } from './target.ts'

const sources = (over: Partial<Parameters<typeof targetRepo<string>>[0]> = {}) => ({
  prefix: null,
  moved: false,
  environment: async () => null,
  session: async () => 'acme/session',
  ...over,
})

describe('targetRepo', () => {
  it('prefers the command prefix over the environment and the session', async () => {
    const repo = await targetRepo(sources({ prefix: 'acme/prefix', environment: async () => 'acme/env' }))
    assert.equal(repo, 'acme/prefix')
  })

  it('prefers the environment over the session', async () => {
    assert.equal(await targetRepo(sources({ environment: async () => 'acme/env' })), 'acme/env')
  })

  it('falls back to the session', async () => {
    assert.equal(await targetRepo(sources()), 'acme/session')
  })

  it('is unknown after a cd, unless the prefix or environment names a repo', async () => {
    assert.equal(await targetRepo(sources({ moved: true })), null)
    assert.equal(await targetRepo(sources({ moved: true, environment: async () => 'acme/env' })), 'acme/env')
    assert.equal(await targetRepo(sources({ moved: true, prefix: 'acme/prefix' })), 'acme/prefix')
  })

  it('rejects when the session is needed and cannot be read, but not when it is not needed', async () => {
    const broken = async (): Promise<never> => {
      throw new Error('no remote')
    }
    await assert.rejects(targetRepo(sources({ session: broken })), /no remote/)
    assert.equal(await targetRepo(sources({ session: broken, moved: true })), null)
    assert.equal(await targetRepo(sources({ session: broken, prefix: 'acme/prefix' })), 'acme/prefix')
  })

  it('goes on to the session when the environment cannot be asked', async () => {
    const broken = async (): Promise<never> => {
      throw new Error('no printenv')
    }
    assert.equal(await targetRepo(sources({ environment: broken })), 'acme/session')
  })
})

describe('ghRepoPrefix', () => {
  it('reads the GH_REPO assignment among the leading assignments', () => {
    assert.equal(ghRepoPrefix(['A=1', 'GH_REPO=acme/x', 'gh', 'issue']), 'acme/x')
  })

  it('ignores an assignment after the command word, and a command with none', () => {
    assert.equal(ghRepoPrefix(['gh', 'GH_REPO=acme/x']), null)
    assert.equal(ghRepoPrefix(['gh', 'issue']), null)
  })
})

describe('movesShell', () => {
  it('is true for cd, pushd and popd, after any assignments', () => {
    for (const words of [['cd', '..'], ['pushd', 'x'], ['popd'], ['A=1', 'cd', 'x']]) assert.equal(movesShell(words), true)
  })

  it('is false for other commands', () => {
    assert.equal(movesShell(['gh', 'issue', 'create']), false)
  })
})

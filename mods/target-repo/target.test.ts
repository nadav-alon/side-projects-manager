import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { changesEnvironment, commandWordIndex, environmentRepo, movesShell, prefixRepo, targetRepo, walkCommands } from './target.ts'

const sources = (over: Partial<Parameters<typeof targetRepo<string>>[0]> = {}) => ({
  prefixRepo: null,
  moved: false,
  environmentChanged: false,
  environment: async () => null,
  session: async () => 'acme/session',
  ...over,
})

describe('targetRepo', () => {
  it('prefers the command prefix over the environment and the session', async () => {
    const repo = await targetRepo(sources({ prefixRepo: 'acme/prefix', environment: async () => 'acme/env' }))
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
    assert.equal(await targetRepo(sources({ moved: true, prefixRepo: 'acme/prefix' })), 'acme/prefix')
  })

  it('is unknown for an unknown prefix, even with an environment', async () => {
    assert.equal(await targetRepo(sources({ prefixRepo: 'unknown', environment: async () => 'acme/env' })), null)
  })

  it('is unknown after the environment changed, unless the prefix names a repo', async () => {
    assert.equal(await targetRepo(sources({ environmentChanged: true, environment: async () => 'acme/env' })), null)
    assert.equal(await targetRepo(sources({ environmentChanged: true, prefixRepo: 'acme/prefix' })), 'acme/prefix')
  })

  it('rejects when the session is needed and cannot be read, but not when it is not needed', async () => {
    const broken = async (): Promise<never> => {
      throw new Error('no remote')
    }
    await assert.rejects(targetRepo(sources({ session: broken })), /no remote/)
    assert.equal(await targetRepo(sources({ session: broken, moved: true })), null)
    assert.equal(await targetRepo(sources({ session: broken, prefixRepo: 'acme/prefix' })), 'acme/prefix')
  })

  it('goes on to the session when the environment cannot be asked', async () => {
    const broken = async (): Promise<never> => {
      throw new Error('no printenv')
    }
    assert.equal(await targetRepo(sources({ environment: broken })), 'acme/session')
  })
})

const parse = (value: string) => { const slug = value.split('/').slice(-2).join('/'); return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null }

describe('prefixRepo', () => {
  it('reads the GH_REPO assignment among the leading assignments', () => {
    assert.equal(prefixRepo(['A=1', 'GH_REPO=acme/x', 'gh', 'issue'], parse), 'acme/x')
  })

  it('strips a host', () => {
    assert.equal(prefixRepo(['GH_REPO=github.com/acme/x', 'gh'], parse), 'acme/x')
  })

  it('reads an assignment after a leading env', () => {
    assert.equal(prefixRepo(['env', 'GH_REPO=acme/x', 'gh'], parse), 'acme/x')
  })

  it('is unknown for an env with options', () => {
    assert.equal(prefixRepo(['env', '-u', 'GH_REPO', 'gh'], parse), 'unknown')
  })

  it('ignores an assignment after the command word, and a command with none', () => {
    assert.equal(prefixRepo(['gh', 'GH_REPO=acme/x'], parse), null)
    assert.equal(prefixRepo(['gh', 'issue'], parse), null)
  })

  it('is unknown for an empty or invalid value', () => {
    assert.equal(prefixRepo(['GH_REPO=', 'gh'], parse), 'unknown')
    assert.equal(prefixRepo(['GH_REPO=garbage', 'gh'], parse), 'unknown')
  })
})

describe('commandWordIndex', () => {
  it('skips leading assignments', () => {
    assert.equal(commandWordIndex(['A=1', 'B=2', 'gh']), 2)
    assert.equal(commandWordIndex(['A=1']), 1)
  })
})

describe('changesEnvironment', () => {
  it('is true for an export, unset or bare assignment of GH_REPO', () => {
    for (const words of [['export', 'GH_REPO=a/b'], ['unset', 'GH_REPO'], ['declare', '-x', 'GH_REPO=a/b'], ['GH_REPO=a/b']]) {
      assert.equal(changesEnvironment(words), true)
    }
  })

  it('is false for other commands and other variables', () => {
    assert.equal(changesEnvironment(['export', 'FOO=1']), false)
    assert.equal(changesEnvironment(['gh', 'issue']), false)
    assert.equal(changesEnvironment(['GH_REPO=a/b', 'gh']), false)
  })
})

describe('walkCommands', () => {
  it('hands each command its prefix and what ran before it', () => {
    const seen = walkCommands([['export', 'GH_REPO=a/b'], ['cd', 'x'], ['GH_REPO=c/d', 'gh']], parse, (words, context) => ({ words: words.length, ...context }))
    assert.deepEqual(seen.map(({ prefixRepo, moved, environmentChanged }) => [prefixRepo, moved, environmentChanged]), [
      [null, false, false],
      [null, false, true],
      ['c/d', true, true],
    ])
  })
})

describe('walkCommands, across calls', () => {
  it('carries a cd from one call to the next through the trail', () => {
    const trail = { moved: false }
    const moved = () => (_words: readonly string[], context: { moved: boolean }) => context.moved
    assert.deepEqual(walkCommands([['ls']], parse, moved(), trail), [false])
    assert.deepEqual(walkCommands([['cd', 'x']], parse, moved(), trail), [false])
    assert.deepEqual(walkCommands([['gh']], parse, moved(), trail), [true])
    assert.equal(trail.moved, true)
  })
})

describe('environmentRepo', () => {
  it('reads and parses GH_REPO, host and all', async () => {
    assert.equal(await environmentRepo(async () => ({ exitCode: 0, stdout: 'github.com/acme/x\n' }), parse), 'acme/x')
  })

  it('is null when unset or invalid', async () => {
    assert.equal(await environmentRepo(async () => ({ exitCode: 1, stdout: '' }), parse), null)
    assert.equal(await environmentRepo(async () => ({ exitCode: 0, stdout: 'garbage' }), parse), null)
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

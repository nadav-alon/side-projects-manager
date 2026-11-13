import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ghWrites } from './writes.ts'

const only = (command: string) => {
  const [write, ...rest] = ghWrites(command)
  assert.equal(rest.length, 0, command)
  assert.ok(write, command)
  return write
}

describe('ghWrites', () => {
  it('keeps the title and body values, not the other flags', () => {
    const write = only('gh issue edit 12 --add-label ready --title "Each run" -b \'a session\' --repo o/run')
    assert.equal(write.text, 'Each run\na session')
  })

  it('finds no write in a command that is not an issue or pull request write', () => {
    assert.deepEqual(ghWrites('gh issue list --repo o/r && echo "gh issue create"'), [])
  })

  it('reads the repo of --repo and -R in each spelling', () => {
    for (const flags of ['--repo acme/Widgets', '--repo=acme/Widgets', '-R acme/Widgets', '-R=acme/Widgets', '-Racme/Widgets', '-R "acme/Widgets"', '-R https://github.com/acme/Widgets']) {
      assert.equal(only(`gh issue comment 5 ${flags} --body hi`).repo, 'acme/Widgets', flags)
    }
  })

  it('drops a host', () => {
    assert.equal(only('gh issue create -R github.com/acme/widgets').repo, 'acme/widgets')
  })

  it('reads the repo an issue or pull request URL names', () => {
    assert.equal(only('gh issue comment https://github.com/o/r/issues/5 --body x').repo, 'o/r')
    assert.equal(only('gh pr comment https://github.com/o/r/pull/5 --body x').repo, 'o/r')
  })

  it('prefers the flag over a URL', () => {
    assert.equal(only('gh issue comment https://github.com/o/r/issues/5 -R a/b --body x').repo, 'a/b')
  })

  it('names no repo without a flag or URL, or with a flag value that is no repo', () => {
    assert.equal(only('gh issue create --title "see -R later"').repo, null)
    assert.equal(only('gh issue create -R nonsense').repo, null)
  })

  it('does not read -R or --repo inside a body or title value as the target', () => {
    assert.equal(only('gh issue comment 5 --body "use -R acme/x"').repo, null)
    assert.equal(only('gh issue comment 5 --title "pass --repo acme/x" --body "see https://github.com/acme/x/issues/1"').repo, null)
  })

  it('carries a GH_REPO prefix and a cd in its context', () => {
    assert.equal(only('GH_REPO=o/r gh issue create --body x').context.prefixRepo, 'o/r')
    assert.equal(ghWrites('cd ../clone && gh issue create --body x')[0]?.context.moved, true)
  })

  it('remembers a cd across calls in the trail', () => {
    const trail = { moved: false }
    ghWrites('cd ../clone', trail)
    assert.equal(ghWrites('gh issue create --body x', trail)[0]?.context.moved, true)
  })
})

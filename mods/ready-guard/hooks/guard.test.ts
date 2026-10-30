import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { checkReadyLabel, issueRef, repoSlug, type IssueRef, type RepoSlug, type Tracker } from './guard.ts'

const REPO = repoSlug('acme/pilot')

/** A fake tracker holding one ticket's body and its linked blockers. */
function fakeTracker(body: string, linked: IssueRef[] = [], environment: RepoSlug | null = null): Tracker {
  return {
    async currentRepo() {
      return REPO
    },
    async environmentRepo() {
      return environment
    },
    async body() {
      return body
    },
    async linkedBlockers() {
      return linked
    },
  }
}

/** A tracker that cannot be read at all. */
function unreadableTracker(message = 'unread'): Tracker {
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }
  return { currentRepo: fail, environmentRepo: fail, body: fail, linkedBlockers: fail }
}

/** The text that denies `command`, or null when it runs; a warning fails the test. */
async function denyReadyLabel(command: string, tracker: Tracker): Promise<string | null> {
  const verdict = await checkReadyLabel(command, tracker)
  assert.notEqual(verdict.kind, 'warn')
  return verdict.kind === 'deny' ? verdict.reason : null
}

const ADD = 'gh issue edit 7 --add-label ready-for-agent'

describe('checkReadyLabel, denials', () => {
  it('denies a ticket whose Blocked by names unlinked issues, naming the missing links', async () => {
    const tracker = fakeTracker('## Blocked by\n\n- #3\n- #4\n', [issueRef(`${REPO}#4`)])
    const denial = await denyReadyLabel(ADD, tracker)
    assert.match(denial ?? '', /acme\/pilot#7/)
    assert.match(denial ?? '', /acme\/pilot#3/)
    assert.doesNotMatch(denial ?? '', /acme\/pilot#4/)
    assert.match(denial ?? '', /Link them first/)
  })

  it('reads the repo, and a blocker in another repo, as written', async () => {
    const tracker = fakeTracker('Blocked by: other/lib#9', [])
    const denial = await denyReadyLabel(`gh issue edit 7 --repo=x/y --add-label bug,ready-for-agent`, tracker)
    assert.match(denial ?? '', /x\/y#7/)
    assert.match(denial ?? '', /other\/lib#9/)
  })
})

describe('checkReadyLabel, gh issue create', () => {
  it('denies a create that adds ready-for-agent, whatever its body says, without reading the tracker', async () => {
    for (const command of [
      "gh issue create --title t --label ready-for-agent --body 'x'",
      'gh issue create -t t -l bug,ready-for-agent --body-file -',
      'gh issue create --label=ready-for-agent -R x/y',
      'gh issue create -lready-for-agent',
    ]) {
      const verdict = await checkReadyLabel(command, unreadableTracker())
      assert.equal(verdict.kind, 'deny', command)
      assert.match(verdict.kind === 'deny' ? verdict.reason : '', /unlabelled, link its blockers, then add ready-for-agent/)
    }
  })

  it('lets a create without the label run', async () => {
    for (const command of [
      "gh issue create --title t --label bug --body 'ready-for-agent'",
      'gh issue create --title ready-for-agent',
    ]) {
      assert.deepEqual(await checkReadyLabel(command, unreadableTracker()), { kind: 'allow' }, command)
    }
  })
})

describe('checkReadyLabel, calls that run untouched', () => {
  it('lets a ticket through whose named blockers are all linked', async () => {
    const tracker = fakeTracker('## Blocked by\n\n- #3\n- other/lib#9\n', [issueRef(`${REPO}#3`), issueRef('other/lib#9')])
    assert.equal(await denyReadyLabel(ADD, tracker), null)
  })

  it('lets a ticket through whose Blocked by says none', async () => {
    assert.equal(await denyReadyLabel(ADD, fakeTracker('## What\n\nx\n\n## Blocked by\n\nNone - can start immediately.\n')), null)
  })

  it('lets a ticket with no Blocked by through', async () => {
    assert.equal(await denyReadyLabel(ADD, fakeTracker('## What\n\nsee #12\n')), null)
  })

  it('leaves unrelated shell calls alone without reading the tracker', async () => {
    for (const command of [
      'ls -la',
      'gh issue edit 7 --add-label bug',
      'gh issue edit 7 --remove-label ready-for-agent',
      'gh issue view 7',
      'echo ready-for-agent',
    ]) {
      assert.deepEqual(await checkReadyLabel(command, unreadableTracker()), { kind: 'allow' }, command)
    }
  })
})

describe('checkReadyLabel, verdicts', () => {
  it('denies with the reason', async () => {
    const verdict = await checkReadyLabel(ADD, fakeTracker('Blocked by: #3'))
    assert.equal(verdict.kind, 'deny')
    const reason = verdict.kind === 'deny' ? verdict.reason : ''
    assert.match(reason, /acme\/pilot#3/)
    assert.match(reason, /Link them first/)
  })

  it('runs with a warning when the tracker cannot be read', async () => {
    const verdict = await checkReadyLabel(ADD, unreadableTracker('gh: HTTP 502'))
    assert.equal(verdict.kind, 'warn')
    assert.match(verdict.kind === 'warn' ? verdict.warning : '', /HTTP 502/)
  })
})

describe('checkReadyLabel, spellings of the call', () => {
  const blocked = fakeTracker('Blocked by: #3')

  async function isDenied(command: string): Promise<boolean> {
    return (await checkReadyLabel(command, blocked)).kind === 'deny'
  }

  it('reads an issue URL, and the repo in it', async () => {
    const denial = await denyReadyLabel('gh issue edit https://github.com/o/r/issues/7 --add-label ready-for-agent', blocked)
    assert.match(denial ?? '', /o\/r#7/)
  })

  it('checks every issue argument', async () => {
    const denial = await denyReadyLabel('gh issue edit 7 8 --add-label ready-for-agent', blocked)
    assert.match(denial ?? '', /acme\/pilot#7/)
    assert.match(denial ?? '', /acme\/pilot#8/)
  })

  it('checks each command of a chain', async () => {
    assert.equal(await isDenied('gh issue edit 7 --add-label bug && gh issue edit 8 --add-label ready-for-agent'), true)
    assert.equal(await isDenied('gh issue edit 7 --remove-label x; gh issue edit 8 --add-label ready-for-agent'), true)
    assert.equal(await isDenied('echo hi\ngh issue edit 8 --add-label ready-for-agent'), true)
  })

  it('skips the values of other flags to find the issue', async () => {
    const denial = await denyReadyLabel('gh issue edit --milestone 2 --title "a b" 7 --add-label ready-for-agent', blocked)
    assert.match(denial ?? '', /acme\/pilot#7/)
    assert.doesNotMatch(denial ?? '', /#2/)
  })

  it('reads the repo as an attached short value, or as HOST/OWNER/REPO', async () => {
    assert.match((await denyReadyLabel('gh issue edit -Rx/y 7 --add-label ready-for-agent', blocked)) ?? '', /x\/y#7/)
    assert.match((await denyReadyLabel('gh issue edit -R github.com/x/y 7 --add-label ready-for-agent', blocked)) ?? '', /x\/y#7/)
  })

  it('trims the labels', async () => {
    assert.equal(await isDenied('gh issue edit 7 --add-label "bug, ready-for-agent"'), true)
  })
})

describe('checkReadyLabel, blockers as written', () => {
  it('reads a blocker given as an issue URL', async () => {
    const denial = await denyReadyLabel(ADD, fakeTracker('Blocked by: https://github.com/o/r/issues/5'))
    assert.match(denial ?? '', /o\/r#5/)
  })

  it('compares owner and repo names without case', async () => {
    const tracker = fakeTracker('Blocked by: #5, Other/Lib#9', [issueRef('acme/pilot#5'), issueRef('other/lib#9')])
    assert.equal(await denyReadyLabel('gh issue edit -R Acme/Pilot 7 --add-label ready-for-agent', tracker), null)
  })

  it('does not count #0 as a blocker', async () => {
    assert.equal(await denyReadyLabel(ADD, fakeTracker('Blocked by: #0')), null)
  })
})

describe('checkReadyLabel, the repo of a call naming none', () => {
  const ELSEWHERE = repoSlug('acme/elsewhere')
  const blocked = (environment: RepoSlug | null = null) => fakeTracker('Blocked by: #3', [], environment)

  it('reads the command\'s own GH_REPO= prefix over the environment and the session', async () => {
    const denial = await denyReadyLabel(`GH_REPO=${ELSEWHERE} ${ADD}`, blocked(repoSlug('acme/env')))
    assert.match(denial ?? '', /acme\/elsewhere#7/)
  })

  it('reads GH_REPO in the environment over the session', async () => {
    assert.match((await denyReadyLabel(ADD, blocked(ELSEWHERE))) ?? '', /acme\/elsewhere#7/)
  })

  it('lets an explicit --repo win over GH_REPO', async () => {
    const denial = await denyReadyLabel(`GH_REPO=${ELSEWHERE} gh issue edit 7 -R x/y --add-label ready-for-agent`, blocked())
    assert.match(denial ?? '', /x\/y#7/)
  })

  it('denies after a cd, asking for --repo', async () => {
    const denial = await denyReadyLabel(`cd ../other && ${ADD}`, blocked())
    assert.match(denial ?? '', /--repo/)
    assert.doesNotMatch(denial ?? '', /acme\/pilot/)
  })

  it('still reads GH_REPO after a cd', async () => {
    const denial = await denyReadyLabel(`cd ../other && ${ADD}`, blocked(ELSEWHERE))
    assert.match(denial ?? '', /acme\/elsewhere#7/)
  })

  it('strips a host from GH_REPO, in the prefix and in the environment', async () => {
    assert.match((await denyReadyLabel(`GH_REPO=github.com/acme/elsewhere ${ADD}`, blocked())) ?? '', /acme\/elsewhere#7/)
  })

  it('denies after a cd inside a subshell', async () => {
    assert.match((await denyReadyLabel(`(cd ../other && ${ADD})`, blocked())) ?? '', /--repo/)
  })

  it('reads GH_REPO after an env prefix, and denies after an export of it', async () => {
    assert.match((await denyReadyLabel(`env GH_REPO=${ELSEWHERE} ${ADD}`, blocked())) ?? '', /acme\/elsewhere#7/)
    assert.match((await denyReadyLabel(`export GH_REPO=${ELSEWHERE} && ${ADD}`, blocked(repoSlug('acme/env')))) ?? '', /--repo/)
  })

  it('denies when the GH_REPO= prefix is invalid or empty, whatever the environment', async () => {
    for (const prefix of ['GH_REPO=garbage', 'GH_REPO=']) {
      assert.match((await denyReadyLabel(`${prefix} ${ADD}`, blocked(ELSEWHERE))) ?? '', /--repo/)
    }
  })

  it('does not deny a cd with no ready-for-agent edit after it', async () => {
    assert.equal(await denyReadyLabel('cd ../other && gh issue view 7', blocked()), null)
  })
})

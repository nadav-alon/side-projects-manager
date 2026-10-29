import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { denyReadyLabel, issueRef, type IssueRef, type Tracker } from './guard.ts'

const REPO = 'acme/pilot'

/** A fake tracker holding one ticket's body and its linked blockers. */
function fakeTracker(body: string, linked: IssueRef[] = []): Tracker {
  return {
    async currentRepo() {
      return REPO
    },
    async body() {
      return body
    },
    async linkedBlockers() {
      return linked
    },
  }
}

const ADD = 'gh issue edit 7 --add-label ready-for-agent'

describe('denyReadyLabel', () => {
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

describe('denyReadyLabel, calls that run untouched', () => {
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
    const tracker = fakeTracker('## Blocked by\n\n- #3\n')
    for (const command of [
      'ls -la',
      'gh issue edit 7 --add-label bug',
      'gh issue edit 7 --remove-label ready-for-agent',
      'gh issue view 7',
      'echo ready-for-agent',
    ]) {
      assert.equal(await denyReadyLabel(command, tracker), null, command)
    }
  })
})

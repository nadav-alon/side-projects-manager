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

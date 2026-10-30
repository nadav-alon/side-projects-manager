import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REMINDER, repoSlug, sizingReminder, THIS_REPO } from './reminder.ts'

const OTHER = repoSlug('acme/pilot')

/** The reminder `command` earns when the shell runs in `cwdRepo`. */
const remind = (command: string, cwdRepo = THIS_REPO) => sizingReminder(command, async () => cwdRepo)

describe('sizingReminder, in this repo', () => {
  for (const command of [
    'gh issue create --title "x" --body "y"',
    'gh issue edit 7 --add-label size:L',
    'gh issue edit 7 --add-label bug,size:M',
    'gh issue edit 7 --add-label=size:XL',
    'gh issue create --repo nadav-alon/side-projects-manager --title x',
    'gh issue edit 7 -R github.com/Nadav-Alon/Side-Projects-Manager --add-label size:S',
    'git status && gh issue create -t x',
  ]) {
    it(`reminds on: ${command}`, async () => {
      assert.equal(await remind(command), REMINDER)
    })
  }

  it('reminds on a call naming this repo while the shell runs in another', async () => {
    assert.equal(await remind('gh issue create -R nadav-alon/side-projects-manager -t x', OTHER), REMINDER)
  })
})

describe('sizingReminder, carrying nothing', () => {
  for (const command of [
    'gh issue create --repo acme/pilot --title x',
    'gh issue edit 7 -R acme/pilot --add-label size:L',
    'gh issue edit 7 --add-label bug',
    'gh issue edit 7 --body "size:M"',
    'gh issue view 7',
    'gh issue list --label size:M',
  ]) {
    it(`stays silent on: ${command}`, async () => {
      assert.equal(await remind(command), null)
    })
  }

  it('stays silent in another repo when the call names none', async () => {
    assert.equal(await remind('gh issue create -t x', OTHER), null)
  })

  it('stays silent when the current repo cannot be read', async () => {
    const unread = async () => {
      throw new Error('no remote')
    }
    assert.equal(await sizingReminder('gh issue create -t x', unread), null)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REMINDER, foldedRepoSlug, sizingReminder, THIS_REPO } from './reminder.ts'

const OTHER = foldedRepoSlug('acme/pilot')

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
    'gh -R nadav-alon/side-projects-manager issue create -t x',
    'gh issue \\\ncreate -t x',
    'gh issue edit 7 \\\n--add-label size:M',
    '(gh issue create -t x)',
    'gh issue edit 7 --add-label Size:M',
    'GH_REPO=nadav-alon/side-projects-manager gh issue create -t x',
    'gh issue edit https://github.com/nadav-alon/side-projects-manager/issues/7 --add-label size:M',
  ]) {
    it(`reminds on: ${command}`, async () => {
      assert.equal(await remind(command), REMINDER)
    })
  }

  it('reminds on a call naming this repo from another repo by GH_REPO or an issue URL', async () => {
    assert.equal(await remind('GH_REPO=nadav-alon/side-projects-manager gh issue create -t x', OTHER), REMINDER)
    assert.equal(await remind('gh issue edit https://github.com/nadav-alon/side-projects-manager/issues/7 --add-label size:M', OTHER), REMINDER)
  })

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
    'echo gh issue create',
    'sudo -u x echo gh issue create',
    'git log # gh issue create',
    'cd ../pilot && gh issue create -t x',
    'GH_REPO=acme/pilot gh issue create -t x',
    'gh issue edit https://github.com/acme/pilot/issues/7 --add-label size:M',
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

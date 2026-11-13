import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { managerHomeOf, resolveManagerHome } from './home.ts'

const ROOT = '/checkout/mods/loop-pane'

describe('managerHomeOf', () => {
  it('takes the override when it is absolute', () => {
    assert.equal(managerHomeOf('/elsewhere/home', ROOT), '/elsewhere/home')
  })

  it('strips trailing slashes from the override', () => {
    assert.equal(managerHomeOf('/elsewhere/home//', ROOT), '/elsewhere/home')
  })

  it('falls back to the checkout when the override is unset, empty or relative', () => {
    for (const override of ['', '  ', 'relative/home']) assert.equal(managerHomeOf(override, ROOT), '/checkout')
  })

  it('finds the checkout from a plugin root with trailing slashes', () => {
    assert.equal(managerHomeOf('', `${ROOT}/`), '/checkout')
  })
})

describe('resolveManagerHome', () => {
  it('reads the override from the shell', async () => {
    assert.equal(await resolveManagerHome(async () => ({ exitCode: 0, stdout: '/elsewhere/home' }), ROOT), '/elsewhere/home')
  })

  it('falls back to the checkout when the shell exits non-zero', async () => {
    assert.equal(await resolveManagerHome(async () => ({ exitCode: 1, stdout: '/elsewhere/home' }), ROOT), '/checkout')
  })

  it('falls back to the checkout when the shell throws', async () => {
    assert.equal(await resolveManagerHome(async () => { throw new Error('no shell') }, ROOT), '/checkout')
  })
})

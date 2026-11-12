import assert from 'node:assert/strict'
import { it } from 'node:test'

import { locations } from './locations.ts'

it('falls back to the checkout root, not the working directory', () => {
  assert.deepEqual(locations({ HOME: '/home/me' }, '/opt/manager'), { home: '/opt/manager', managed: '/home/me/side-projects' })
})

it('honours the overrides', () => {
  const env = { SIDE_PROJECTS_MANAGER_HOME: '/m', SIDE_PROJECTS_MANAGED_LOCATION: '/p', HOME: '/home/me' }
  assert.deepEqual(locations(env, '/opt/manager'), { home: '/m', managed: '/p' })
})

it('falls back to the manager home, as the manager does, with no HOME', () => {
  assert.equal(locations({}, '/opt/manager').managed, '/opt/manager/side-projects')
})

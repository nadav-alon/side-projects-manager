import { expect, test } from 'claude-code/testing'

import { compactCount, elapsed, issueUrlOf, localTime, percentOf } from './format'
import { isIssueNumber, isRepoSlug } from './manager-home/types.ts'

test('a count that rounds up to a thousand moves to the next unit', () => {
  expect(compactCount(999_950)).toBe('1.0M')
  expect(compactCount(999_960_000)).toBe('1.0B')
  expect(compactCount(999_949)).toBe('999.9K')
  expect(compactCount(2_100_323)).toBe('2.1M')
  expect(compactCount(999)).toBe('999')
})

test('a share is written with the places its size needs', () => {
  expect(percentOf(0, 100)).toBe('0%')
  expect(percentOf(30, 100)).toBe('30%')
  expect(percentOf(5, 100)).toBe('5.0%')
  expect(percentOf(3, 10_000)).toBe('0.03%')
})

test('a span is written in minutes, then hours and minutes, and never negative', () => {
  const at = new Date('2026-06-15T17:30:00Z')
  expect(elapsed(new Date(at.getTime() - 5 * 60_000), at)).toBe('5m')
  expect(elapsed(new Date(at.getTime() - 65 * 60_000), at)).toBe('1h 05m')
  expect(elapsed(new Date(at.getTime() + 60_000), at)).toBe('0m')
})

test('a time is written in the local zone as hours and minutes', () => {
  expect(localTime(new Date(2026, 5, 15, 19, 30))).toBe('19:30')
  expect(localTime(new Date(2026, 5, 15, 7, 5))).toBe('07:05')
})

test('an issue URL is the github.com address of the repo and number', () => {
  const repo = 'o/b'
  const number = 5
  if (!isRepoSlug(repo) || !isIssueNumber(number)) throw new Error('fixture is not a slug and a number')
  expect(issueUrlOf(repo, number)).toBe('https://github.com/o/b/issues/5')
})

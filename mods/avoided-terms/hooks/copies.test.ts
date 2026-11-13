import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

// `locations.ts` is carried here as a byte-identical copy of project-switcher's, so the manager's locations
// are resolved one way in both; it imports `./switcher.ts`, which here holds only the path helpers it needs.
it("carries project-switcher's locations.ts unchanged", () => {
  const original = new URL('../../project-switcher/hooks/locations.ts', import.meta.url)
  assert.ok(readFileSync(new URL('./locations.ts', import.meta.url)).equals(readFileSync(original)))
})

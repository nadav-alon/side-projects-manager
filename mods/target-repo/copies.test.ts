import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// A mod's module may only import files inside its own folder, so a mod resolving the repo a `gh` call
// targets carries a committed copy of `target.ts` in its own `hooks/target-repo/` folder. This test
// keeps every copy byte-identical to the original, finding the carriers by walking `mods/`.

const ORIGINAL = join(import.meta.dirname, 'target.ts')
const MODS = join(import.meta.dirname, '..')
/** The mods that carry a copy of `target.ts`. */
const carriers = () => readdirSync(MODS).filter((mod) => existsSync(join(MODS, mod, 'hooks', 'target-repo')))

describe('the target-repo copies', () => {
  it('are byte-identical to the original in every carrying mod', () => {
    const found = carriers()
    assert.ok(found.length > 0, 'no mod carries a copy of target.ts')
    for (const mod of found) {
      const copy = join(MODS, mod, 'hooks', 'target-repo', 'target.ts')
      assert.ok(existsSync(copy), `${mod} lacks its copy of target.ts`)
      assert.ok(readFileSync(copy).equals(readFileSync(ORIGINAL)), `${mod}'s copy of target.ts differs from the original`)
    }
  })
})

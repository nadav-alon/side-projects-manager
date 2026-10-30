import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// A mod's module may only import files inside its own folder, so a mod resolving the repo a `gh` call
// targets carries a committed copy of `target.ts` in its own `hooks/target-repo/` folder. This test
// keeps every copy byte-identical to the original, and requires every mod that carries one to be
// listed in `CARRIERS`.

const ORIGINAL = join(import.meta.dirname, 'target.ts')
const MODS = join(import.meta.dirname, '..')
const CARRIERS = ['ready-guard', 'size-reminder']

describe('the target-repo copies', () => {
  it('are byte-identical to the original in every carrying mod', () => {
    for (const mod of CARRIERS) {
      const copy = join(MODS, mod, 'hooks', 'target-repo', 'target.ts')
      assert.ok(existsSync(copy), `${mod} lacks its copy of target.ts`)
      assert.ok(readFileSync(copy).equals(readFileSync(ORIGINAL)), `${mod}'s copy of target.ts differs from the original`)
    }
  })

  it('are carried only by the listed mods', () => {
    const found = readdirSync(MODS).filter((mod) => existsSync(join(MODS, mod, 'hooks', 'target-repo')))
    assert.deepEqual(found.sort(), [...CARRIERS].sort())
  })
})

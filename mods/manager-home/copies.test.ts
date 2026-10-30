import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// A mod's module may only import files inside its own folder, so a mod drawing on the manager home
// carries a committed copy of the reader — `reader.ts` and the `types.ts` it imports — in its own
// `hooks/manager-home/` folder. These tests keep every copy byte-identical to the original.

const SOURCE = import.meta.dirname
const MODS = join(SOURCE, '..')
const SHARED = ['reader.ts', 'types.ts']

/** The copies, as `<mod>/hooks/manager-home/<file>`, that differ from, or are missing beside, the originals. */
function driftedCopies(mods: string): string[] {
  const drifted: string[] = []
  for (const mod of readdirSync(mods)) {
    const folder = join(mods, mod, 'hooks', 'manager-home')
    if (mod === 'manager-home' || !existsSync(folder)) continue
    for (const file of SHARED) {
      const copy = join(folder, file)
      if (!existsSync(copy) || readFileSync(copy, 'utf8') !== readFileSync(join(SOURCE, file), 'utf8')) {
        drifted.push(`${mod}/hooks/manager-home/${file}`)
      }
    }
  }
  return drifted
}

describe('the manager-home reader copies', () => {
  it('names a copy that differs from the original or lacks one of its files', () => {
    const mods = mkdtempSync(join(tmpdir(), 'copies-'))
    const folder = join(mods, 'loop-pane', 'hooks', 'manager-home')
    mkdirSync(folder, { recursive: true })
    mkdirSync(join(mods, 'mode-band', 'hooks'), { recursive: true })
    writeFileSync(join(folder, 'reader.ts'), readFileSync(join(SOURCE, 'reader.ts')))
    assert.deepEqual(driftedCopies(mods), ['loop-pane/hooks/manager-home/types.ts'])

    writeFileSync(join(folder, 'types.ts'), '// edited\n')
    assert.deepEqual(driftedCopies(mods), ['loop-pane/hooks/manager-home/types.ts'])

    writeFileSync(join(folder, 'types.ts'), readFileSync(join(SOURCE, 'types.ts')))
    assert.deepEqual(driftedCopies(mods), [])
  })

  it('finds every copy under mods/ identical to the original', () => {
    assert.deepEqual(driftedCopies(MODS), [])
  })
})

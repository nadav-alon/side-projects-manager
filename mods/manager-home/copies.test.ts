import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

// A mod's module may only import files inside its own folder, so a mod drawing on the manager home
// carries a committed copy of the reader — `reader.ts` and the `types.ts` it imports — in its own
// `hooks/manager-home/` folder. These tests keep every copy byte-identical to the original.

const ORIGINALS = import.meta.dirname
const MODS = join(ORIGINALS, '..')
const SHARED = ['reader.ts', 'types.ts']
const HEADER = readFileSync(join(ORIGINALS, 'reader.ts'), 'utf8').split('\n')[0]

/** The copies, as `<mod>/hooks/manager-home/<file>`, that differ from, or are missing beside, the originals. */
function driftedCopies(modsRoot: string): string[] {
  const drifted: string[] = []
  for (const mod of readdirSync(modsRoot)) {
    const folder = join(modsRoot, mod, 'hooks', 'manager-home')
    if (mod === 'manager-home' || !existsSync(folder)) continue
    for (const file of SHARED) {
      const copy = join(folder, file)
      if (!existsSync(copy) || !readFileSync(copy).equals(readFileSync(join(ORIGINALS, file)))) {
        drifted.push(`${mod}/hooks/manager-home/${file}`)
      }
    }
  }
  return drifted
}

/** The files under a mod that open with the reader's header line yet sit outside `<mod>/hooks/manager-home/`. */
function strayCopies(modsRoot: string): string[] {
  const strays: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const relPath = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path, relPath)
      else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').split('\n')[0] === HEADER) strays.push(relPath)
    }
  }
  for (const mod of readdirSync(modsRoot)) {
    if (mod !== 'manager-home' && statSync(join(modsRoot, mod)).isDirectory()) walk(join(modsRoot, mod), mod)
  }
  return strays.filter((path) => !/^[^/]+\/hooks\/manager-home\/[^/]+$/.test(path))
}

describe('the manager-home reader copies', () => {
  const scratch: string[] = []
  after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  })

  it('names a copy that differs from the original or lacks one of its files', () => {
    const mods = mkdtempSync(join(tmpdir(), 'copies-'))
    scratch.push(mods)
    const folder = join(mods, 'loop-pane', 'hooks', 'manager-home')
    mkdirSync(folder, { recursive: true })
    mkdirSync(join(mods, 'mode-band', 'hooks'), { recursive: true })
    writeFileSync(join(folder, 'reader.ts'), readFileSync(join(ORIGINALS, 'reader.ts')))
    assert.deepEqual(driftedCopies(mods), ['loop-pane/hooks/manager-home/types.ts'])

    writeFileSync(join(folder, 'types.ts'), '// edited\n')
    assert.deepEqual(driftedCopies(mods), ['loop-pane/hooks/manager-home/types.ts'])

    writeFileSync(join(folder, 'types.ts'), readFileSync(join(ORIGINALS, 'types.ts')))
    assert.deepEqual(driftedCopies(mods), [])
  })

  it('names a reader copy kept outside the agreed folder', () => {
    const mods = mkdtempSync(join(tmpdir(), 'copies-'))
    scratch.push(mods)
    const hooks = join(mods, 'loop-pane', 'hooks')
    mkdirSync(join(hooks, 'manager-home'), { recursive: true })
    writeFileSync(join(hooks, 'manager-home', 'reader.ts'), readFileSync(join(ORIGINALS, 'reader.ts')))
    writeFileSync(join(hooks, 'reader.ts'), readFileSync(join(ORIGINALS, 'reader.ts')))
    assert.deepEqual(strayCopies(mods), ['loop-pane/hooks/reader.ts'])
  })

  it('finds every copy under mods/ identical to the original', () => {
    assert.deepEqual(driftedCopies(MODS), [])
  })

  it('finds no reader copy under mods/ outside the agreed folder', () => {
    assert.deepEqual(strayCopies(MODS), [])
  })
})

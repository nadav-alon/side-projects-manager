import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/** Stands for the engine beneath the mod: a shell call that reaches it runs and answers ok. */
function engine(on: On): void {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
}

const denied = ['gh pr merge 1 && gh pr merge 2', 'gh pr merge 1; gh pr merge 2', 'gh pr merge 1 | gh pr merge 2',
  'for n in 1 2 3; do gh pr merge $n --squash; done', 'echo 1 2 | xargs -n1 gh pr merge',
  'gh -R o/r pr merge 1 && gh -R o/r pr merge 2']

for (const command of denied) {
  test(`denies: ${command}`, async ($, on) => {
    engine(on)
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toMatch(/one `gh pr merge` per shell call/)
  })
}

const untouched = ['gh pr merge 12 --squash && git pull', 'gh pr merge 1 --body "wait for it, do not rush"',
  'gh pr merge 5 && echo "waiting for CI to do stuff"', 'git log | xargs echo; gh pr merge 3',
  'for f in a b; do echo $f; done; gh pr merge 4', 'echo "gh pr merge 1; gh pr merge 2"',
  'gh pr merge 1 # later gh pr merge 2']

for (const command of untouched) {
  test(`runs untouched: ${command}`, async ($, on) => {
    engine(on)
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toBeUndefined()
    expect(ran.text).toBe('ok')
  })
}

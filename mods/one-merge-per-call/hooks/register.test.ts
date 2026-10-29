import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/** Stands for the engine beneath the mod: a shell call that reaches it runs and answers ok. */
function engine(on: On): void {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
}

const denied = ['gh pr merge 1 && gh pr merge 2', 'gh pr merge 1; gh pr merge 2', 'gh pr merge 1 | gh pr merge 2',
  'for n in 1 2 3; do gh pr merge $n --squash; done', 'echo 1 2 | xargs -n1 gh pr merge']

for (const command of denied) {
  test(`denies: ${command}`, async ($, on) => {
    engine(on)
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny ?? ran.text).toMatch(/one `gh pr merge` per shell call/)
  })
}

test('a single merge runs untouched', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12 --squash && git pull' })
  expect(ran.text ?? JSON.stringify(ran)).not.toMatch(/one `gh pr merge`/)
})

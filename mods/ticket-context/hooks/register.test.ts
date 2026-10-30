import { expect, test, type TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Run = { argv: string[] }

const ISSUE = JSON.stringify({ title: 'Add the thing', body: 'Build it.', labels: [{ name: 'enhancement' }, { name: 'size:M' }] })

/** Stands for the engine beneath the mod: `gh` answers from `answers`, keyed by its argv joined, and the prompt enters. */
function engine(on: On, answers: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>): { runs: string[][] } {
  const seen = { runs: [] as string[][] }
  on('session.cwd', () => ({ value: '/work/repo' }) as never)
  on('process.run', (_$, e) => {
    const { argv } = e as unknown as Run
    seen.runs.push(argv)
    const answer = answers[argv.join(' ')] ?? { exitCode: 1, stderr: 'not found' }
    return { value: { exitCode: 0, stdout: '', stderr: '', ...answer } } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  return seen
}

const ACME_42 = {
  'gh issue view 42 --repo acme/pilot --json title,body,labels': { stdout: ISSUE },
  'gh api --paginate repos/acme/pilot/issues/42/dependencies/blocked_by --jq .[] | (.repository_url | sub(".*/repos/"; "")) + "#" + (.number | tostring)': {
    stdout: 'acme/pilot#7\n',
  },
}

test('a prompt naming owner/repo#n gets that ticket appended', async ($, on) => {
  engine(on, ACME_42)
  const entered = await $.prompt.submit({ text: 'Look at acme/pilot#42 please' })
  expect(entered.text).toBe('Look at acme/pilot#42 please')
  const context = entered.context?.join('\n') ?? ''
  expect(context).toMatch(/acme\/pilot#42: Add the thing/)
  expect(context).toMatch(/Labels: enhancement, size:M/)
  expect(context).toMatch(/Blocked by: acme\/pilot#7/)
  expect(context).toMatch(/Build it\./)
})

test('a prompt without a reference is untouched and asks the tracker nothing', async ($, on) => {
  const seen = engine(on, ACME_42)
  const entered = await $.prompt.submit({ text: 'Fix the build in src/a#b and issue 42' })
  expect(entered.context).toBeUndefined()
  expect(seen.runs.length).toBe(0)
})

test('a bare #n resolves against the session repo', async ($, on) => {
  const seen = engine(on, { 'gh repo view --json nameWithOwner --jq .nameWithOwner': { stdout: 'acme/pilot\n' }, ...ACME_42 })
  const entered = await $.prompt.submit({ text: 'Do #42 next' })
  expect(entered.context?.join('\n')).toMatch(/acme\/pilot#42: Add the thing/)
  expect(seen.runs.filter(argv => argv[1] === 'repo').length).toBe(1)
})

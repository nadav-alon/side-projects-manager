# Side Projects Manager
This repo tracks coding related side project shared files. This includes the workflow, harnesses, and any agentic principles.

## The morning loop

One job, run once a day, that picks a side project with available work and moves it forward.
The full spec is [`docs/specs/morning-loop.md`](docs/specs/morning-loop.md).

`morningRun` ([`src/morning-run.ts`](src/morning-run.ts)) is the loop's single entry point. It reaches
the outside world only through five injected ports — issue tracker, sandbox, usage ledger, clock and
store ([`src/ports/`](src/ports)) — so the whole loop is exercised end to end against fakes
([`src/testing/`](src/testing)). `src/bin/morning-run.ts` is the composition root: schedules, logon
guards and any future cloud trigger are callers of `morningRun` exactly like it is.

Most ports are still stubbed ([`src/adapters/stub-ports.ts`](src/adapters/stub-ports.ts)); each stub
names the ticket that replaces it.

## Development

Requires Node 22.18 or newer — TypeScript runs directly, and tests use the built-in runner.

```sh
npm install
npm test        # node --test over src/**/*.test.ts
npm run typecheck
npm run build   # tsc -> dist/
```

Run the loop from a clone with `npm run morning-run`, or after `npm run build` as `morning-run`
(the `bin` entry, available once the package is installed or linked).

# Side Projects Manager
This repo tracks coding related side project shared files. This includes the workflow, harnesses, and any agentic principles.

## The morning loop

One job, run once a day, that picks a side project with available work and moves it forward.
The full spec is [`docs/specs/morning-loop.md`](docs/specs/morning-loop.md), and
[`CONTEXT.md`](CONTEXT.md) is the glossary the code and the tickets are both written in — an
invocation, an iteration and a run are three different things.

`morningRun` ([`src/morning-run.ts`](src/morning-run.ts)) is the loop's single entry point. It reaches
the outside world only through five injected ports — issue tracker, sandbox, usage ledger, clock and
store ([`src/ports/`](src/ports)) — so the whole loop is exercised end to end against fakes
([`src/testing/`](src/testing)). `src/bin/morning-run.ts` is the composition root: schedules, logon
guards and any future cloud trigger are callers of `morningRun` exactly like it is.

Most ports are still stubbed ([`src/adapters/stub-ports.ts`](src/adapters/stub-ports.ts)); each stub
names the ticket that replaces it.

## Registering a project

[`registry.json`](registry.json) is yours to edit. It says which projects exist, which are paused,
and which has the mornings:

```json
{
  "projects": [
    { "repo": "nadav-alon/side-projects-manager" },
    { "repo": "nadav-alon/pilot", "priority": 1 },
    { "repo": "nadav-alon/on-ice", "paused": true }
  ]
}
```

A project is named by its repo slug, `owner/repo`. `paused` keeps it registered but never
considered; `priority` is a whole number from 1 upwards, the smaller worked first, and a project
without one is worked least-recently-first. Both are optional. A paused project is already passed
over; ordering by priority and last-worked is not wired up yet, so the loop walks the registry top
to bottom.

`state.json` beside it is the machine's half: when each project was last worked, and what its runs
cost. The loop writes it after every invocation and you never have to edit it; it is committed for
the audit trail. It does not exist until the loop has run, and no state for a project means the
project has never been worked.

Both documents live in the manager home — this checkout, unless
`SIDE_PROJECTS_MANAGER_HOME` says otherwise.

House rules for source — branded primitives, and what a comment is allowed to say — are in
[`docs/agents/coding-standards.md`](docs/agents/coding-standards.md).

## The sandbox image

[`Dockerfile`](Dockerfile) builds the image every run happens in: the agent CLI and the skills
harness (the `mattpocock-skills` plugin), installed at build time so a run never reinstalls them.
Installing a plugin is a git clone plus a local file write with no Anthropic call in it, so building
the image needs no credential at all:

```sh
docker build -t side-projects-sandbox .
```

Running the built image does need a credential: a one-year subscription token, generated once with
`claude setup-token`, kept as the sandbox's long-lived credential and supplied as an environment
variable — never an API key:

```sh
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=<token> side-projects-sandbox \
  -p "List the names of every skill available to you, one per line." --permission-prompts none
```

Names like `tdd` and `code-review` in the output are the harness: the `mattpocock-skills` plugin,
already installed at build time, not fetched on this run. `--permission-prompts none` auto-denies
anything that would otherwise prompt for an answer nobody in a container can give; listing skills
needs no tool, so it isn't affected.

A container with no token set fails cleanly (`Not logged in`) rather than falling back to any
`ANTHROPIC_API_KEY`, since none is ever set in the image or required by it. See #21 for making this
build-and-verify check automated.

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

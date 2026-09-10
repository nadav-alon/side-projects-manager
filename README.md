# Side Projects Manager
This repo tracks coding related side project shared files. This includes the workflow, harnesses, and any agentic principles.

## The morning loop

One job, run once a day, that picks a side project with available work and moves it forward.
The full spec is [`docs/specs/morning-loop.md`](docs/specs/morning-loop.md), and
[`CONTEXT.md`](CONTEXT.md) is the glossary the code and the tickets are both written in — an
invocation, an iteration and a run are three different things.

`morningRun` ([`src/morning-run.ts`](src/morning-run.ts)) is the loop's single entry point. It reaches
the outside world only through six injected ports — issue tracker, repo host, sandbox, usage ledger,
clock and store ([`src/ports/`](src/ports)) — so the whole loop is exercised end to end against fakes
([`src/testing/`](src/testing)). `src/bin/morning-run.ts` is the composition root: schedules, logon
guards and any future cloud trigger are callers of `morningRun` exactly like it is.

## Running a ticket

The sandbox ([`src/adapters/container-sandbox.ts`](src/adapters/container-sandbox.ts)) makes a
throwaway clone of the project's checkout, puts the agent on a branch of its own there, and
bind-mounts that clone into the image the harness is baked into ([`Dockerfile`](Dockerfile)).
The branch the developer's checkout sits on is never committed to and never checked out from under
them. When the run ends, a branch that gained commits is fetched back into the checkout and the
clone is deleted.

A clone rather than a `git worktree`: a worktree's `.git` is a file pointing at an absolute path
inside the parent repository, so a worktree mounted on its own is not a repository at all from
inside the container.

An agent that fails does not fail the morning. Its commits, its output and what it spent all come
back as a result carrying a `failure`, because a run that fell over is exactly the one worth having
recorded — the summary line says the agent failed and why, and the loop writes the spend to state
either way.

Runs are serialized within one process — a second run waits for the first rather than starting a
container beside it. Two separate invocations are not covered by that; the once-per-day lock is
[#15](https://github.com/nadav-alon/side-projects-manager/issues/15). Build the image with
`npm run sandbox:build`, and export `CLAUDE_CODE_OAUTH_TOKEN` before a run — the container
authenticates on the subscription, not on a metered API key. Export `GH_TOKEN` (or `GITHUB_TOKEN`;
either is forwarded) too, so the agent can read the ticket it was given — the prompt names the
repo explicitly with `gh issue view --repo`, because the clone's `origin` is a path on this
filesystem and `gh` can resolve nothing from it.

## Starting a project

One command takes an idea to a project the morning loop can already see:

```sh
npm run new-project -- nadav-alon/pilot "A flight log that files itself."
```

It creates the repo, clones it to the managed location, scaffolds the harness into it, appends it to
the registry, and then hands you an interactive session that grills the idea into the project's
first tickets, writing the terms you settle on into its `CONTEXT.md` as you agree them. That last
step is interactive on purpose: starting a project is when you most want to be in the conversation,
because those tickets are what the next month of mornings will build.

Scaffolding puts two kinds of file into the new repo. The uniform files
([`docs/agents/`](docs/agents)) are copied byte for byte, so improving a convention here improves it
in every project. `AGENTS.md` is generated for that project, naming it and its purpose — never
copied, since a project that inherited another repo's instructions would describe a codebase it is
not in. Neither half refers back to this repo: a project carries no reference to the manager and no
live coupling to it, so you can walk away with just the project.

A repo that predates the manager joins with `--existing`, which registers and scaffolds it without
creating anything. Its grilling starts by reading the codebase for the language it already uses, so
the glossary you agree describes the project you have rather than a parallel one, and any gap
between the two becomes a ticket rather than a rename mid-conversation:

```sh
npm run new-project -- nadav-alon/older-thing "" --existing
```

Nothing lands on a branch you already had. On the `--existing` path the scaffold is committed to a
`harness` branch and opened as a draft pull request, and your checkout is put back on the branch it
was found on; the project is registered **paused**, so the loop leaves it alone until you have
merged that request and unpaused it. The request names the uniform files it overwrote, because
those are copied byte for byte and a repo that predates the manager never agreed to that. If the
pull request cannot be opened — pull requests disabled, no base branch to open against — the branch
is still pushed and the command says so rather than losing it.

Re-running the command on a project already registered leaves your registry entry — paused flag,
priority and all — exactly as you wrote it, and leaves an `AGENTS.md` the project already has alone.
A re-run while a `harness` request is still open adds to that same branch.

Projects are cloned to `~/side-projects/<owner>/<repo>`, unless `SIDE_PROJECTS_MANAGED_LOCATION`
says otherwise. Owner-qualified, so two people's repos of the same name are two directories. A
clone already there is reused rather than replaced — that is what makes a missing clone
self-healing — but only once its `origin` proves it is that project; a directory holding somebody
else's clone stops the command rather than being scaffolded into. The clones you have scattered
elsewhere are never touched.

`new-project` rewrites `registry.json` in full when it appends, from the fields it models (`repo`,
`paused`, `priority`). Anything else you put in that file does not survive the write.

## Registering a project

[`registry.json`](registry.json) is yours to edit — `new-project` appends to it, and nothing else
writes it. It says which projects exist, which are paused, and which has the mornings:

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

## The budget

`budget.json` is the other document that is yours, and it is what the loop asks before it starts
anything:

```json
{
  "fiveHourAllowance": 50000000,
  "weeklyAllowance": 500000000,
  "reserveFraction": 0.5,
  "spendCeiling": 5
}
```

Every field is optional and falls back to the default above, so moving the reserve alone is one
line. The two allowances are tokens, and they are declarations rather than measurements: the
provider reports what you have consumed and never what you have left, so these are your own numbers
to calibrate against the run costs accumulating in `state.json`. Neither may be zero — an allowance
of nothing leaves nothing spendable, and a window is let through while it has consumed no more than
it may, so zero would authorise a run every morning rather than stopping them. To halt the mornings,
pause the projects.

`reserveFraction` is the share of the weekly allowance held back for you. At the default of `0.5`
the mornings may spend half the week: the gate refuses once more than half is gone. The 5-hour
window has no reserve of its own — the reserve is a share of the week — and is measured against
`fiveHourAllowance` whole, because a spent block is a wall rather than headroom to ration. When both
windows refuse, you are told about whichever resets later, since that is when work could actually
resume.

`spendCeiling` is dollars, and it is the one limit the manager does not enforce itself: it is passed
to the agent CLI as `--max-budget-usd`, which stops the run from inside. The gate decides whether a
run starts; the ceiling bounds how far a run that has started can go before the gate is asked again.
The gate does not subtract the cost of the run it is about to authorise, so a run started at the
boundary spends its ceiling out of the reserve — the ceiling is the size of that accepted overshoot,
and the next gate check sees it.

A field that is present but not a usable value fails the invocation rather than falling back, and so
does a field that is not one of the four above. Every setting is optional, so `"reserve"` for
`"reserveFraction"` is indistinguishable from leaving it out — and a reserve you believe you set and
the loop silently ignored is the one way this document can go wrong expensively.

What the gate counts is the ledger's totals **plus the run costs in `state.json`**. The ledger reads
this machine's Claude Code session logs, and a run writes its log inside a container that is thrown
away when it ends, so the mornings' own spend reaches the gate through `state.json` or not at all.
What remains genuinely invisible is Claude chat and your other machines; the reserve is what absorbs
that, which is why it is worth setting generously.

All three documents live in the manager home — this checkout, unless
`SIDE_PROJECTS_MANAGER_HOME` says otherwise.

House rules for source — branded primitives, and what a comment is allowed to say — are in
[`docs/agents/coding-standards.md`](docs/agents/coding-standards.md).

## The sandbox image

[`Dockerfile`](Dockerfile) builds the image every run happens in: the agent CLI and the skills
harness (the `mattpocock-skills` plugin), installed at build time so a run never reinstalls them.
Installing a plugin is a git clone plus a local file write with no Anthropic call in it, so building
the image needs no credential at all:

```sh
docker build -t side-projects-sandbox:latest .
```

Running the built image does need a credential: a one-year subscription token, generated once with
`claude setup-token`, kept as the sandbox's long-lived credential and supplied as an environment
variable — never an API key:

```sh
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=<token> side-projects-sandbox:latest \
  -p "List the names of every skill available to you, one per line." --permission-prompts none
```

Names like `tdd` and `code-review` in the output are the harness: the `mattpocock-skills` plugin,
already installed at build time, not fetched on this run. `--permission-prompts none` auto-denies
anything that would otherwise prompt for an answer nobody in a container can give; listing skills
needs no tool, so it isn't affected.

A container with no token set fails cleanly (`Not logged in`) rather than falling back to any
`ANTHROPIC_API_KEY`, since none is ever set in the image or required by it.

CI makes the same check on every push touching the image, and needs no token to do it:
[`.github/workflows/sandbox-image.yml`](.github/workflows/sandbox-image.yml) builds the image, then
runs [`scripts/verify-harness.ts`](scripts/verify-harness.ts) inside it to assert the plugin is
installed, enabled, and enumerating its skills. Asking `claude` about an installed plugin reads it
off disk with no Anthropic call in it, which is what lets the check run unauthenticated where the
prompt above cannot. CI runs it through the same two npm scripts a local check does:

```sh
npm run sandbox:build && npm run sandbox:verify
```

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

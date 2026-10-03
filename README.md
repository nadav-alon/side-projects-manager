# Side Projects Manager
This repo tracks coding related side project shared files. This includes the workflow, harnesses, and any agentic principles.

## Setup

`scripts/setup-wizard.sh` walks a fresh machine through everything below: generating the
`CLAUDE_CODE_OAUTH_TOKEN` and GitHub tokens, persisting them for both an interactive shell and cron
(which sources neither `.bashrc` nor `.zshrc`), building and verifying the sandbox image, installing
the git hooks and the triggers, and optionally registering a first project. Re-running it is safe — it remembers what
it already captured.

```sh
scripts/setup-wizard.sh
```

## The morning loop

One job, run every 15 minutes, that picks a side project with available work and moves it forward.
The full spec is [`docs/specs/morning-loop.md`](docs/specs/morning-loop.md), and
[`CONTEXT.md`](CONTEXT.md) is the glossary the code and the tickets are both written in — an
invocation, an iteration and a run are three different things.

`morningLoop` ([`src/morning-run.ts`](src/morning-run.ts)) is the loop's single entry point. It reaches
the outside world only through six injected ports — issue tracker, repo host, sandbox, usage ledger,
clock and store ([`src/ports/`](src/ports)) — so the whole loop is exercised end to end against fakes
([`src/testing/`](src/testing)). `src/bin/morning-run.ts` is the composition root: the cron
schedule, a manual `npm run morning-run` and any future cloud trigger are callers of `morningLoop`
exactly like it is.

## Triggers

Two triggers fire the loop: a schedule firing every 15 minutes, which starts with the machine rather than waiting on
a login, and a manual `npm run morning-run`. The schedule first fast-forwards the checkout
(`git pull --ff-only`), so it runs the latest merged loop; a pull that can't apply is logged and the
loop runs on the code it has. Both call
[`src/bin/morning-run.ts`](src/bin/morning-run.ts), which wraps the loop in an invocation lease
([`src/trigger-guard.ts`](src/trigger-guard.ts)): whichever firing acquires it runs the loop and every
other firing, however long the first one takes, is a no-op that says an invocation is already running.
The lease is a single file holding the holder's pid
([`src/adapters/file-invocation-lease.ts`](src/adapters/file-invocation-lease.ts)), created
exclusively so two firings racing for it can't both believe they won; a lease whose holder's pid is
no longer alive is stale and is taken over, so a process killed mid-run doesn't stop the loop for
good. `morningLoop` itself carries none of this — it stays callable directly, with no lease at all.

`npm run triggers:install` ([`scripts/install-triggers.sh`](scripts/install-triggers.sh)) registers
the cron line on the current machine. It edits the developer's own crontab, so nothing in this repo
runs it automatically — it's a command the developer runs once, and it's safe to run again, including
after a checkout moves: re-running replaces a stale registration — a leftover daily cron line, a
logon-guard rc snippet, or a cron line pointing at the old checkout path — with the current one.

`npm run grant -- owner/repo#n` labels a ticket `turboable` as the developer and writes the grant
record that lets the merge gate count it even if it lands inside an unrelated run's span — see
[ADR 0012](docs/adr/0012-a-host-only-grant-record-vouches-for-a-grant-inside-a-run-span.md). It refuses a
project whose `turbo` is off.

`npm run halt` stops every trigger from doing anything, scheduled or manual, until `npm run resume`
clears it — both commands are idempotent, and say what they did. Distinct from pausing every project
in `registry.json`: a halt is a file of its own under the manager home
([`src/adapters/file-halt.ts`](src/adapters/file-halt.ts)), so it survives
`scripts/install-triggers.sh` being re-run and a reboot without touching the crontab or the registry.
`npm run status` says when the loop is halted.

`npm run stop` ends the invocation in flight and halts the loop: it finds the in-flight invocation
through the journal, never `ps`, and sends it the same stop signal an interrupt already handles —
nothing further starts, runs in progress finish, and the summary publishes. `npm run stop -- --now`
sends it twice, abandoning whatever is in progress the same way a second Ctrl+C does. Replaces
finding a run's pid in `npm run status` and signalling it by hand. With nothing in flight, it still
halts and says so.

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
recorded — the summary line says why it stopped, and the loop writes the spend to state either way.

### When a run fails

A failed run hands its ticket back rather than trying again. The branch is discarded, a comment on
the ticket says what happened and quotes what the agent said, and the ticket moves from
`ready-for-agent` to `ready-for-human` — which is the whole of the no-retry rule, since a ticket
without `ready-for-agent` is not eligible tomorrow. A genuinely too-hard ticket left in the queue
would otherwise cost a morning every morning.

The two ways a run fails are reported apart, because the developer's next move differs: an agent
that **gave up** is a ticket to rewrite or drop, an **infrastructure** failure is a sandbox or a
credential to fix. The sandbox port draws the line — it rejects when it could not set itself up,
start the agent, or tear itself down, and reports an agent that gave up as a result carrying
`failure`. The container adapter counts docker's own exit codes (125, 126 and 127), a missing
`docker`, and an unset `CLAUDE_CODE_OAUTH_TOKEN` as the agent never having run; every other non-zero
exit is the agent's.

Neither aborts the invocation. The iteration ends, the summary says what happened, and the projects
behind it are still reachable. An infrastructure failure still exits non-zero, so a schedule
watching a permanently broken sandbox is told about it; an agent that gave up exits zero, since its
ticket has been handed back and retrying the morning would run straight into the no-retry rule.

The relabel is the load-bearing half, and the order reflects that: a branch git will not delete (one
checked out in a worktree, say) is reported in the comment rather than allowed to stop the ticket
being handed back, and `ready-for-human` is created in a project that has never used it before it
is applied. If the tracker itself cannot be reached, the summary says the ticket is still
`ready-for-agent` and needs relabelling by hand.

Runs are serialized within one process — a second run waits for the first rather than starting a
container beside it. Two separate invocations are covered separately, by the invocation lease —
see [Triggers](#triggers) below. Build the image with
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

The repo is created private unless you pass `--public`, which a project needs when its GitHub Pages
has to serve on the free plan, or when a `github:<owner>/<repo>#tag` dependency has to install
without a token.

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
`paused`, `turbo`, `priority`). Anything else you put in that file does not survive the write.

## Registering a project

[`registry.json`](registry.json) is yours to edit — `new-project` appends to it, and nothing else
writes it. It says which projects exist, which are paused, which are turbo, and which has the
mornings:

```json
{
  "projects": [
    { "repo": "nadav-alon/side-projects-manager" },
    { "repo": "nadav-alon/pilot", "priority": 1 },
    { "repo": "nadav-alon/on-ice", "paused": true },
    { "repo": "nadav-alon/fast-thing", "turbo": true }
  ]
}
```

A project is named by its repo slug, `owner/repo`. `paused` keeps it registered but never
considered; `turbo` is standing consent to post `/apply-review` on a pull request itself once its
review ticket closes, in place of you typing it; `priority` is a whole number from 1 upwards, the
smaller worked first, and a project without one is worked least-recently-first. All three are
optional, and a paused project is never selected however high its priority.

Selection picks one project and one ticket per iteration: a review ticket before any
implementation ticket, then explicit priority, then least recently worked. An invocation keeps
iterating — reconsidering the registry and re-checking the budget gate before each one — until
nothing eligible is left or the gate refuses, so a long morning can move more than one project
forward before it stops.

A review ticket's own run is a fresh, read-only sandbox: the container's clone is mounted `:ro`, so
a commit or a push attempt fails at the filesystem — but that alone only stops a push staged from
*that* clone. What stops one staged from anywhere else in the container (a fresh `git clone` into
`/tmp`, say) is the credential: export `GH_REVIEW_TOKEN` alongside `GH_TOKEN`, a token scoped to
Issues and Pull requests only, with no Contents access, so a push or a merge attempted with it is
refused by GitHub itself. Without it a review will not start — it does not fall back to the
implementation's own, push-capable token.

An apply-review ticket's run is the opposite: its clone is checked out on the pull request's head
branch, mounted read-write, with `origin` pointed at GitHub, and the agent pushes and replies itself
with `GH_TOKEN` — so that token needs Contents write access. The head branch is looked up with
`gh pr view` on this machine before the container starts. Nothing is fetched back into the checkout;
what the run pushed and answered is read back from GitHub.

`state.json` beside it is the machine's half: when each project was last worked, and what its runs
cost. The loop writes it after every invocation and you never have to edit it; it is gitignored and
local to this machine, not committed. It does not exist until the loop has run, and no state for a
project means the project has never been worked.

`journal.json` records every invocation, whether or not it published a summary: when it started, when
it ended, what it came to, and which projects it worked at what cost. `morning-run` opens a record
before the loop runs and closes it with the report, so an invocation that dies partway leaves an
in-flight record — one with no `closedAt` — rather than no trace at all. It keeps only the 50 most
recent records, oldest dropped first, and is gitignored alongside `state.json`.

Losing either costs little: the loop restarts cleanly from no state, and what past runs did survives
in the summaries.

`npm run status` answers "is the loop alive?" without reading source: whether the triggers are armed,
whether today has been claimed and what came of it, what the most recent invocation came to, and a
short history of the ones before it. A record still in flight is reported as still running or as died,
a summary that never published is called out by name, and a run of consecutive failures is called out
too — each naming what to do about it. Armed ([`CONTEXT.md`](CONTEXT.md): Armed) means registered on
this machine and still pointing at this manager home; a registration pointing elsewhere is reported as
a problem, distinctly from one not registered at all, and each names `npm run triggers:install` as the
fix. It reads `journal.json` and `state.json`, the crontab, and the shell rc files a logon guard from
an older install may still leave behind: no network call, and nothing written back.

```sh
npm run status
```

`status --watch` redraws the same report every 30 seconds, or every `N` given as `--watch N`, clearing
the screen and stamping the current time on top each time. Ctrl+C exits it cleanly. Watching an
invocation that is still in flight prints its close once more and then exits by itself; watching with
nothing in flight just keeps going, since an invocation may start on the next scheduled firing.

```sh
npm run status -- --watch
npm run status -- --watch 10
```

## The budget

`scripts/budget-wizard.sh` writes this document one field at a time, starting from what
`state.json` says the mornings have actually been spending and reading the finished budget back
through the manager's own parser. Re-running it is safe — it starts from the budget in force, so
recalibrating a single number is one pass through it.

```sh
scripts/budget-wizard.sh
```

`budget.json` is the other document that is yours, and it is what the loop asks before it starts
anything. It is gitignored and local to this machine, so losing it loses your ceiling, allowances
and size weights: keep your own copy.

```json
{
  "fiveHourAllowance": 15000000,
  "weeklyAllowance": 150000000,
  "reserveFraction": 0.5,
  "fiveHourReserveFraction": 0,
  "spendCeiling": 10,
  "sizes": { "S": 150000, "M": 600000, "L": 1500000, "XL": 3000000 },
  "kinds": { "review": 250000, "applyReview": 450000, "rebase": 100000 },
  "unsizedCountsAs": "M"
}
```

Every field is optional and falls back to the default above, so moving the reserve alone is one
line. The two allowances are weighted tokens — a fresh input token counts as 1, output as 5, a cache
write as 1.25 and a cache read as 0.1, the ratios the provider prices every current model by, in
place of the equal weight that let a run's cache reads pass for most of its cost — and they are
declarations rather than measurements: what the provider does report of a window's own usage — a
status-line percentage, a utilization figure sent only once a limit is hit — never reaches a headless
run in time to act on, so these are your own numbers to calibrate against the run costs accumulating
in `state.json`. Neither may be zero — an allowance of nothing leaves nothing spendable, and a window is
let through while it has consumed no more than it may, so zero would authorise a run every morning
rather than stopping them. To halt the mornings, run `npm run halt` — see [Triggers](#triggers).

`reserveFraction` is the share of the weekly allowance held back for you. At the default of `0.5`
the mornings may spend half the week: the gate refuses once more than half is gone. When both
windows refuse, you are told about whichever resets later, since that is when work could actually
resume.

`fiveHourReserveFraction` is the share of the current 5-hour block held back for you, the same way
`reserveFraction` holds back a share of the week — same validation, same meaning, a different
window. It defaults to `0`, so a `budget.json` that never mentions it holds nothing back from the
block and behaves exactly as it did before this field existed: a morning may still spend the block
whole. Raise it if a run locking you out until the block resets is a cost you want the gate to
weigh.

`sizes` is what each ticket size label is worth, in weighted tokens: the run estimate the gate
charges before a run starts. Any of `S`, `M`, `L` or `XL` may be left out, and each missing one falls
back to its own default shown above; a `sizes` document naming only `L` leaves `S`, `M` and `XL`
where they were. Every value must be a whole number of tokens, 0 or more, and a key that is not one
of the four sizes is refused the same way an unrecognised top-level setting is.

`kinds` is what a pull request ticket's run is worth, by kind — `review`, `applyReview` or `rebase` — in
weighted tokens, in place of any size: a pull request ticket never inherits its parent's size. Any
kind may be left out, and a ticket of a kind left out is charged `sizes[unsizedCountsAs]`; a `kinds`
that is absent altogether takes the three figures shown above. Values are validated like `sizes`, and a key
that is not one of the three kinds is refused.

`unsizedCountsAs` is the size a ticket with no size label counts as, and the size a pull request ticket
counts as where `kinds` gives its kind no figure. It must name one of the four sizes, and
defaults to `M`.

`spendCeiling` is the one ceiling the manager does not enforce itself: it is passed to the agent CLI
as `--max-budget-usd`, which stops the run from inside. It is dollars because that flag is, not
because anything is billed — on a subscription the CLI prices the run's own token usage at API rates
and stops when the priced total crosses the figure, so this is a token ceiling stated in the CLI's
units. The gate decides whether a run starts, charging the run estimate its ticket's size names
before authorising it; the ceiling still bounds how far a run that has started can go, in dollars
rather than the tokens the gate reasons in, and the two are allowed to disagree. An estimate set low
still leaves room for a run to spend past it, up to the ceiling, before the next consultation catches
up. What a run actually spent is recorded in `state.json` either way, so the next morning's gate
counts the real figure, not the estimate.

`spendCeiling` accepts either a number — one ceiling for every ticket, the form above — or an object
keyed by size, `{ "S": 3, "M": 5, "L": 10, "XL": 20 }`. Any of `S`, `M`, `L` or `XL` may be left out
of that object, and each missing one falls back to the flat default, the same way `sizes` fills in
whatever it is not told. A run is given the ceiling its ticket's `size:*` label names, resolved the
same way `sizes` resolves the run estimate: an unsized ticket, and every review, apply-review or
rebase ticket whatever it declares, is given `unsizedCountsAs`'s ceiling instead.

`maxConcurrentIterations` is the most iterations one invocation may have in progress at once: a
whole number, 1 or more, defaulting to `1`. Know what it costs before raising it: the gate charges
every iteration still in progress its own run estimate, so raising this does not multiply an
unaccounted overshoot the way it once did, but an estimate set too low still lets that many runs
overshoot it together — by as much as the largest ceiling in play, once `spendCeiling` can differ by
size. Raising it is a reason to lower the allowances or raise the reserve.

`observedResetAt` is the one field with no default, and most `budget.json` files never carry it. It
is a 5-hour reset instant you read off Claude's own display, written as ISO 8601 with a zone —
`"2026-09-12T13:00:00Z"` — and it settles a boundary the ledger can otherwise only guess at. The
guess goes wrong in one direction: the 5-hour block is inferred from messages this machine logged,
so a message it never saw — you on Claude chat, or on your other machine — opened the real block
earlier than the inferred one, and the loop stands down past the moment its headroom came back. It
is worth setting when a morning stands down naming a reset later than the one Claude shows you.

A reset still to come is taken as the block now open, stated outright: it began five hours before
then, and nothing is left to infer. A reset already past says only that the blocks before it have
ended, so their spend is dropped and the block now open is inferred from the messages that follow —
this is what repairs a window straddling a reset the logs never saw. Going stale costs nothing: an
instant from last week still correctly discards blocks that ended long ago, and the inference takes
over from there.

Ahead is the direction that is not forgiving. A reset more than five hours out names a block that
has not opened, and taken at its word it would state an empty window and wave every morning through
— so the loop refuses it and says so, exactly as it refuses any other unusable field. Claude only
ever shows you the block you are in, so an instant it refuses is one you did not mean to write; a
mistyped date is the usual cause.

A field that is present but not a usable value fails the invocation rather than falling back, and so
does a field that is not one of the nine above. Every setting is optional, so `"reserve"` for
`"reserveFraction"` is indistinguishable from leaving it out — and a reserve you believe you set and
the loop silently ignored is the one way this document can go wrong expensively.

What the gate counts is the ledger's totals **plus the run costs in `state.json`**. The ledger reads
this machine's Claude Code session logs, and a run writes its log inside a container that is thrown
away when it ends, so the mornings' own spend reaches the gate through `state.json` or not at all.
What remains genuinely invisible is Claude chat and your other machines; the reserve is what absorbs
that, which is why it is worth setting generously. The reserve absorbs the missing tokens, though,
not the missing boundary — a block those surfaces opened is a block the ledger cannot place, and
`observedResetAt` is how you place it.

### Model defaults

`models.json` is the third document that is yours, and it names the model each kind of ticket runs on
when the ticket carries no `model:<name>` label — the same for every project:

```json
{ "implementation": "sonnet", "review": "opus" }
```

The kinds are `implementation`, `review`, `apply-review`, `rebase`, `spec-review` and
`ux-review`. Every kind is optional, and so is the file. A kind you leave out, and every kind on a machine with no
`models.json`, runs on the model the sandbox image is pinned to. A name is passed to the agent CLI
as written — an alias or a full model id — and never checked against a list of models, so a new
model needs no change here; the only shape asked of it is a non-empty name without spaces that does
not start with `-`. Nothing writes this document: not the loop, and not `new-project`.

A ticket's own `model:<name>` label wins over the default for its kind, and a review ticket reads
its own labels, never the ticket it reviews. A ticket carrying two model labels is handed back
without being run, and so is one whose model the agent CLI refuses — the comment names the model
and whether the label or `models.json` named it. The summary says which model each run used.

A key that is not one of those five kinds fails the invocation, and so does a name that is not a
usable string. Every kind is optional, so `"reveiw"` would otherwise read as no review default at
all, and your reviews would quietly run on the image's model.

All five documents, your three and the loop's `state.json` and `journal.json`, live in the manager
home: this checkout, unless `SIDE_PROJECTS_MANAGER_HOME` says otherwise.

Coding standards for source are in two files:
[`docs/agents/coding-standards.md`](docs/agents/coding-standards.md)
holds the rules every project shares (what a comment is allowed to say, a test never weakened),
and [`docs/project-standards.md`](docs/project-standards.md) holds this project's own (branded
primitives).

## The sandbox image

[`Dockerfile`](Dockerfile) builds the image every run happens in: the agent CLI and the skills
harness (the `mattpocock-skills` plugin), installed at build time so a run never reinstalls them.
Installing a plugin is a git clone plus a local file write with no Anthropic call in it, so building
the image needs no credential at all:

```sh
npm run sandbox:build
```

That passes npm's current CLI release as `CLAUDE_CODE_VERSION`, so a rebuild picks up a new CLI
instead of reusing the cached install layer, and npm's current `@playwright/mcp` release as
`PLAYWRIGHT_MCP_VERSION` for the same reason. A bare `docker build -t side-projects-sandbox:latest .`
installs `latest` once and then keeps whatever that was on every cached rebuild.

It also builds on the host's network (`--network host`): on WSL, docker's default bridge network
timed out downloading Playwright's Chrome while the host itself fetched it at full speed.

Nothing rebuilds the image on its own, so a change to the Dockerfile — or to a skill it bakes in —
leaves the built image behind the checkout, and a run against it reports a missing skill as `Unknown
command` rather than as anything that looks like a build problem. Two things watch for that gap: a
morning prints a warning before its first run, and [`.githooks/post-merge`](.githooks/post-merge)
prints the same one right after a merge brings the change in. The hook is installed by pointing git
at the repo's hook directory, once per clone:

```sh
npm run hooks:install   # git config core.hooksPath .githooks
```

It stays quiet when the image matches, when docker isn't running, and when the image was never
built, and it never fails the merge — the merge has already happened by the time it runs.
`node scripts/check-sandbox-image.ts` makes the same check by hand.

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
installed, enabled, and enumerating its skills, and that the `apply-pr-review`, `rebase-pr` and
`ux-review` skills the image carries — for applying a pull request's review, for rebasing a pull
request's branch onto its base, and for reviewing how an app feels in a browser — are on disk at
the CLI's personal-skill path. Asking `claude` about an installed plugin reads it off disk with no
Anthropic call in it, which is what lets the check run unauthenticated where the prompt above
cannot. CI runs it through the same two npm scripts a local check does:

```sh
npm run sandbox:build && npm run sandbox:verify
```

## Development

Requires Node 22.18 or newer — TypeScript runs directly, and tests use the built-in runner. Also
requires `jq` on `PATH`: `src/workflows/rebase.test.ts` runs `.github/workflows/scripts/rebase.sh`
for real, and that script shells out to it.

```sh
npm install
npm test        # node --test over src/**/*.test.ts
npm run typecheck
npm run build   # tsc -> dist/
```

Run the loop from a clone with `npm run morning-run`, or after `npm run build` as `morning-run`
(the `bin` entry, available once the package is installed or linked).

To stop a morning early, interrupt it once (Ctrl+C, or `SIGTERM`): nothing further starts, runs
already in progress finish and are handed over, and the summary publishes as usual. Interrupt a
second time to stop at once — whatever is in progress is lost. Closing the terminal, or killing the
`morning-run` process outright, counts as the first interrupt: the morning stops the same way rather
than running on with nothing left to stop it.

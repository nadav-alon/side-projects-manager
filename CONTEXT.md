# Side Projects Manager

The manager owns a morning loop that moves one side project forward each day inside a sandboxed
agent, and a command that starts new projects. Projects stay independent: the manager holds the
registry and the harness, each project repo holds its own backlog.

## Language

### The loop

**Morning loop**:
The job that picks one side project with available work and moves it forward. Referred to as "the loop".
_Avoid_: the daily job, the cron job, the automation

**Invocation**:
One firing of the morning loop, by whichever trigger got there first. Writes exactly one summary.
_Avoid_: run, execution, session

**Iteration**:
One pass within an invocation. An iteration works one project, and the budget gate is re-checked between iterations.
_Avoid_: cycle, pass, turn, loop

**Run**:
One agent execution in the sandbox against a single ticket. Carries a cost and a spend ceiling.
_Avoid_: job, session, execution, task

**Selection**:
Choosing which project and ticket an iteration works: reviews before implementations, then explicit priority, then least recently worked.
_Avoid_: picking, scheduling, prioritisation

**Dry queue**:
No registered project had an eligible ticket. A normal quiet morning, reported explicitly rather than silently.
_Avoid_: empty queue, no work, nothing found

**Stand down**:
What the loop does when the budget gate refuses: it declines to start or to continue, and says so.
_Avoid_: abort, bail, skip, fail

**Summary**:
The single issue an invocation writes in the manager repo, covering every attempt, what it cost, and what now needs the developer.
_Avoid_: report, digest, changelog

### Projects

**Project**:
A side project the developer owns: one GitHub repo, carrying its own backlog and its own agent instructions.
_Avoid_: repo (when the project is meant), app, package

**Repo slug**:
How a project is named everywhere, as `owner/repo`.
_Avoid_: repo name, full name, project id, url

**Registry**:
The hand-edited document of developer intent: which projects exist, which are paused, which has explicit priority. `registry.json` in the manager home.
_Avoid_: config, settings, projects file

**State**:
The machine-written document alongside the registry: when each project was last worked, and what past runs cost. Separate from the registry because it has a different author and a different change rate. `state.json` in the manager home.
_Avoid_: cache, database, history file

**Paused**:
Registered but never considered.
_Avoid_: disabled, archived, muted

**Priority**:
The explicit rank a project may carry in the registry, overriding least-recently-worked ordering. A whole number from 1 upwards, smaller worked first; a project without one sorts after every project with one.
_Avoid_: rank, weight, importance, order

**Never worked**:
What a project looks like before its first run: no entry in the state document. Not an error, and indistinguishable from a project registered this morning.
_Avoid_: unworked, new, cold

**Manager home**:
The manager's own checkout, holding the registry and the state document, both committed. Distinct from the managed location, which is where projects are cloned to.
_Avoid_: config directory, data directory, root

**Managed location**:
The predictable place the manager clones projects to. Clones the developer already has elsewhere are never touched.
_Avoid_: workspace, checkout directory

**Scaffold**:
Installing the harness into a project checkout: the uniform files copied verbatim, and the project's agent instructions generated fresh for it.
_Avoid_: bootstrap, template, generate (only half of it is generated)

**Proposal**:
Scaffolding a project that predates the manager, put somewhere the developer has to say yes to: a branch and a draft pull request, never the branch their checkout was on. The project is registered paused until it merges, because a project whose conventions are still unmerged would be worked without them.
_Avoid_: PR (say pull request), suggestion, patch

**Uniform files**:
The half of the harness every project gets byte for byte, so that improving a convention improves it everywhere from one source.
_Avoid_: shared files, common files, boilerplate

**Agent instructions**:
The other half: one file per project, generated for that project, saying what the project is and pointing at its own uniform files. Never copied from another repo.
_Avoid_: prompt, system prompt, rules file

**Grilling**:
An interactive session that turns a conversation with the developer into tickets in a project's tracker, and into the vocabulary the project uses to talk about itself. Interactive by design: what comes out of it is what the mornings after it build. The new-project command opens a project's first one; it is not the only one a project gets, and later grillings are where more of its work comes from.
_Avoid_: interview, kickoff, brainstorm, planning session

### Work

**Ticket**:
An issue in a project's own repo that the loop may work on.
_Avoid_: task, story, card, work item

**ready-for-agent**:
The triage label that makes a ticket eligible. Always written in full, as the tracker spells it — never shortened to "ready".
_Avoid_: ready, agent-ready, afk-ready

**Eligible**:
Carrying the ready-for-agent label. The only tickets the loop may select.
_Avoid_: available, valid, approved

**Backlog**:
One project's eligible tickets.
_Avoid_: queue (the queue spans all projects), todo list

**Implementation ticket**:
A ticket asking for something to be built.
_Avoid_: feature ticket, build ticket

**Draft pull request**:
How a run's work reaches the developer: the branch it committed to, pushed, with a draft pull request open against the ticket it implemented. It stays a draft — the manager opens one and never promotes or merges it.
_Avoid_: PR (say pull request), submission, patch

**Handover**:
What a finished run comes to for the developer: the run itself, and the draft pull request its commits are waiting in. A run that committed nothing, and one the agent did not finish, are runs without a handover.
_Avoid_: work, result, outcome

**Review ticket**:
A sub-issue of an implementation ticket asking for that ticket's draft pull request to be reviewed. Created by the manager, born ready-for-agent, and selected before any implementation ticket.
_Avoid_: review task, review job, QA ticket

### Budget

**Budget gate**:
The check made before every run that refuses work which would eat into the reserve. Referred to as "the gate".
_Avoid_: throttle, rate limit, quota check

**Reserve**:
The fraction of the weekly window held back for the developer's own interactive work.
_Avoid_: buffer, headroom, allowance

**Usage ledger**:
What reports rolling token consumption. Knowingly under-counts, since it cannot see Claude chat or other machines. Referred to as "the ledger".
_Avoid_: usage tracker, meter, monitor

**Window**:
One of the two periods consumption is measured against. The 5-hour window opens with the first
message of the current block; the weekly window opens on Sunday. Neither is a lookback from now, so
a window has an opening instant and a reset instant, and both matter to the gate.
_Avoid_: period, interval, bucket, rolling window, last 5 hours, last 7 days

**Spend ceiling**:
The hard per-run cap enforced by the agent CLI itself, distinct from the gate.
_Avoid_: budget, limit, cap

### The seam

**Port**:
One of the six injected dependencies the loop reaches the outside world through: issue tracker, repo host, sandbox, usage ledger, clock, store.
_Avoid_: service, client, interface, dependency

**Adapter**:
A real implementation of a port.
_Avoid_: driver, provider, backend

**Fake**:
A working in-memory implementation of a port, used to exercise the loop in tests.
_Avoid_: mock, double, spy

**Sandbox**:
The container an unattended agent runs in, on a throwaway clone of one project. The branch it leaves behind is fetched back into the project's checkout; the clone is not kept.
_Avoid_: box, VM, runner, environment

**Throwaway clone**:
The repository one run happens in: cloned from the project's checkout, deleted when the run ends, and never the checkout itself. Shortened to *clone* where the context is a run.
_Avoid_: workspace, worktree (it is neither), scratch directory

**Harness**:
The skills setup: baked into the sandbox image, and scaffolded into each project repo.
_Avoid_: toolkit, framework, template

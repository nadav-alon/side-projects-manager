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
The hand-edited document of developer intent: which projects exist, which are paused, which has explicit priority.
_Avoid_: config, settings, projects file

**State**:
The machine-written document alongside the registry: when each project was last worked, and what past runs cost. Separate from the registry because it has a different author and a different change rate.
_Avoid_: cache, database, history file

**Paused**:
Registered but never considered.
_Avoid_: disabled, archived, muted

**Managed location**:
The predictable place the manager clones projects to. Clones the developer already has elsewhere are never touched.
_Avoid_: workspace, checkout directory

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

**Review ticket**:
A sub-issue of an implementation ticket asking for that ticket's draft PR to be reviewed. Created by the manager, born ready-for-agent, and selected before any implementation ticket.
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
One of the five injected dependencies the loop reaches the outside world through: issue tracker, sandbox, usage ledger, clock, store.
_Avoid_: service, client, interface, dependency

**Adapter**:
A real implementation of a port.
_Avoid_: driver, provider, backend

**Fake**:
A working in-memory implementation of a port, used to exercise the loop in tests.
_Avoid_: mock, double, spy

**Stub**:
A placeholder implementation wired into the real command until its adapter lands. Does the least a caller can be asked to handle.
_Avoid_: fake (a fake works; a stub does nothing), no-op, dummy

**Sandbox**:
The container an unattended agent runs in, on a worktree of one project.
_Avoid_: box, VM, runner, environment

**Harness**:
The skills setup: baked into the sandbox image, and scaffolded into each project repo.
_Avoid_: toolkit, framework, template

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
Choosing which project and ticket an iteration works: rebase tickets first, then apply-review tickets, then review tickets, then implementations, then explicit priority, then least recently worked. Within the chosen project: rebase tickets first, then apply-review tickets, then review tickets, then ticket priority, then the oldest ticket.
_Avoid_: picking, scheduling, prioritisation

**Dry queue**:
No registered project had an eligible ticket. A normal quiet morning, reported explicitly rather than silently.
_Avoid_: empty queue, no work, nothing found

**Worked today**:
The tickets the loop has worked on the current local calendar day, recorded in the state document with that day. Selection passes them over until the next day, even while they still carry ready-for-agent — a hand-back the tracker refused, a review the loop could not close, a finished run whose relabel failed — so a loop firing every hour does not spend a run on one every hour. A ticket counts from the moment it is selected, and is saved before the sandbox starts, so a run killed part way still counts. A run that was an infrastructure failure or a limit refusal says nothing about its ticket, so the ticket comes off the record again and a later firing the same day may select it. A record for any other day reads as nothing worked today.
_Avoid_: seen, attempted, cooldown

**Stand down**:
What the loop does when the budget gate refuses, when the provider limit refuses a run already started, or when the developer stops an invocation by hand: it starts nothing further, lets the runs already in progress finish, and says so. A second interrupt from the developer is not a stand-down: the invocation ends at once, and whatever was in progress is lost.
_Avoid_: abort, bail, skip, fail

**Summary**:
The single issue an invocation writes in the manager repo, covering every attempt, what it cost, and what now needs the developer. An invocation that worked something always publishes one; a quiet or broken invocation — a dry queue, a stand-down, or an invocation failure — publishes one only if none has been published yet that local calendar day, recorded in the state document with that day once the publish succeeds, so a loop firing every hour still reports one quiet or broken morning rather than up to twenty-four. The title carries the local time to the minute beside the date, since more than one summary can land on one day.
_Avoid_: report, digest, changelog

### Triggers

**Trigger**:
Whatever calls `morningLoop`: the daily schedule, the logon guard, or any future cloud trigger. Carries no logic of its own beyond deciding whether to call — the loop itself never knows which one called it.
_Avoid_: caller (when trigger is meant), cron job, entry point

**Logon guard**:
The trigger that fires on every new interactive shell, relying on the once-per-day lock to act only the first time that happens each day — so a machine left off overnight doesn't silently skip a day.
_Avoid_: startup hook, login script

**Once-per-day lock**:
What stops two triggers firing the same day: the first to claim a calendar day invokes the loop, every later claim that day is refused. Claimed before the loop is invoked, so an invocation that fails still leaves the day claimed.
_Avoid_: mutex, semaphore, debounce

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
The machine-written document alongside the registry: when each project was last worked, what past runs cost, and which tickets were worked today. Separate from the registry because it has a different author and a different change rate. `state.json` in the manager home.
_Avoid_: cache, database, history file

**Paused**:
Registered but never considered.
_Avoid_: disabled, archived, muted

**Priority**:
The explicit rank a project may carry in the registry, overriding least-recently-worked ordering. A whole number from 1 upwards, smaller worked first; a project without one sorts after every project with one. Always a project's; the rank a ticket carries is ticket priority.
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

**Model label**:
The label a ticket may carry, as `model:<name>`, naming the model its run uses. Set by the developer like any triage label, and read afresh each morning, so changing it changes the next run. The name is passed through, never ranked or interpreted by the loop. Wins over the model defaults.
_Avoid_: model tag, model override, tier

**Model defaults**:
The hand-edited document naming the model each kind of ticket runs on when it carries no model label, one name per kind and the same for every project. `models.json` in the manager home. A kind it leaves out runs on the model the sandbox image is pinned to.
_Avoid_: model config, model settings, tiers

**Size label**:
The label a ticket may carry, as `size:<size>`, saying how much of the budget its run is expected to spend: one of S, M, L or XL, each worth the tokens the budget document gives it. What sets the ticket's run estimate; a ticket without one counts as the size the budget document names for unsized tickets, and so does every pull request ticket, which never inherits its parent's size. Recommended by triage when a ticket is made ready-for-agent. A ticket carrying two sizes counts as the larger. Says nothing about the ticket's model: a ticket expected to run on a costlier model is sized larger.
_Avoid_: estimate label, cost label, points, effort

**ready-for-human**:
The triage label a ticket carries once the loop has stopped working on it. Always written in full, as the tracker spells it.
_Avoid_: needs-human, manual, blocked (a blocked ticket is something else)

**Hand back**:
What the loop does with a ticket whose run gave up or finished, or whose model it cannot use — a model refusal, or model labels that name no one usable model — or whose size label names no size the budget document knows: a comment saying what happened, and a move from ready-for-agent to ready-for-human. Also the whole of the no-retry rule, since a ticket without ready-for-agent is not eligible the next morning. Only those: a run that was an infrastructure failure, or that the provider limit refused, says nothing about the ticket, so the ticket is left exactly as it was.
_Avoid_: return, bounce, escalate, reassign

**Gave up**:
A run whose agent ran and stopped short — it said it could not, left the tests red, for a review, posted no findings to the pull request, or, for an apply-review run, left a thread on its pull request unanswered or had its push rejected because the pull request's branch moved on the repo host, or, for a rebase run, could not resolve a conflict green. The ticket is the problem: a branch that moved since the review is one the review no longer describes, and whether to ask again is the developer's call, so it is handed back rather than left eligible as an infrastructure failure would be.
_Avoid_: crashed, errored, failed (say which of the two)

**Infrastructure failure**:
A run that never happened, or whose work never reached the checkout, because the sandbox or the repo host could not do its part — before the agent started, or after it stopped, such as a branch that could not be fetched back. The setup is the problem. What an agent that did start spent is still recorded against its project. Reported apart from an agent that gave up, because the developer's next move differs: never handed back, the ticket stays eligible, and the summary names it under what is waiting on the developer. The invocation carries on to its next iteration.
_Avoid_: outage, crash, system error

**Discard**:
What becomes of a failed run's branch: deleted from the project checkout, never having been pushed. A branch git refuses to delete is kept, and the hand-back comment says so rather than letting it stop the hand-back.
_Avoid_: clean up, prune, delete

**Backlog**:
One project's eligible tickets.
_Avoid_: queue (the queue spans all projects), todo list

**Ticket priority**:
The rank selection orders an implementation ticket by: one of three levels, smaller worked first; a ticket without one sorts after every ticket with one, and ties go to the oldest ticket. The smallest of the ticket's own priority label and the priority label of every open issue in the same project that reaches it by following, any number of times and in any mix, two steps: from an issue to its sub-issues, and from a ticket to the tickets blocking it. So a spec's priority label carries into its sub-issues, and what an urgent ticket waits on is worked as urgently. Never the other way: a sub-issue lends nothing to the issue it belongs to, nor a blocker to what it blocks. Any open issue passes it on, whatever its triage label; a closed issue, one in another repo, or one the loop did not read passes on nothing. Orders tickets within one project only — it never decides which project an iteration works, and never outranks a pull request ticket. Selection is what works it out, from what the tracker reports.
_Avoid_: priority (unqualified, which is the project's), inherited priority, effective priority, urgency, severity, rank

**Priority label**:
The label an issue may carry, as `priority:<level>`, naming one of the three ticket priority levels. What ticket priority is worked out from; an issue carrying more than one level counts as its smallest, and a label outside the three is ignored. Carried by any open issue, not only an eligible one: a spec left ready-for-human still lends it to its sub-issues.
_Avoid_: ticket priority (the rank worked out from the labels), priority tag

**Truncated backlog**:
A project with more open issues than the loop reads in one morning. Every open issue is read, not only eligible tickets, since ticket priority can reach a ticket through issues that are not themselves eligible; the newest are the ones read, since a new ticket given a priority label costs more to miss than an old one. An issue not read neither is selected nor passes on its priority label. The summary names the project so the developer can thin it.
_Avoid_: overflow, capped backlog, full queue

**Broken-out ticket**:
A ticket with one or more open sub-issues that are not pull request tickets: a container for that work rather than work of its own. Still carries ready-for-agent, but is not selected while any such sub-issue is open — the tracker reports how many of those are open, and selection is what reads it. A handed-back ticket with an open review ticket is not broken out. Selectable again, like any other ticket, once every such sub-issue has closed. Its ticket priority carries into its sub-issues.
_Avoid_: parent ticket, container ticket, epic, spec ticket

**Blocked ticket**:
A ticket the tracker marks as blocked by one or more tickets that are still open: its work builds on work not yet done. Still carries ready-for-agent, but is not selected while any blocker is open — the tracker reports the open count, and selection is what reads it. Selectable again once every blocker has closed. Its ticket priority carries into each blocker still open.
_Avoid_: dependent ticket, waiting ticket, stacked ticket

**Implementation ticket**:
A ticket asking for something to be built.
_Avoid_: feature ticket, build ticket

**Draft pull request**:
How a run's work reaches the developer: the branch it committed to, pushed, with a draft pull request open against the ticket it implemented. The manager opens one and never merges it; it promotes one — marks it ready for review — only when an apply-review ticket on it finishes.
_Avoid_: PR (say pull request), submission, patch

**Ticket gist**:
One sentence saying what an implementation ticket asked for — not what its diff did — written by the agent that implemented it, and opening the body of the draft pull request its run hands over. Optional: a run whose agent gave none, or gave more than one line, opens its draft pull request without one, and is no less finished for it.
_Avoid_: summary (the summary is the invocation's issue), description, synopsis

**Handover**:
What a finished run comes to for the developer: the run itself, and the draft pull request its commits are waiting in. A run that committed nothing, and one the agent did not finish, are runs without a handover. A handover that fails part way — the branch would not push, no draft pull request would open, or its review ticket could not be created — is a failed iteration: the ticket is handed back naming the branch and any pull request, the branch is kept, and the invocation carries on.
_Avoid_: work, result, outcome

**Pull request ticket**:
A review ticket, an apply-review ticket, or a rebase ticket: a sub-issue bound to one draft pull request.
_Avoid_: PR ticket, review sub-issue (unqualified)

**Rebase ticket**:
A sub-issue of an implementation ticket asking for that ticket's draft pull request to be put back on top of its base branch. Opened by a workflow in the project repo when the developer comments `/rebase`, born ready-for-agent, and selected before apply-review tickets. Finished — the repo host reporting the pull request no longer conflicting — it closes, leaving its draft state alone. The run owes tests green along the way; closing itself turns only on what the repo host reports. A pull request the repo host already reports mergeable when the iteration starts has nothing to rebase: no run starts, and the ticket closes all the same.
_Avoid_: rebase task, merge ticket, conflict ticket

**Review ticket**:
A sub-issue of an implementation ticket asking for that ticket's draft pull request to be reviewed. Created by the manager, born ready-for-agent, and selected after apply-review tickets but before any implementation ticket.
_Avoid_: review task, review job, QA ticket

**Apply-review ticket**:
A sub-issue of an implementation ticket asking for the review on its draft pull request to be acted on — every open thread applied or declined, commits pushed to that pull request. Opened by a workflow in the project repo when the developer comments `/apply-review`, born ready-for-agent, and selected after rebase tickets and before review tickets. Finished — every thread answered, as the repo host reads it — it closes and promotes the pull request, declined threads or not. A pull request with no open thread when the iteration starts has nothing to apply: no run starts, and the ticket closes and promotes it all the same.
_Avoid_: apply ticket, fix-review ticket, action ticket

### Budget

**Budget gate**:
The check made before a run starts that refuses work which would eat into the reserve. Reads the ledger's windows and adds the runs the state document records inside them, since a run's own log dies with its container. Then charges a run estimate for the run about to start and for every run still in progress, whose spend nothing can see until its container exits, so a run starts only if the reserve would survive it. A refusal the run estimates alone caused, with the windows themselves still inside what is spendable, is told apart from a window already spent. Referred to as "the gate".
_Avoid_: throttle, rate limit, quota check

**Run estimate**:
The tokens the gate charges a run before it starts, in place of the cost nobody can know until it ends. Comes from the ticket's size label, and is the same whatever model the run uses. Never revised by what earlier runs cost: the summary sets each run's cost beside its estimate and flags a run that spent more, and correcting the figure is the developer's.
_Avoid_: projection, forecast, reservation, hold, assumed cost

**Reserve**:
The fraction of a window held back for the developer's own interactive work. Each window has its own: the weekly reserve keeps the developer a week's worth of room, the 5-hour reserve keeps a morning from spending the current block whole and locking the developer out until it resets.
_Avoid_: buffer, headroom

**Budget document**:
The hand-edited document of what the mornings may spend: the two allowances, the two reserve fractions, the tokens each size is worth and the size an unsized ticket counts as, the spend ceiling, and any observed reset. `budget.json` in the manager home. Separate from the registry because the new-project command rewrites that one.
_Avoid_: budget file, limits, quota config

**Allowance**:
The tokens a window is declared to hold. Self-declared, because the provider reports consumption and never remaining quota.
_Avoid_: quota, limit, capacity

**Usage ledger**:
What reports rolling token consumption. Knowingly under-counts, since it cannot see Claude chat or other machines; the same blindness skews the 5-hour boundary it infers, which is what an observed reset corrects. Referred to as "the ledger".
_Avoid_: usage tracker, meter, monitor

**Window**:
One of the two periods consumption is measured against. The 5-hour window opens with the first
message of the current block; the weekly window opens on Sunday. Neither is a lookback from now, so
a window has an opening instant and a reset instant, and both matter to the gate.
_Avoid_: period, interval, bucket, rolling window, last 5 hours, last 7 days

**Observed reset**:
A 5-hour reset instant the developer read off the provider's own display and wrote into the budget
document, believed ahead of the boundary the ledger infers from this machine's logs. The inference
is blind to the developer's other surfaces, and its error runs one way — a block opened by a message
the ledger never saw reads as later than it was — so the observed reset is how a boundary the ledger
cannot see gets corrected. One still to come states the block now open; one already past says the
blocks before it have ended; one more than five hours out names no block at all and is refused.
_Avoid_: reset override, manual window, pinned reset

**Provider limit**:
The usage limit the provider itself enforces, which the manager learns of only through a limit refusal. The allowance is the developer's declaration of it and can be wrong, so the gate can say go while the provider says no.
_Avoid_: usage limit, rate limit, quota, session limit (the provider's own wording, for one of its windows)

**Limit refusal**:
A run, implementation, review, apply-review or rebase, that the provider limit refused: the agent CLI's whole answer is the provider's own words, reset included. Neither gave up nor finished, so never handed back: its ticket is left exactly as it was, any branch it left is discarded, what it spent is recorded, and the invocation stands down, since every run after it would be refused the same way.
_Avoid_: interrupted, limit reached, rate-limited

**Model refusal**:
A run, implementation, review, apply-review or rebase, that the agent CLI would not start on the model it was given, because the name is unknown or unavailable. Carries the model name and the CLI's own words. The ticket's model is the problem — its model label, or the model defaults for its kind — not the agent, which never gave up, and not the setup, so it is neither gave up nor an infrastructure failure.
_Avoid_: bad model, model error, invalid model

**Spend ceiling**:
The most a single run may spend, enforced by the agent CLI itself rather than by the gate.
_Avoid_: budget, limit, cap

### Observability

**Journal**:
The machine-written account of every invocation: when it started, when it ended, and what it came
to. A document in the manager home alongside the state document — but a separate one: the state
document is keyed by project and rewritten wholesale, while the journal is append-only and keyed by
time, one record per invocation. Distinct from `trigger.log` too: that file is the raw output of
whatever a trigger ran, gitignored and local to this machine, where the journal is committed and
records outcomes rather than capturing output.
_Avoid_: log (`trigger.log` is the log), history, audit trail, invocations file

**Invocation record**:
One journal entry. Opened before the loop runs, closed with the report.
_Avoid_: entry, row, event

**In flight**:
An invocation record that was opened and never closed. The invocation is either still running or
died before it could close.
_Avoid_: open, pending, stuck, orphaned

**Armed**:
A trigger that is registered on this machine and still points at this manager home. Registration
alone is not armed: a cron line naming a path that no longer exists is registered and not armed.
_Avoid_: installed, enabled, active, live

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
The container an unattended agent runs in, on a throwaway clone of one project. An implementation run's branch is fetched back into the project's checkout; a review leaves no branch, and an apply-review run pushes to its pull request's branch from inside the container, so nothing comes back from either. A rebase run force-pushes from inside the container and brings no branch back, as an apply-review run does. The clone is not kept.
_Avoid_: box, VM, runner, environment

**Throwaway clone**:
The repository one run happens in: cloned from the project's checkout, deleted when the run ends, and never the checkout itself. Shortened to _clone_ where the context is a run.
_Avoid_: workspace, worktree (it is neither), scratch directory

**Harness**:
The skills setup: baked into the sandbox image, and scaffolded into each project repo.
_Avoid_: toolkit, framework, template

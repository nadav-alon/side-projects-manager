# Side Projects Manager

The manager owns a morning loop that moves side projects forward each day by working their
eligible tickets, several at once, and a command that starts new projects. Projects stay
independent: the manager holds the registry and the harness, each project repo holds its own
backlog.

## Language

### The loop

**Morning loop**:
The job that moves side projects forward by working their eligible tickets, several at once.
Referred to as "the loop".
_Avoid_: the daily job, the cron job, the automation

**Invocation**:
One firing of the morning loop, by whichever trigger got there first. Writes exactly one summary.
_Avoid_: run, execution, session

**Iteration**:
One selection, gate check and run. Iterations of one invocation may overlap, up to the concurrency
limit, and the gate is asked before each one starts.
_Avoid_: cycle, pass, turn, loop

**Run**:
One agent execution in the sandbox against a single ticket. Carries a cost and a spend ceiling.
_Avoid_: job, session, execution, task

**Selection**:
Choosing which project and ticket an iteration works: rebase tickets first, then apply-review
tickets, then review tickets, then spec review tickets, then implementations, then explicit
priority, then least recently worked. Within the chosen project: rebase tickets first, then
apply-review tickets, then review tickets, then spec review tickets, then ticket priority, then the
oldest ticket.
_Avoid_: picking, scheduling, prioritisation

**Dry queue**:
No registered project had an eligible ticket. A normal quiet morning, reported explicitly rather
than silently.
_Avoid_: empty queue, no work, nothing found

**Worked today**:
The tickets the loop has worked on the current local calendar day, recorded in the state document
with that day. Selection passes a ticket on this record over until the next local calendar day, even
while it still carries ready-for-agent. A record for any other day reads as nothing worked today.

A ticket counts from the moment it is selected, and is saved before the sandbox starts or, ahead of
the gate, before the hand-back is posted, so a run killed part way, or a process stopped mid-post,
still counts.

A ticket counts against the day only for as long as the loop could not take its eligibility away
itself: a hand-back the tracker refused, or a review, an apply-review, a rebase or a resolved pull
request the loop could not close.

Every other ending comes off the record again the moment its own iteration ends, and a later firing
the same day — one triggered by a developer re-applying ready-for-agent by hand included — may
select it: a hand-back that landed, a close that landed, and, saying nothing about the ticket at
all, an infrastructure failure, a provider failure, a limit refusal or a budget exhaustion — except
a provider failure or a limit refusal that also filed a blocking discovery, which counts as any
other hand-back does (see **Discovery**).

Each entry also names the invocation record that recorded it, by that record's own opened-at instant
and pid; an entry naming none reads as today, same as one written before this existed. An invocation
that dies mid-run leaves its entries on the record for good — nothing ever closes its own iterations
to take them off.

The **invocation lease** means only one invocation runs at a time, so when the next invocation
acquires it, every other invocation record still **in flight** belongs to one that died before it
could close: every entry that names one of those is **freed**, selectable by this invocation, and
named in its **summary** along with the dead invocation it came from. An entry naming an invocation
that closed, one missing from the journal, or this same invocation, stays passed over, as today.
_Avoid_: seen, attempted, cooldown

**Freed**:
A worked-today entry taken off the record because the invocation that recorded it died before it
could close. Selectable again by whichever invocation next acquired the **invocation lease**, and
named in its **summary** along with the dead invocation record it came from.
_Avoid_: released, reclaimed, unblocked

**Stand down**:
What the loop does when the budget gate refuses, when a run already started is cut off, or when the
developer stops an invocation by hand: no further iteration starts, iterations already in progress
are not cancelled and finish on their own, and it says so. A second interrupt from the developer is
not a stand-down: the invocation ends at once, and whatever was in progress is lost.
_Avoid_: abort, bail, skip, fail

**Summary**:
The single issue an invocation writes in the manager repo, covering every attempt, what it cost, and
what now needs the developer. An invocation that worked something always publishes one; a quiet or
broken invocation — a dry queue, a stand-down, or an invocation failure — publishes one only if none
has been published yet that local calendar day, recorded in the state document with that day once
the publish succeeds, so a loop firing every hour still reports one quiet or broken morning rather
than up to twenty-four. "Worked something" excludes a run the provider limit refused, alongside a
ticket handed back ahead of the gate: neither ran, so an invocation whose iterations were only
those, however many, is a stand-down like any other — unless one of those limit refusals left a
branch in the project checkout, kept because git refused to delete it or salvaged on purpose, or
filed a discovery, in which case the invocation still always publishes. The title carries the local
time to the minute beside the date, since more than one summary can land on one day. A summary the
invocation composed but could not publish is a summary failure instead.
_Avoid_: report, digest, changelog

**Summary failure**:
Why a composed summary could not be published, and the body it had already composed, carried on the
invocation report as its own field rather than only as prose in the report's message. Named in the
invocation record along with where the kept summary landed, so what would otherwise be lost to the
publish failure is still readable and accounted for.
_Avoid_: publish failure, error

**Kept summary**:
The composed text of a summary failure, written into the manager home as its own plain text file,
named for the local day and time the invocation started, and gitignored like `trigger.log` rather
than committed. Absent from the invocation record when that write itself also failed — the reason
the publish failed is still worth recording even then.
_Avoid_: failed summary, backup

**Needs attention**:
Whether the morning is one the developer has to look at, carried on the invocation report: true for
an invocation that never finished, for an iteration that was an **infrastructure failure**, or for a
summary failure. Decides the exit code of an invocation that reported; one that fails before
reaching a report already exits non-zero on its own account. An agent that merely gave up is not
this: the hand-back is the failure policy working, not the setup breaking. A summary failure is,
even though nothing about the setup broke to cause it — the developer still has to go retrieve the
kept summary by hand.
_Avoid_: broken, alert

### Triggers

**Trigger**:
Whatever calls `morningLoop`: the hourly schedule, a manual `npm run morning-run`, or any future
cloud trigger. Carries no logic of its own beyond deciding whether to call — the loop itself never
knows which one called it.
_Avoid_: caller (when trigger is meant), cron job, entry point

**Logon guard**:
A trigger that once fired on every new interactive shell, dropped once the hourly schedule made it
redundant: cron starts with the machine, so nothing a shell launch would catch is missed anymore.
`scripts/install-triggers.sh` no longer installs one, only strips one left behind by an older
install, and the status command still checks for it — an rc block an upgrade hasn't cleared yet is
still armed and still firing.
_Avoid_: startup hook, login script

**Invocation lease**:
What stops two invocations overlapping, however long one runs: a file under the manager home,
created exclusively and holding the holder's pid. Acquired before the loop is invoked and released
once it ends, including when it throws, so a firing that cannot acquire it does nothing and says an
invocation is already running. A lease whose holder's pid is no longer alive is stale and is taken
over by whichever firing next asks, so a process killed mid-run does not stop the loop for good; PID
reuse after a reboot is accepted as negligible.
_Avoid_: mutex, semaphore, debounce, once-per-day lock

**Halt**:
A developer's standing "do nothing" for every trigger, engaged by `halt` and cleared by `resume`:
a firing while halted starts nothing, takes no invocation lease, and claims no day, saying so in
one line instead. Checked ahead of the invocation lease, by whatever calls `morningLoop` — the loop
itself never sees it, exactly like the lease. Distinct from pausing every project, which leaves the
loop free to run and report a dry queue: pausing is an intent about one project, a halt is an
operational statement about every trigger on this machine. Kept in a file of its own under the
manager home rather than the registry or the state document, so it survives
`scripts/install-triggers.sh` being re-run and a reboot without the developer's intent passing
through either. See ADR 0008.
_Avoid_: pause (the projects are paused; the loop is halted), disable, kill switch

### Projects

**Project**:
A side project the developer owns: one GitHub repo, carrying its own backlog and its own agent
instructions.
_Avoid_: repo (when the project is meant), app, package

**Repo slug**:
How a project is named everywhere, as `owner/repo`.
_Avoid_: repo name, full name, project id, url

**Registry**:
The hand-edited document of developer intent: which projects exist, which are paused, which are
turbo, which has explicit priority. `registry.json` in the manager home.
_Avoid_: config, settings, projects file

**State**:
The machine-written document alongside the registry: when each project was last worked, what past
runs cost, and which tickets were worked today. Separate from the registry because it has a
different author and a different change rate. `state.json` in the manager home.
_Avoid_: cache, database, history file

**Paused**:
Registered but never considered.
_Avoid_: disabled, archived, muted

**Turbo**:
Standing consent, carried by a project in the registry, to apply a review without the developer
asking for it each time: for a project registered turbo, the manager posts `/apply-review` itself
once a review ticket closes with a finding on it, in place of the developer typing it on the pull
request. A clean review's ticket (see **Clean review**) closes too, but gets no such comment,
turbo or not — there is nothing on it to apply. Absent means off, so a registry that never mentions
it reads as it always did. Says nothing about who reviews or
what a review finds — only about when the developer's yes is given, per pull request or once. See
ADR 0006. The same consent covers rebasing: for a turbo project, the conflict sweep posts `/rebase`
on a conflicting pull request, in place of the developer typing it. See ADR 0007. Says nothing about
merging: that needs a further, per-ticket consent — see Turboable.
_Avoid_: auto mode, fast mode, autopilot, unattended

**Priority**:
The explicit rank a project may carry in the registry, overriding least-recently-worked ordering. A
whole number from 1 upwards, smaller worked first; a project without one sorts after every project
with one. Always a project's; the rank a ticket carries is ticket priority.
_Avoid_: rank, weight, importance, order

**Never worked**:
What a project looks like before its first run: no entry in the state document. Not an error, and
indistinguishable from a project registered this morning.
_Avoid_: unworked, new, cold

**Manager home**:
The manager's own checkout, holding the registry and the state document, both committed, and a
gitignored `transcripts/` directory of session transcripts. Distinct from the managed location,
which is where projects are cloned to.
_Avoid_: config directory, data directory, root

**Managed location**:
The predictable place the manager clones projects to. Clones the developer already has elsewhere are
never touched.
_Avoid_: workspace, checkout directory

**Scaffold**:
Installing the harness into a project checkout: the uniform files copied verbatim, and the project's
agent instructions generated fresh for it.
_Avoid_: bootstrap, template, generate (only half of it is generated)

**Proposal**:
Scaffolding a project that predates the manager, put somewhere the developer has to say yes to: a
branch and a draft pull request, never the branch their checkout was on. The project is registered
paused until it merges, because a project whose conventions are still unmerged would be worked
without them.
_Avoid_: PR (say pull request), suggestion, patch

**Uniform files**:
The half of the harness every project gets byte for byte, so that improving a convention improves it
everywhere from one source.
_Avoid_: shared files, common files, boilerplate

**Agent instructions**:
The other half: one file per project, generated for that project, saying what the project is and
pointing at its own uniform files. Never copied from another repo.
_Avoid_: prompt, system prompt, rules file

**Grilling**:
An interactive session that turns a conversation with the developer into tickets in a project's
tracker, and into the vocabulary the project uses to talk about itself. Interactive by design: what
comes out of it is what the mornings after it build. The new-project command opens a project's first
one; it is not the only one a project gets, and later grillings are where more of its work comes
from.
_Avoid_: interview, kickoff, brainstorm, planning session

**Recap**:
The one line the new-project command prints when it finishes: where the checkout landed, whether the
registry now knows the project, where its harness got to, and whether the grilling opened.
Not a **Summary**: that is the loop's own report of an invocation, not one command's.
_Avoid_: summary, report, digest, changelog

### Work

**Ticket**:
An issue in a project's own repo that the loop may work on.
_Avoid_: task, story, card, work item

**ready-for-agent**:
The triage label that makes a ticket eligible. Always written in full, as the tracker spells it —
never shortened to "ready".
_Avoid_: ready, agent-ready, afk-ready

**Eligible**:
Carrying the ready-for-agent label. The only tickets the loop may select.
_Avoid_: available, valid, approved

**Model label**:
The label a ticket may carry, as `model:<name>`, naming the model its run uses. Set by the developer
like any triage label, and read afresh each morning, so changing it changes the next run. The name
is passed through, never ranked or interpreted by the loop. Wins over the model defaults.
_Avoid_: model tag, model override, tier

**Model defaults**:
The hand-edited document naming the model each kind of ticket runs on when it carries no model
label, one name per kind and the same for every project. `models.json` in the manager home. A kind
it leaves out runs on the model the sandbox image is pinned to.
_Avoid_: model config, model settings, tiers

**Size label**:
The label a ticket may carry, as `size:<size>`, saying how much of the budget its run is expected to
spend: one of S, M, L or XL, each worth the tokens the budget document gives it. What sets the
ticket's run estimate; a ticket without one counts as the size the budget document names for unsized
tickets, and so does every pull request ticket, which never inherits its parent's size. Recommended
by triage when a ticket is made ready-for-agent. A ticket carrying two sizes counts as the larger.
Says nothing about the ticket's model: a ticket expected to run on a costlier model is sized larger.
_Avoid_: estimate label, cost label, points, effort

**ready-for-human**:
The triage label a ticket carries once the loop has stopped working on it. Also the label a
turboable ticket's pull request carries when the manager's one merge pass finds it not mergeable,
not green, or carrying a declined thread — see Turboable; there it stops the manager rather than the
loop, and moves nothing off ready-for-agent, since a pull request has no triage state of its own.
Always written in full, as the tracker spells it.
_Avoid_: needs-human, manual, blocked (a blocked ticket is something else)

**Hand back**:
What the loop does with a ticket whose run gave up, finished, or filed a blocking discovery, or
whose model it cannot use — a model refusal, or model labels that name no one usable model — or
whose size label names no size the budget document knows, or, for a rebase ticket, whose pull
request the repo host never settles as conflicting or not: a comment saying what happened, and a
move from ready-for-agent to ready-for-human. Also the whole of the no-retry rule, since a ticket
without ready-for-agent is not eligible the next morning. Only those: a run that was an
infrastructure failure, a provider failure, or that the provider limit refused, says nothing about
the ticket, so the ticket is left exactly as it was — unless it also filed a blocking discovery,
which hands it back all the same (see **Discovery**). Checked against the tracker first: a ticket
already closed — by an overlapping run that finished it first, most commonly — is left exactly as it
is, no comment and no label touched, and the summary does not list it as waiting on the developer.
_Avoid_: return, bounce, escalate, reassign

**Gave up**:
A run whose agent ran and stopped short — it said it could not, left the tests red, for a review,
posted neither a review nor a finding to the pull request — a clean review, with a review posted and
no finding on it, counts as finishing, not this — or, for an apply-review run, left a thread on its
pull request unanswered or had its push rejected because the pull request's branch moved on the repo
host, or, for a rebase run, could not resolve a conflict green. The ticket is the problem: a branch
that moved since the review is one the review no longer describes, and whether to ask again is the
developer's call, so it is handed back rather than left eligible as an infrastructure failure would
be.
_Avoid_: crashed, errored, failed (say which of the two)

**Discovery**:
Something a run learned about its ticket that the developer has to act on. One of four kinds, and
the kind alone decides whether it is blocking: a correction (the ticket is wrong) and a prerequisite
(the work needs something nobody ticketed) are blocking; a clarification (the ticket is ambiguous,
and how the agent read it) and a suggestion (work worth doing that the ticket does not cover, by
changing behavior or removing a real hazard — a future bug, a doc false enough to mislead) are
advisory. Never a **Nit**: touching only names, glossary entries, prose, comments or wrapping is
never a discovery of any kind, whichever kind a run is tempted to file it as. Always about the
ticket, never the diff — what a reviewer says about the diff is a review finding, posted to the
pull request. A blocking discovery stops the run and hands its ticket back; an advisory one rides
alongside a run that finishes. Stops the run whichever way it was already ending, a cut-off by the
provider included: a limit refusal or a provider failure that also filed one hands its ticket back
instead of leaving it eligible, discarding rather than salvaging whatever it committed, but the
invocation still stands down over it exactly as it would without the discovery (see **Cut off**).
One filed by a pull request ticket's run is about the implementation ticket it belongs to, and lands
there, while the pull request ticket is the one handed back. One filed by a spec review ticket's run
is about the supertask it reviews, and lands there, while the spec review ticket is the one handed
back. Neither is the agent giving up nor the setup failing: the ticket itself is wrong or
incomplete. By kind: a correction or a clarification becomes a comment on the target; a prerequisite
becomes a discovered ticket that blocks it; a suggestion becomes a discovered ticket with no edge,
but at most the first one a run files is acted on — the rest are dropped and counted, since a
run's own ticket already carries what it found and a pile of unread suggestions helps nobody.
Clarifications carry no such cap.
_Avoid_: finding, note, observation, feedback

**Nit**:
Something a run notices about the code that touches only names, glossary entries, prose, comments
or wrapping — never a discovery of any kind, whatever the temptation, and never a suggestion (see
**Discovery**), which changes behavior or removes a real hazard instead. One the run's own change
caused is fixed in that same commit, as part of the change; any other is listed in the pull
request body for the review to turn into a finding, rather than filed as a ticket of its own.
_Avoid_: suggestion, minor, cosmetic

**Ready discovery**:
A discovery its filer declares leaves no decision to the developer, so it skips triage: a
prerequisite or a suggestion, born `ready-for-agent` and `size:S` instead of `needs-triage`, the
moment its filer marks it `ready` and its body itself reads as an agent brief — current behavior,
desired behavior, acceptance criteria, out of scope. Not a correction or a clarification, neither of
which opens a ticket to skip triage on. Falls back to `needs-triage`, as any other discovery does,
when the body is not an agent brief, or when the run declaring it is itself working a ticket born
from a ready discovery — one hop only, so unreviewed work never chains, the **chain guard**. Still
blocks its target like any other prerequisite, and still counts against the one-suggestion cap like
any other suggestion: `ready` changes only the state and size it is born with.
_Avoid_: trivial, auto-triaged

**Dropped discovery**:
A file under a run's `/discoveries` mount that never became a discovery: not valid JSON, or naming a
kind outside the four. Counted rather than carried, so the caller can report how many there were,
and never fails the run on its own.
_Avoid_: invalid discovery, malformed discovery, discarded discovery

**Infrastructure failure**:
A run that never happened, or whose work never reached the checkout, because the sandbox or the repo
host could not do its part — before the agent started, or after it stopped, such as a branch that
could not be fetched back. The setup is the problem. What an agent that did start spent is still
recorded against its project. Reported apart from an agent that gave up, because the developer's
next move differs: never handed back, the ticket stays eligible, and the summary names it under what
is waiting on the developer. What an implementation agent that did start left is salvaged, wherever
it can still be reached. The invocation carries on.
_Avoid_: outage (a provider failure, if the provider was down), crash, system error

**Discard**:
What becomes of the branch of a run that gave up or filed a blocking discovery: deleted from the
project checkout, never having been pushed. A branch git refuses to delete is kept, and the
hand-back comment says so rather than letting it stop the hand-back.
_Avoid_: clean up, delete

**Salvage**:
What becomes of the work an implementation run left when it was stopped before its agent ended it —
a limit refusal, an infrastructure failure after the agent started, or its own spend ceiling
stopping it: its uncommitted changes committed as they stand, marked as possibly broken, and its
branch kept in the project checkout, never pushed, for the ticket's next run to continue on, as that
run's own branch — except a limit refusal that also filed a blocking discovery, whose branch is
discarded instead (see **Discovery**). Nothing about the ticket changes otherwise. A run that
continues on a salvage and then gives up is discarded, salvage and all.
_Avoid_: leftover, WIP branch, partial run, resume branch

**Run window**:
When a ticket's own run last started, and when it ended — recorded in the state document, keyed by
the ticket's repo and number, one window per ticket: a ticket run more than once keeps only its
latest run's window. Durable where **Run in progress** is not: that one is carried on the
invocation's own journal record and cleared the moment the run ends, so nothing survives to say when
a finished run started once its own invocation record has closed, let alone once the day has rolled
over. `endedAt` absent while that run is still going. What ADR 0009's merge gate reads to check a
`turboable` label's timeline against the implementation run it must not have been added during.
_Avoid_: run history, active run

**Backlog**:
One project's eligible tickets.
_Avoid_: queue (the queue spans all projects), todo list

**Ticket priority**:
The rank selection orders an implementation ticket by: one of three levels, smaller worked first; a
ticket without one sorts after every ticket with one, and ties go to the oldest ticket. The smallest
of the ticket's own priority label and the priority label of every open issue in the same project
that reaches it by following, any number of times and in any mix, two steps: from an issue to its
sub-issues, and from a ticket to the tickets blocking it. So a spec's priority label carries into
its sub-issues, and what an urgent ticket waits on is worked as urgently. Never the other way: a
sub-issue lends nothing to the issue it belongs to, nor a blocker to what it blocks. Any open issue
passes it on, whatever its triage label; a closed issue, one in another repo, or one the loop did
not read passes on nothing. Orders tickets within one project only — it never decides which project
an iteration works, and never outranks a pull request ticket. Selection is what works it out, from
what the tracker reports.
_Avoid_: priority (unqualified, which is the project's), inherited priority, effective priority,
urgency, severity, rank

**Priority label**:
The label an issue may carry, as `priority:<level>`, naming one of the three ticket priority levels.
What ticket priority is worked out from; an issue carrying more than one level counts as its
smallest, and a label outside the three is ignored. Carried by any open issue, not only an eligible
one: a spec left ready-for-human still lends it to its sub-issues.
_Avoid_: ticket priority (the rank worked out from the labels), priority tag

**Truncated backlog**:
A project with more open issues than the loop reads in one morning. Every open issue is read, not
only eligible tickets, since ticket priority can reach a ticket through issues that are not
themselves eligible; the newest are the ones read, since a new ticket given a priority label costs
more to miss than an old one. An issue not read neither is selected nor passes on its priority
label. The summary names the project so the developer can thin it.
_Avoid_: overflow, capped backlog, full queue

**Supertask**:
A ticket carrying the supertask label: a container for its work rather than work of its own.
Declared, never inferred from its sub-issue count — the tracker reports whether the label is
present, and selection is what reads it. Still carries ready-for-agent, but is not selected while it
carries the supertask label, and stays a container until the ticket itself is closed: closing every
sub-issue does not make it selectable, unlike a blocked ticket — it opens a spec review as a
sub-issue of its own instead, see "Spec review sweep". Its ticket priority carries into its
sub-issues. A ticket with an open sub-issue that is not a pull request ticket, yet no supertask
label, is a likely missed label — reported by the morning scan, not treated as a supertask itself.
_Avoid_: parent ticket, container ticket, epic, spec ticket, broken-out ticket

**Blocked ticket**:
A ticket the tracker marks as blocked by one or more tickets that are still open: its work builds on
work not yet done. Still carries ready-for-agent, but is not selected while any blocker is open —
the tracker reports the open count, and selection is what reads it. Selectable again once every
blocker has closed. Its ticket priority carries into each blocker still open.
_Avoid_: dependent ticket, waiting ticket, stacked ticket

**Implementation ticket**:
A ticket asking for something to be built.
_Avoid_: feature ticket, build ticket

**Draft pull request**:
How a run's work reaches the developer: the branch it committed to, pushed, with a draft pull
request open against the ticket it implemented. The manager opens one and merges it only for a
turboable ticket — see Turboable. It promotes one — marks it ready for review — only when an
apply-review ticket on it finishes.
_Avoid_: PR (say pull request), submission, patch

**Ticket gist**:
One sentence saying what an implementation ticket asked for — not what its diff did — written by the
agent that implemented it, and opening the body of the draft pull request its run hands over.
Optional: a run whose agent gave none, or gave more than one line, opens its draft pull request
without one, and is no less finished for it.
_Avoid_: summary (the summary is the invocation's issue), description, synopsis

**Handover**:
What a finished run comes to for the developer: the run itself, and the draft pull request its
commits are waiting in. A run that committed nothing, and one the agent did not finish, are runs
without a handover. A handover that fails part way — the branch would not push, no draft pull
request would open, or its review ticket could not be created — is a failed iteration: the ticket is
handed back naming the branch and any pull request, the branch is kept, and the invocation carries
on.
_Avoid_: work, result, outcome

**Pull request ticket**:
A review ticket, an apply-review ticket, or a rebase ticket: a sub-issue bound to one draft pull
request.
_Avoid_: PR ticket, review sub-issue (unqualified)

**Pull request resolved**:
What a pull request ticket's iteration finds when the repo host already reports its own pull request
merged or closed — checked before anything else the iteration would otherwise do, and before even a
rebase ticket's own mergeability check. The ticket closes with a comment naming which, and no run
starts: its branch is commonly gone with the pull request, so a run started on it would only fail
the same way every morning after. Closed rather than handed back, since coming round again would
find the same pull request in the same state.
_Avoid_: resolved, settled, pull request outcome

**Rebase ticket**:
A sub-issue of an implementation ticket asking for that ticket's draft pull request to be put back
on top of its base branch. Opened by a workflow in the project repo when the developer comments
`/rebase` — or, for a turbo project, when the conflict sweep does — born ready-for-agent, and
selected before apply-review tickets; the same workflow labels the pull request `needs-rebase`, so
it reads as not mergeable without the developer having to open the ticket to see why. Finished — the
repo host reporting the pull request no longer conflicting — it closes and takes `needs-rebase` back
off the pull request, leaving its draft state alone; removing the label is the whole signal, since a
rebased pull request may still be an unreviewed draft. The run owes tests green along the way;
closing itself turns only on what the repo host reports. A pull request the repo host already
reports not conflicting when the iteration starts has nothing to rebase: no run starts, and the
ticket closes and the label comes off all the same, whether or not the pull request ever carried it.
One whose own pull request is already merged or closed closes the ticket the same way, without
mergeability ever being asked, but leaves `needs-rebase` alone: that path only closes the ticket,
never touching the label. One whose mergeability the repo host never settles is handed back, with no
run, and the label left on.
_Avoid_: rebase task, merge ticket, conflict ticket, sync ticket, update-branch ticket

**Conflict sweep**:
A pass, before every selection, over the open pull requests of every project that is not paused,
limited to those naming the ticket they close. Each is asked once whether it conflicts with its base
branch. A conflicting one is labelled `needs-rebase`; a clean one has `needs-rebase` taken off,
whether a rebase ticket is still open for it or not; one the repo host has not settled yet is left
as it is, for the next sweep. For a turbo project, a conflicting pull request with no open rebase
ticket — whatever that ticket's labels — also gets `/rebase` posted on it, which opens one; every
conflicting pull request gets its own, with no cap. Catches whatever moved the base branch, most
commonly a sibling pull request merging. Best effort: nothing it is refused blocks selection or
fails the invocation, and the summary reports each label, unlabel and refusal once — but each
`/rebase` post on its own, since a pull request can be posted on more than once in one invocation
and each post opens its own ticket. See ADR 0007.
_Avoid_: mergeability sweep, conflict scan, rebase sweep, rebase check, sibling scan

**Review ticket**:
A sub-issue of an implementation ticket asking for that ticket's draft pull request to be reviewed.
Created by the manager, born ready-for-agent, and selected after apply-review tickets but before any
implementation ticket. Once a review has posted — findings confirmed, or a clean review with none —
the ticket closes and its pull request is labelled — see the Reviewed label — and, for a clean
review, marked ready for review too, since there is nothing left on it for the developer to act on. A
refusal of either is reported on the iteration rather than retried, and never reopens the ticket. One
whose own pull request is already merged or closed has nothing left to review: the ticket closes the
same way, with no run and no label.
_Avoid_: review task, review job, QA ticket

**Clean review**:
A review ticket's run that posted a pull request review since it started, carrying no findings —
neither a defect nor a nit. Closed and labelled exactly as a review with findings is, but its pull
request is also marked ready for review, and it posts no `/apply-review`, turbo project or not (see
Turbo) — there is nothing on it for the developer to apply. Told apart from a run that posted
nothing at all — still Gave up — by whether a review landed on the pull request at all, not by
whether it carries a finding.
_Avoid_: empty review, no-findings review, silent review

**Apply-review ticket**:
A sub-issue of an implementation ticket asking for the review on its draft pull request to be acted
on — every open thread applied or declined, commits pushed to that pull request. Opened by a
workflow in the project repo when the developer comments `/apply-review`, born ready-for-agent, and
selected after rebase tickets and before review tickets. Finished — every thread answered, as the
repo host reads it — it closes and promotes the pull request, declined threads or not, and the pull
request is labelled — see the Applied-review label; a refusal is reported on the iteration rather
than retried, and never reopens the ticket. A pull request with no open thread when the iteration
starts has nothing to apply: no run starts, and the ticket closes, promotes it and labels it all the
same. One whose own pull request is already merged or closed closes the same way, with no run,
nothing marked ready and no label.
_Avoid_: apply ticket, fix-review ticket, action ticket

**Spec review ticket**:
A ticket carrying the spec-review label: asks for the whole repo to be reviewed against a named
supertask's body — gaps between its sub-issues, drift from the spec, seams that do not line up —
rather than for one draft pull request to be reviewed. The first ticket kind not bound to a pull
request: `ticketKind` reads the label only where a ticket carries no pull request binding, so a
review, apply-review or rebase ticket's own kind always wins over it. Opened for a supertask by the
spec review sweep, once every one of its sub-issues has closed — see "Spec review sweep" — and, once
opened, selected between a review ticket and an implementation ticket. Its run gets the review
mount, same as a review's: a read-only throwaway clone, credentialled with `GH_REVIEW_TOKEN`, never
fetched back. It reports; it never commits, and a discovery is the one way it opens or comments on
anything of its own, exactly as every other kind's run does — see "Discovery". It ends in hand-back
like every other kind, never a close: its findings are the hand-back comment, and the ticket moves
to ready-for-human — which is what tells it apart from a review, apply-review or rebase ticket's own
success. It takes its estimate from its own size label, like any non-pull-request ticket — `size:L`
suits the scope of a whole-repo review, and is what the sweep itself opens one carrying — and
charges the unsized default where it carries none; its estimate is not a special case in the budget
gate.
_Avoid_: repo review, audit ticket, spec audit, drift check

**Spec review sweep**:
A pass, before every selection, over one project's open issues, done alongside the conflict sweep
and reading the same listing: each supertask found there — nested ones included, at every level — is
asked whether it still has an open sub-issue, cheaply and from that same listing alone. One that
does is left alone. One that does not is asked, through a dedicated read, for every sub-issue it has
ever had, open or closed: one that has never had any is left alone too, since there is nothing yet
for a review to be about, and one that already carries a spec review among them, open or closed, is
the guard firing — at most once per supertask, ever, since a live count of open sub-issues alone
would fire again the very next morning the spec review it opened closed. A supertask that clears
both checks gets its spec review opened — unless one is already sitting among the project's open
issues, unlinked: carrying the spec-review label and the exact title this supertask's own spec
review is given, the way one left behind by a tracker write that created the ticket but failed to
link it as a sub-issue would. Found, that one is linked instead, never duplicated; the guard above
cannot see it by itself, since it reads by the sub-issue relation alone and a ticket never linked
carries none. Opened or linked, its body names every sub-issue and, for each whose pull request is
not merged, that pull request's branch and state — disclosed rather than verified: read once, at
exactly this instant, through one `gh pr list`, which gives exact branches, exact merged state and
exact issue linkage without a read per sub-issue and without a new failure mode for a sub-issue that
never had a pull request. A sub-issue closed with its pull request merged, or with none at all, is
named but nothing further is said of it — closed reads as intent, not as a gap. The scan that opens
one re-reads its project's open issues once more, so the newly opened spec review is selectable the
same scan rather than only the next; one it links instead needs no re-read, since it was already
sitting, ready-for-agent, in the listing it was found unlinked in — only the link itself was
missing. Best effort, like the conflict sweep: a refusal — from the read, the open or the link
alike — is recorded and the sweep carries on to the next supertask, never stopping the invocation.
_Avoid_: repo review sweep, audit sweep, spec sweep

**Reviewed label**:
The label the manager adds to a draft pull request once its review ticket finishes, so the developer
can see the pull request's progress from the pull request list. Added as a best-effort last step,
after the ticket closes; a refusal never reopens the ticket, and the summary says the label is
missing instead. Only added, never removed.
_Avoid_: review label, QA label

**Applied-review label**:
The label the manager adds to a draft pull request once its apply-review ticket finishes and the
pull request is marked ready, so the developer can see the pull request's progress from the pull
request list. Added as a best-effort last step; a refusal never reopens the ticket, and the summary
says the label is missing instead. A pull request carrying this alongside the reviewed label is
expected, not a conflict: labels are only added, never removed.
_Avoid_: apply-review tag, done label

**Turboable**:
Per-ticket consent, the `turboable` label set by a human on an implementation ticket, letting the
manager merge its pull request once its apply-review ticket finishes — whether that ticket followed
from turbo or from the developer typing `/apply-review` by hand. Checked against the
label's own timeline — labeled before that ticket's implementation run started, not merely present
now — which stops a run granting its own ticket consent mid-run; the manager also strips `turboable`
from every ticket it opens, so one it opens can never start out carrying it. Once a turboable
ticket's apply-review ticket finishes, one
pass: the manager merges the pull request, with a merge commit, and deletes its branch, but only if
it is mergeable, green and carries no declined threads; otherwise it labels the pull request
`ready-for-human` and stops — no retry, no re-rebase. Stacked pull requests are out of scope until
that is specced. See ADR 0009.
_Avoid_: auto-merge, merge flag, greenlight

### Budget

**Budget gate**:
The check made before a run starts that refuses work which would eat into the reserve. Reads the
ledger's windows and adds the runs the state document records inside them, since a run's own log
dies with its container. Then charges a run estimate for the run about to start and for every run
still in progress, whose spend nothing can see until its container exits, so a run starts only if
the reserve would survive it. A refusal the run estimates alone caused, with the windows themselves
still inside what is spendable, is told apart from a window already spent. Referred to as "the
gate".
_Avoid_: throttle, rate limit, quota check

**Weighted token**:
A token counted by the provider's own price ratio to a fresh input token — output at five, a cache
write at 1.25, a cache read at a tenth — rather than at equal weight, since the provider publishes no
weights of its own for what counts against a session or weekly limit. What every figure in the Budget
section is stated in: the two allowances, the run estimate, and what the ledger and a run's own spend
both report.
_Avoid_: raw token, token (unqualified, inside this section)

**Run estimate**:
The weighted tokens the gate charges a run before it starts, in place of the cost nobody can know
until it ends. Comes from the ticket's size label, and is the same whatever model the run uses. Never
revised by what earlier runs cost: the summary sets each run's cost beside its estimate and flags a
run that spent more, and correcting the figure is the developer's.
_Avoid_: projection, forecast, reservation, hold, assumed cost

**Reserve**:
The fraction of a window held back for the developer's own interactive work. Each window has its
own: the weekly reserve keeps the developer a week's worth of room, the 5-hour reserve keeps a
morning from spending the current block whole and locking the developer out until it resets.
_Avoid_: buffer, headroom

**Budget document**:
The hand-edited document of what the mornings may spend: the two allowances, the two reserve
fractions, the tokens each size is worth and the size an unsized ticket counts as, the spend
ceiling, the concurrency limit, and any observed reset. `budget.json` in the manager home. Separate
from the registry because the new-project command rewrites that one.
_Avoid_: budget file, limits, quota config

**Allowance**:
The weighted tokens a window is declared to hold. Self-declared: what the provider does report of a
window's own usage — the status line's `used_percentage`, `rate_limit_event`'s utilization — reaches
neither a headless run nor the gate before it needs an answer, so there is nothing to read a true
figure from.
_Avoid_: quota, limit, capacity

**Usage ledger**:
What reports rolling weighted-token consumption. Knowingly under-counts, since it cannot see Claude
chat or other machines; the same blindness skews the 5-hour boundary it infers, which is what an
observed reset corrects. Referred to as "the ledger".
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
The usage limit the provider itself enforces, which the manager learns of only through a limit
refusal. The allowance is the developer's declaration of it and can be wrong, so the gate can say go
while the provider says no.
_Avoid_: usage limit, rate limit, quota, session limit (the provider's own wording, for one of its
windows)

**Limit refusal**:
A run, implementation, review, apply-review or rebase, that the provider limit refused: the agent
CLI's whole answer is the provider's own words, reset included. Neither gave up nor finished, so
never handed back on its own account: its ticket is left exactly as it was and an implementation
run's work is salvaged — except when the run also filed a blocking discovery, which hands the ticket
back instead, discarding rather than salvaging whatever it committed, exactly as **Discovery** says
for any other run. What it spent is recorded, and the invocation stands down either way, since every
run after it would be refused the same way.
_Avoid_: interrupted, limit reached, rate-limited

**Model refusal**:
A run, implementation, review, apply-review or rebase, that the agent CLI would not start on the
model it was given, because the name is unknown or unavailable. Carries the model name and the CLI's
own words. The ticket's model is the problem — its model label, or the model defaults for its kind —
not the agent, which never gave up, and not the setup, so it is neither gave up nor an
infrastructure failure.
_Avoid_: bad model, model error, invalid model

**Provider failure**:
A run, implementation, review, apply-review or rebase, that the agent started but the provider never
answered: down, overloaded or unreachable — or one that answered and then went silent mid-stream,
which reads the same as never answering once the run is killed for having gone quiet. The provider
is the problem, not the ticket, the agent or the setup, so it is neither gave up nor an
infrastructure failure, and never handed back on its own account: its ticket is left exactly as it
was, for a later firing to select again — except when the run also filed a blocking discovery, which
hands the ticket back instead, exactly as **Discovery** says for any other run. The invocation
stands down either way, as for any other cut-off run.
_Avoid_: outage, API error, provider down

**Stalled run**:
A run, implementation, review, apply-review or rebase, whose transcript has not grown for twenty
minutes while its container is still up — the provider answered and then went quiet mid-stream,
rather than never answering at all. Nothing else bounds a container whose API response goes silent
this way, so the sandbox kills it itself once its idle watchdog fires. Reads as a **Provider
failure** once killed: a stalled run and one that was never answered come back the same way.
_Avoid_: hung, wedged, frozen, timed out, stuck

**Cut off**:
A run the provider stopped before it finished: a limit refusal or a provider failure. Never handed
back on its own account: its ticket is left exactly as it was, what it spent is recorded, and the
invocation stands down, since every run after it would be stopped the same way — unless it also
filed a blocking discovery, which hands the ticket back instead, without changing the stand-down
(see **Discovery**). An implementation run's branch is discarded on a provider failure, same as any
other cut-off run's — but kept, as a salvage, on a limit refusal with commits and no blocking
discovery (see **Salvage**). Distinct from a budget exhaustion, which stops one run without saying
anything about the next.
_Avoid_: interrupted, killed, aborted

**Spend ceiling**:
The most a single run may spend, enforced by the agent CLI itself rather than by the gate. One
dollar figure for every ticket, or one per size label, resolved the same way `sizes` resolves the
run estimate — an unsized ticket, and every review, apply-review or rebase ticket, takes
`unsizedCountsAs`'s.
_Avoid_: budget, limit, cap

**Budget exhaustion**:
A run, implementation, review, apply-review or rebase, that its own spend ceiling stopped: the agent
CLI's envelope carries `subtype: "error_max_budget_usd"`. Not cut off in the sense that matters for
a stand-down: this run's own ceiling says nothing about the next run's, so — unlike a limit refusal
or a provider failure — it never stands the invocation down. Neither gave up nor finished, so never
handed back: its ticket is left exactly as it was, an implementation run's work is salvaged exactly
as a limit refusal's is, and what it spent is recorded.
_Avoid_: budget cutoff, spend limit hit, out of budget

**Concurrency limit**:
The most iterations one invocation has in progress at once, `maxConcurrentIterations` in the budget
document, defaulting to 1. The gate charges every iteration still in progress its own run estimate,
so raising this does not multiply an unaccounted overshoot — but an estimate set too low still lets
that many runs overshoot together, by as much as the largest ceiling in play, when the ceiling
differs by size.
_Avoid_: parallelism, workers, pool size

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
One journal entry. Opened before the loop runs, closed with the report — including where a published
summary landed, or a summary failure and where its kept summary landed.
_Avoid_: entry, row, event

**In flight**:
An invocation record that was opened and never closed. The invocation is either still running or
died before it could close.
_Avoid_: open, pending, stuck, orphaned

**Run in progress**:
One of the invocation's own **Run**s the manager has started and not yet seen end, carried on its
own in-flight invocation record: the kind of ticket it runs, the ticket's own repo and number, when
it started, where its session transcript lands, and, for a pull request ticket's run, the pull
request its ticket is bound to. Recorded the moment the manager starts the run — never parsed
back out of a prompt or a container command line — and cleared the moment the run ends, whatever it
came to. What `status` reads to name each run an in-flight invocation has going, and its agent's own
recent steps, from the transcript the run names.
_Avoid_: in-flight run, active run, live run

**Never reported**:
The invocation outcome the trigger writes for itself, rather than the loop writing it, when the
loop's process left no invocation record open at or after the instant it was spawned. Carries the
exit code that process gave the trigger — the one field no other outcome carries, since every other
outcome is the loop reporting on itself.
_Avoid_: missing, silent failure, unreported

**Armed**:
A trigger that is registered on this machine and still points at this manager home. Registration
alone is not armed: a cron line naming a path that no longer exists is registered and not armed.
_Avoid_: installed, enabled, active, live

### The seam

**Port**:
One of the seven injected dependencies the loop reaches the outside world through: issue tracker,
repo host, sandbox, usage ledger, clock, store, progress. All but progress carry something back;
progress is written to only, never read.
_Avoid_: service, client, interface, dependency

**Adapter**:
A real implementation of a port.
_Avoid_: driver, provider, backend

**Fake**:
A working in-memory implementation of a port, used to exercise the loop in tests.
_Avoid_: mock, double, spy

**Progress**:
What the loop reports about an invocation while it runs, the instant something happens — an
iteration's selection, the gate's verdict, a container starting, a run ending, the provider refusing
mid-invocation, or a second interrupt abandoning what is still running. Written through its own
port, never read back, and never the reason an invocation fails: distinct from the summary, which is
the durable record an invocation writes once it is done, and would otherwise have to be either
chatty or terse to double as both.
_Avoid_: log, terminal output, streaming

**Sandbox**:
The container an unattended agent runs in, on a throwaway clone of one project. An implementation
run's branch is fetched back into the project's checkout; a review leaves no branch, and an
apply-review run pushes to its pull request's branch from inside the container, so nothing comes
back from either. A rebase run brings no branch back either, as an apply-review run does not — it
force-pushes to the pull request's branch from inside the container. The clone is not kept.
_Avoid_: box, VM, runner, environment

**Throwaway clone**:
The repository one run happens in: cloned from the project's checkout, deleted when the run ends,
and never the checkout itself. Shortened to _clone_ where the context is a run.
_Avoid_: workspace, worktree (it is neither), scratch directory

**Session transcript**:
The agent CLI's own record of one run, written inside the container as it goes. Named in the run's
own outcome, at a directory under `transcripts/` in the manager home made fresh for that run so two
in progress at once never collide, and kept there once the container is gone — unlike the throwaway
clone, so a run that hung or spent oddly can still be read back afterwards. Gitignored like
`trigger.log` rather than committed. Pruned at the start of the next invocation once its directory
has aged past the transcript retention period.
_Avoid_: log, session log, output

**Prune**:
What becomes of a session transcript's directory once it has aged past the transcript retention
period: removed at the start of the next invocation, before any run of that invocation opens a
directory of its own. Unlike discard, this is age-based housekeeping over a whole directory of past
runs, not one run's own branch; a directory that cannot be removed is warned about and left for the
next invocation to try again, never fatal to the invocation it runs in.
_Avoid_: clean up, discard, delete

**Harness**:
The skills setup: baked into the sandbox image, and scaffolded into each project repo.
_Avoid_: toolkit, framework, template

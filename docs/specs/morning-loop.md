# Spec: The Morning Loop

## Problem Statement

I have several side projects, each in its own GitHub repo. They stall not because I run out of ideas
but because I run out of contiguous attention: the hour where I could have moved one forward gets
spent deciding *which* one to move forward, re-reading where I left off, and rebuilding context.

Meanwhile I do have the expensive, creative half of the work in me — thinking a feature through,
grilling a design, writing a ticket that actually says what it wants. What I don't have is the
patience to then sit and type the mechanical implementation of a ticket I already fully specified.

I want to wake up to work already done on whichever project deserved it, without having chosen, and
without the machine quietly eating the Claude quota I need for the thinking half.

## Solution

A manager repo that owns a **morning loop**: one job, run once a day, that picks a single side
project with available work, implements one ticket inside a sandboxed agent, opens a draft PR, and
queues a separate review of that PR to run in a fresh context.

The loop is **budget-gated**. Before every run it reads my own Claude usage from local session logs,
computes 5-hour and weekly token totals, and refuses to start if that would eat into a reserve
held back for my own work. It never asks permission and never surprises me: what it did, what it
cost, and what now needs me arrives as one summary issue each morning.

Projects stay **independent**. The manager holds the registry and the harness; each project repo
carries its own backlog, its own agent instructions, and no reference back to the manager. Deleting
the manager leaves every project working.

## User Stories

**Choosing what to work on**

1. As a developer, I want the loop to pick a project for me, so that I don't spend my attention on the choice.
2. As a developer, I want it to pick the project I've worked on least recently, so that no project quietly rots.
3. As a developer, I want to override that ordering with an explicit priority, so that a project I care about right now gets the mornings.
4. As a developer, I want to mark a project paused, so that it stays registered but is skipped.
5. As a developer, I want only tickets I've labelled ready-for-agent to be eligible, so that nothing half-specified gets built.
6. As a developer, I want review tickets selected before implementation tickets, so that finishing beats starting and PRs don't stack up unreviewed.
7. As a developer, I want the loop to consider every registered project, so that adding a repo to the registry is all it takes to include it.
8. As a developer, I want a project with no ready-for-agent tickets to be skipped silently, so that an empty backlog isn't an error.
9. As a developer, I want to know when *no* project had work, so that a quiet morning is distinguishable from a broken loop.
56. As a developer, I want to label a ticket with a priority, so that important work inside a project is built before less important work.
57. As a developer, I want unprioritised tickets worked oldest first, so that no ticket quietly rots behind newer ones.
58. As a developer, I want to be told when a project's backlog was too long to read in full, so that a ticket the loop never saw doesn't go unnoticed.

**Spending my quota safely**

10. As a developer, I want the loop to measure my recent token usage before starting, so that it never begins work it can't afford.
11. As a developer, I want a reserve of my weekly allowance held back, so that I can still do my own expensive Opus work — grilling, specs, wayfinding — after the loop has run.
12. As a developer, I want to set that reserve as a fraction I can tune, so that I can adjust once I've seen real consumption.
13. As a developer, I want the loop to check both the 5-hour and the weekly window, so that it respects both limits I am actually subject to.
14. As a developer, I want each sandbox run to carry its own hard spend ceiling, so that one pathological ticket can't drain the week before the next gate check.
15. As a developer, I want the gate re-checked between every run, so that a long session can't overshoot.
16. As a developer, I want the agents to run on Sonnet rather than Opus, so that the mechanical half of the work is the cheap half.
17. As a developer, I want to be told when the loop stood down because of the budget, so that silence is never ambiguous.
18. As a developer, I want the ledger to be deliberately conservative, so that usage it cannot see (Claude chat, other devices) doesn't cause an overrun.

**Doing the work**

19. As a developer, I want implementation to happen inside a container, so that an unattended agent can't touch anything outside the project it was given.
20. As a developer, I want the agent to work on a branch, so that nothing lands on my default branch without me.
21. As a developer, I want the agent to run against the ticket's actual text, so that it builds what I asked for.
22. As a developer, I want the sandbox to run on my subscription rather than a metered API key, so that a runaway morning costs quota and not money.
23. As a developer, I want the harness baked into the sandbox image, so that runs don't reinstall it every morning.
24. As a developer, I want runs to happen one at a time, so that budget accounting stays exact.
25. As a developer, I want a completed ticket to become a draft PR linked to its issue, so that I can review it where I already read code.
26. As a developer, I want the PR to stay a draft, so that nothing looks review-ready before I've looked at it.

**Reviewing what it built**

27. As a developer, I want review to happen in a separate agent run from implementation, so that the reviewer isn't biased by the context that produced the code.
28. As a developer, I want the review queued as a sub-ticket of the original ticket, so that the relationship is visible in the tracker and the two runs are budgeted separately.
29. As a developer, I want the manager to create that sub-ticket, so that an agent that ran out of steam can't forget to.
30. As a developer, I want review sub-tickets born ready-for-agent, so that reviews still happen on mornings when I'm not around to label them.
31. As a developer, I want the reviewer to leave findings as PR comments, so that I read them where the diff is.
32. As a developer, I want the reviewer to be unable to push, so that it stays a reviewer and doesn't become a second implementer.
33. As a developer, I want the review to check both whether the code follows the repo's standards and whether it does what the ticket asked, so that a technically clean PR solving the wrong problem is caught.

**When things go wrong**

34. As a developer, I want a failed run to leave a comment explaining what happened, so that I'm not guessing.
35. As a developer, I want a failed ticket relabelled for human attention, so that a too-hard ticket doesn't silently consume budget every morning forever.
36. As a developer, I want a failed run's branch discarded, so that dead branches don't accumulate.
37. As a developer, I want a sandbox or infrastructure failure distinguished from an agent giving up, so that I can tell a broken setup from a hard ticket.

**Knowing what happened**

38. As a developer, I want one summary each morning covering every run, so that I have a single place to catch up.
39. As a developer, I want the summary to state what it cost, so that I can calibrate the reserve.
40. As a developer, I want the summary to list what now needs me, so that my triage queue is written for me.
41. As a developer, I want normal GitHub notifications as well, so that PRs and review comments reach me the usual way.

**Running the loop**

42. As a developer, I want the loop to fire on a schedule, so that I don't start it.
43. As a developer, I want it to also fire when I first log in, if it hasn't run that day, so that a machine that was off overnight doesn't silently skip a day.
44. As a developer, I want it to run at most once per day, so that the logon trigger and the schedule can't double-fire.
45. As a developer, I want the trigger swappable without touching the loop, so that I can move it to a cloud schedule later if my machine stays off.

**Starting and registering projects**

46. As a developer, I want one command to start a new project, so that setup isn't a barrier to beginning something.
47. As a developer, I want that command to create the repo, clone it to a predictable place, install the harness, and register it, so that I don't do four things by hand.
48. As a developer, I want it to then grill me into the first tickets, so that the new project is immediately visible to the morning loop.
49. As a developer, I want that grilling to be interactive, so that I'm in the conversation that decides what the next month of mornings builds.
50. As a developer, I want each project cloned to a predictable managed location, so that a missing clone is self-healing and my existing scattered clones are left alone.
51. As a developer, I want to register an existing repo, so that projects predating the manager can join.
52. As a developer, I want a project repo to carry no reference back to the manager, so that I can walk away with just the project.

**Keeping state**

53. As a developer, I want my intent (which projects, paused, priority) in a file I hand-edit, so that changing my mind is a readable diff.
54. As a developer, I want machine-written state (last worked, spend history) kept separately, so that my intent file doesn't churn every morning.
55. As a developer, I want state committed, so that I have an audit trail and can survive losing the machine.

## Implementation Decisions

**Shape.** The manager is a TypeScript project. Its two entry points are the morning loop and the
new-project command. The loop is a library function with a thin trigger script around it, so the
schedule, the logon guard, and any future cloud trigger are all just callers.

**Sandboxing.** Agent runs happen in a container the manager drives itself, against an image defined
by a Dockerfile the manager owns, with the skills harness installed at image build time rather than
per run. The sandbox makes a throwaway clone of the project checkout, runs the agent on a
branch there, and fetches back a branch that gained commits; it clones rather than using a worktree
because a worktree's `.git` is a pointer into its parent repo and does not survive a bind mount.
The container is what bounds an unattended run, rather than a permission prompt: the blast radius is
one throwaway clone of one project. The agent inside it is granted its permissions wholesale, and
has to be — a run is unattended by definition, so there is nobody to answer a prompt, and an agent
that is asked one it cannot answer is denied and commits nothing. The isolation is the safety story;
withholding permission inside it only stops the work. See
`docs/adr/0001-manager-owns-its-container-adapter.md` — an earlier draft of this spec delegated the
run to sandcastle, which the implementation does not.

**Authentication.** The sandbox authenticates with a long-lived subscription OAuth token, not an API
key. This keeps runs on the subscription rather than metered billing, and is why the budget is
denominated in quota rather than money.

**Model selection.** Both the implementing and reviewing agents are pinned to Sonnet explicitly,
not left to the default. Opus is reserved for the developer's own interactive work.

**Ports.** The loop depends on six injected ports rather than reaching for the world directly: an
issue-tracker port, a repo-host port, a sandbox port, a usage-ledger port, a clock, and a store.
Real implementations wrap the GitHub CLI, docker, the local session logs, and the registry/state
documents.

**Registry and state are separate concerns.** The registry expresses developer intent — which
projects exist, which are paused, which has priority — and is hand-edited. State is machine-written:
when each project was last worked, and what runs cost. They are separate documents because they have
different authors and different change rates.

**Work queue.** Tickets are issues in each project's own repo, filtered to the ready-for-agent triage
label. Selection is: review tickets before implementation tickets; then explicit priority; then least
recently worked. One project per iteration. Within that project: review tickets first; then ticket
priority, read from `priority:1`–`priority:3` labels (smallest wins when several are present, anything
else is ignored); then lowest issue number. Ticket priority never influences which project is chosen.
A backlog is read up to 100 tickets, the newest ones — a newly prioritised ticket costs more to miss
than an old one — and a truncated backlog is named in the summary's waiting section.

**The budget gate.** Before each run the ledger computes 5-hour and weekly token totals from local
Claude session logs, which record per-message token counts with timestamps. Neither window is a
lookback from now: the 5-hour window opens with the first message of the current block, and the
weekly window opens on Sunday, so the ledger must find each window's opening boundary before it can
total anything inside it. A run starts only if projected consumption leaves the configured reserve
fraction of the weekly window intact. One imprecision is accepted deliberately: local logs cannot
observe usage from Claude chat or other machines, so the ledger under-counts. The reserve is sized
generously to absorb it. Each run additionally carries a hard per-run spend ceiling enforced by the
agent CLI itself.

**Review is a separate job, not a phase.** When an implementation run produces a draft PR, the
manager — not the agent — creates a sub-issue of the original ticket asking for that PR to be
reviewed, pre-labelled ready-for-agent. It is then selected like any other ticket on a later
iteration, so it runs in a clean context and is budgeted separately. This is the single deliberate
exception to the rule that only a human applies the ready-for-agent label; it is safe because the
sub-issue's scope is bounded by a PR that already exists.

**Review is advisory.** The reviewing agent comments findings on the PR and cannot push. It reviews
on two axes: conformance to the repo's documented standards, and fidelity to what the originating
ticket asked for. A reviewer that could push would become a second implementer and reintroduce
exactly the context bias the separation exists to remove.

**PR lifecycle is manual.** Draft PRs stay drafts. Nothing is auto-promoted and nothing is
auto-merged; promotion and merge are the developer's.

**Failure policy.** A run that fails — agent gives up, tests stay red, sandbox errors — discards its
branch, comments on the ticket, and relabels it for human attention. It is not retried automatically,
because a genuinely too-hard ticket left in the queue would consume budget every morning indefinitely.

**Reporting.** Each loop invocation writes one summary issue in the manager repo covering every run
attempted, what each cost, what is now waiting on the developer, and an explicit notice when the
queue was dry or the gate declined to start.

**Scheduling.** The loop is triggered by a daily schedule and by a first-logon-of-the-day guard,
whichever comes first, with a once-per-day lock so the two cannot double-fire.

**Project independence.** Creating a project scaffolds the harness *into* the project repo — uniform
harness files copied verbatim, project-specific agent instructions generated fresh for that project
rather than copied. No project repo references the manager, and no live coupling (submodule, plugin
reference) is created.

**Rollout.** The registry starts with a single pilot project. The manager repo itself is registered,
so the harness can improve itself. Remaining projects are added once the loop has proven uneventful.

## Testing Decisions

**What makes a good test here.** Tests assert externally observable behaviour of the loop: which
ticket was selected, whether a run was attempted at all, what was written back to the tracker, how
state changed. They do not assert how selection or budgeting is computed internally. A test that
would still pass after a reasonable refactor of the internals, and fail if the loop made the wrong
decision, is the target.

**Primary seam: the morning loop entry point.** The loop is exercised end to end with all six ports
faked. This is the highest available seam and carries the bulk of the suite. Behaviours covered:

- reviews are selected before implementations
- least-recently-worked ordering, and explicit priority overriding it
- within a project, ticket priority ordering, oldest-first ties, and reviews still first
- a truncated backlog appears in the summary's waiting section
- paused projects are skipped
- tickets without the ready-for-agent label are never selected
- the gate declines to start when the reserve would be breached, and the loop reports it
- the gate is re-evaluated between runs, stopping mid-loop when headroom runs out
- a successful run produces a draft PR and a pre-labelled review sub-issue
- a failed run discards the branch, comments, and relabels for human attention
- state records the project as worked, and records the run's cost
- a dry queue produces the explicit notice rather than silence
- the summary lists every attempt and what awaits the developer

**Secondary seam: the usage-ledger parser.** A pure function from session-log files to the two
windows in force at a given instant, tested against fixture logs captured from real session history.
This seam exists because the log format is an external fact rather than something tests may invent,
and because window arithmetic is far clearer to assert directly than through the loop. Cases: empty
history, entries before either window opened, an instant that falls on a window boundary, a weekly
boundary crossed mid-history, malformed lines, and totals aggregating input, output, and both cache
token fields.

**Deliberately not given their own seams.** Selection ordering and budget arithmetic are tested
through the primary seam, so they remain free to be restructured. The new-project command is
interactive by design and is not covered beyond its non-interactive scaffolding steps.

**Prior art.** None — this is a greenfield repo. The seams above establish the pattern for the
project rather than following one.

## Out of Scope

- Running the loop anywhere but the developer's own machine. A cloud trigger is anticipated by keeping
  the loop callable from any trigger, but is not built.
- Parallel runs. Sequential only.
- Automatic promotion or merging of PRs.
- Automatic triage. Applying ready-for-agent to implementation tickets stays a human act; the review
  sub-issue is the sole exception.
- Any automatic retry, escalation, or fix-ticket generation arising from review findings.
- Reading usage from Claude chat, other machines, or any provider API. The ledger is local-only and
  knowingly under-counts.
- Issue trackers other than GitHub.
- Migrating existing scattered local clones. New managed clones live in their own location; existing
  ones are left untouched.
- Onboarding the remaining side projects. The pilot is one project plus the manager itself.

## Further Notes

The design deliberately protects the expensive half of the work. Grilling, spec-writing and
wayfinding run on Opus and are where the developer's judgement actually lives; implementation and
review are mechanical and run on Sonnet. The reserve exists so the cheap half can never starve the
expensive half. Any future tuning should preserve that asymmetry.

The provider exposes consumption but not remaining quota — there is no interface that answers "how
much is left". Everything the gate does is inference from measured spend against a self-declared
ceiling. If a remaining-quota interface ever appears, the ledger port is the single place that would
change.

The review-as-separate-ticket mechanism is the least conventional decision here and the one most
worth defending: a model reviewing its own diff inside the context that produced it agrees with
itself. Splitting the run is what buys an actual second opinion, and routing it through the tracker
is what makes it budgeted, ordered, and visible rather than a hidden phase.

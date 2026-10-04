# Coding Standards

House rules for source in this repo. Implementation runs and the review's standards axis read
this file and [`docs/project-standards.md`](../project-standards.md).

## Comments outlive the review

A comment is read by whoever opens the file in a year, not by the reviewer reading the diff today.
Anything that only makes sense while the PR is open does not belong in the source.

**Write:**

- What the code is for, and why it is shaped the way it is.
- Contracts a caller can't see from the signature: what an empty result means, what is guaranteed.
- `TODO[#11]: re-check the gate between iterations.` — deferred work, tagged with its issue.

**Don't write:**

- Progress narration: _"Today this does X, because Y is #12."_
- Diff commentary: _"now corrected to…", "dropped the unused…", "renamed off…"._ That belongs in the
  commit message or the PR body, both of which are attached to the change rather than to the file.
- Ticket prose inside a doc comment: _"Running it is #7."_ Use `TODO[#7]`.

### `TODO[#n]`

The one sanctioned way to name unfinished work in source:

```
// TODO[#7]: run the selected ticket in the sandbox.
```

Grep-able, and the issue number is the whole explanation — don't restate the issue in the comment.
When the issue closes, the TODO goes with it. A `TODO` with no issue number is not allowed; if the
work isn't worth an issue, it isn't worth a `TODO`.

### Why this is a product concern, not just house style

Agents write code into this repo unattended, from a ticket. An agent narrating its own ticket into a
doc comment leaves that narration behind permanently, in a file nobody will revisit. The convention
is part of the harness the agents run under.

## A test is never weakened to go green

**A test that stands between a run and a passing suite is never weakened, skipped, disabled or
deleted to get past it.** Loosening an expectation, marking the test skipped, switching it off or
removing it all make the suite pass without making the code right.

A test whose expectation is itself wrong is not the run's to correct by editing the expectation.
If the test is wrong, the ticket is wrong or incomplete, and that is raised to the developer rather
than decided by the agent.

A test the ticket itself asks to change or remove, or whose old expectation the behavior the ticket
asks for replaces, is not covered by this rule: that is the work, not a way around it.

### Why a green suite is only worth what its tests check

A suite is the only thing a reviewer can trust without rereading every line. Agents run unattended,
and a run that cannot make a test pass has a way out that looks like success: green, with the check
that would have caught the problem gone. Nobody reads a deleted test, so the loss is invisible at
review and permanent afterwards.

## Project standards

Every project has `docs/project-standards.md`. Its rules bind as the rules here do. It may link out
to other documents, and says itself how those are treated.

It adds to this file. It may contradict a rule here only by naming that rule's heading and giving
the reason, inline. Where a contradiction is not marked that way, the rule here wins, and the review
reports the unmarked contradiction as a finding against the project file.

It may also say what a reviewer does with a class of finding — file it as a discovery rather than
post it as a review finding, for instance.

A run edits `docs/project-standards.md`, any part of it, only when its ticket asks for that. A run
that needs a rule changed stops and hands the ticket back with a correction discovery. An unasked
edit is a review finding. This covers that one file, not the documents it links to.

## Vocabulary

Names in source use the glossary in [`CONTEXT.md`](../../CONTEXT.md), including the synonyms it
tells you to avoid. Where the glossary distinguishes two terms, source may not blur them.

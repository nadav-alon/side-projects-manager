# A PRD workflow in the harness

The harness has no PRD. A project that works from PRDs conforms to tickets: a PRD becomes a
`supertask`, its body the spec, and its phases become sub-issues. None of the following is built:

- A PRD as a harness concept: a spec file in the repo that a ticket points at, with a status of its
  own.
- A feature branch that a PRD's phases merge into before one pull request reaches the base branch.
- Gate checkboxes a run ticks as each pass over the work completes.
- A second, blind agent writing a ticket's tests against a frozen interface without seeing the
  implementation.
- Steps a project adds to a run's prompt, such as a review pass of its own.

## Why this is out of scope

Each one has a counterpart the harness already carries, so a PRD workflow would be a second way to
say the same thing.

The spec is the issue body, and a supertask's spec review checks the repo against it once its
sub-issues have closed. A phase larger than one seam splits into seam tickets and a last one that
composes them, which is `docs/agents/ticket-scope.md`'s own pattern; that composing ticket carries
the phase's green checkpoint. Ordering is `blocked_by`.

A feature branch is stacking by another name, already out of scope (`stacked-tickets.md`). Each
ticket's pull request targets the base branch, and a chain that should move unattended is labelled
`turboable`.

The gates are the ticket lifecycle: a review ticket closing is the code review having run, and the
project's checks on the pull request are the tests being green. A box ticked in a file can drift
from what ran. A ticket's state cannot.

A project's own review pass is a documented coding standard the review run's standards axis already
reads, rather than a step of its own. That is what lets a project check semantic code against a
math document without the harness knowing math documents exist.

One run writes a behavior's test and its code together, and the review holds the project's test
standards against the result. Splitting them into two tickets slices thinner than a seam.

That changes if a second project arrives with the same shape and conforming costs it something the
first did not pay — a spec too large for an issue body, or a review pass no documented standard can
express.

## Prior requests

- #1214: incorporate a project's PRD workflow into the harness

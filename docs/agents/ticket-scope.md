# Ticket Scope

How big one ticket is allowed to be. Written for whoever splits a spec into tickets, and for the
agent that has to pick one up and finish it in a single pass.

## One seam per ticket

**A ticket's acceptance criteria describe behaviors of one seam. Criteria that name different seams
are different tickets.**

A **seam** is a boundary the code is allowed to change behind: a port and the adapter behind it, a
module with its own reason to change, one entry point. It is the unit a reviewer can hold in their
head and a test can pin down without dragging the rest of the system in.

Two tickets can have the same number of criteria and be nothing alike:

```
Ticket A — "Tracker port: read ready-for-agent tickets"
  - Only issues carrying the label are returned
  - A repo with no eligible issues returns empty, not an error
  - Results carry the fields selection needs
  - A tracker that cannot be reached fails loudly
  - The port is exercised against a fake

Ticket B — "New-project command"
  - The command creates a repo and clones it
  - The harness files are installed into the clone
  - Instructions are generated for that project
  - The project is appended to the registry
  - The command hands off to an interactive session
```

Both have five criteria. A is five statements about **one** port; B names five **different** ones —
a repo host, a harness installer, an instructions generator, a registry writer, a session handoff.
A is a ticket. B is a milestone wearing a ticket's clothes.

## The check

Read each criterion and name the thing that has to change for it to pass. Then look at the list of
names.

- **One name, repeated** — one ticket. Write it.
- **Several names** — one ticket per name, plus a last one that composes them. The composing ticket
  is small: it is wiring, and every part it wires already has its own tests.

Do this before the ticket is labelled ready, not after an agent has opened the pull request.

## Why the criteria count is not the measure

Counting acceptance criteria looks like a size check and isn't. A well-scoped ticket and a milestone
both land at five or six, because that is how many bullets a person writes before feeling done. The
count measures the writer's stamina; the seam list measures the work.

## What an oversized ticket looks like afterwards

If any of these show up, the ticket was too big — say so, and split what remains:

- **The pull request implements another open ticket's criteria.** Two tickets now describe the same
  code, and whoever picks up the second one rebuilds what already exists, usually a little
  differently.
- **The work discovers a prerequisite mid-flight** — a criterion cannot pass until something nobody
  ticketed is done first. That prerequisite was its own ticket, and finding it late means it ships
  unreviewed, bundled into something larger.
- **The review round concentrates on one file.** When a single seam absorbs the whole review, that
  seam deserved its own ticket and its own reviewer.

## Do not slice thinner than a seam

The rule sets a ceiling, not a target. A ticket that delivers half a port — the type without the
implementation, the happy path without the errors — cannot be reviewed on its own, because nothing
about it is true yet. Split where the system already has a joint. Do not cut new ones.

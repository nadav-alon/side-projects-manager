# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Ticket priority labels

Optional, on top of the state role. Orders `ready-for-agent` tickets within this project: smaller first, unlabelled tickets after every labelled one, ties broken by lowest issue number. Review and spec review tickets are always worked before any of them.

| Label        | Meaning                        |
| ------------ | ------------------------------ |
| `priority:1` | Work before everything else    |
| `priority:2` | Work before unlabelled tickets |
| `priority:3` | Work before unlabelled tickets, after `priority:2` |

- Apply at most one. If several are present, the smallest counts; any other `priority:` label is ignored.
- A label may not exist yet in a given repo: create it on first use (`gh label create priority:1`) before `gh issue edit --add-label`.
- They carry: a ticket counts as the smallest of its own label and the label of every open issue in this repo it is a sub-issue of (at any depth) or that it blocks (at any depth, either way mixed). Label the spec, not each sub-issue; a blocker of a `priority:1` ticket is worked as `priority:1`. A label never passes up to a parent or forward to what a ticket blocks.
- Any open issue passes its label on, including a `ready-for-human` spec. Closed issues and issues in other repos pass on nothing.
- A sub-issue labelled larger than its spec still counts as the spec's level: a label can raise a ticket's priority, never lower it.
- They only order tickets within this project. They never make one project outrank another.

## Ticket size labels

How large a ticket's run is expected to be, as `size:<size>`. Triage recommends one when moving a
ticket to `ready-for-agent`; the budget document is what sets the tokens each one is worth.

| Label     | Meaning                             |
| --------- | ------------------------------------ |
| `size:S`  | Smallest                             |
| `size:M`  | Larger than S, smaller than L        |
| `size:L`  | Larger than M, smaller than XL       |
| `size:XL` | Largest                              |

- Apply at most one recognised size. If several are present, the largest counts — overestimating is
  the safe direction.
- A ticket carrying no size label, and every review ticket regardless of its parent's size, runs as
  whatever size the budget document names for unsized tickets.
- A `size:` label naming anything other than the four above is unusable — the ticket carries it as
  written rather than any of the four sizes.
- Says nothing about which model a ticket runs on: a ticket expected to run on a costlier model is
  sized larger instead.

## Supertask label

Declares a ticket a container for its work rather than work of its own, per `CONTEXT.md`'s
"Supertask". Applied by hand — the loop only ever reads it, never applies it itself. Triage applies
it whenever triage itself breaks a ticket into sub-issues, so the container reads as one from the
start — never for the pull request tickets the loop opens against a ticket.

| Label       | Meaning                                                                |
| ----------- | ----------------------------------------------------------------------- |
| `supertask` | A container ticket. Never selected, however many of its sub-issues are open or closed. |

- A label may not exist yet in a given repo: create it on first use (`gh label create supertask`)
  before `gh issue edit --add-label`.
- The morning scan flags a likely missed label itself — a ticket with an open sub-issue that is
  not a pull request ticket, yet carries no `supertask` label — but does not apply the label; that
  stays the developer's call.
- Once every one of its sub-issues has closed, the spec review sweep opens one spec-review sub-issue
  for it, itself — see the "Spec review label" section below and `CONTEXT.md`'s "Spec review sweep".
  At most once per supertask, ever.

## Spec review label

Declares a ticket a spec review, per `CONTEXT.md`'s "Spec review ticket": a review of the whole
repo against a named supertask's body, rather than of one pull request. Applied either by hand, or
by the manager's own spec review sweep once a supertask's sub-issues have all closed — see
`CONTEXT.md`'s "Spec review sweep".

| Label         | Meaning                                                             |
| ------------- | -------------------------------------------------------------------- |
| `spec-review` | Reviews the repo against a supertask's body; reports, never commits. |

- A label may not exist yet in a given repo: create it on first use (`gh label create spec-review`)
  before `gh issue edit --add-label`.
- Only read where the ticket carries no pull request binding — a review, apply-review or rebase
  ticket's own kind always wins.

## Enhancement label

Beside `needs-triage`, the label a freshly discovered ticket is born with: it says the ticket is
new work rather than a report against existing behavior. Not one of the five canonical triage
roles above — a category label the loop applies on its own.

| Label         | Meaning                |
| ------------- | ----------------------- |
| `enhancement` | New feature or request |

- A label may not exist yet in a given repo: create it on first use (`gh label create enhancement`)
  before `gh issue edit --add-label`.

## Ready discovery label

Beside `ready-for-agent`, `size:S` and `enhancement`, the label a ticket opened by an agent — rather
than triaged by a human — is born with, marking its origin for good, even once its own
`ready-for-agent` comes off: the loop reads it on a ticket a run is working to refuse opening a
second such ticket from that run's own discoveries, so unreviewed work never chains.

| Label              | Meaning                                          |
| ------------------- | ------------------------------------------------ |
| `ready-discovery`  | Born from a discovery its filer declared ready.  |

- A label may not exist yet in a given repo: create it on first use (`gh label create ready-discovery`)
  before `gh issue edit --add-label`.
- Applied by the loop alone, at the ticket's creation, and never removed by anything afterward.

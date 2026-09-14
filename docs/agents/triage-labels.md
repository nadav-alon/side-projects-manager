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

Optional, on top of the state role. Orders `ready-for-agent` tickets within this project: smaller first, unlabelled tickets after every labelled one, ties broken by lowest issue number. Review tickets are always worked before any of them.

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

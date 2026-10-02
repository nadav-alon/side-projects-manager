---
status: accepted
---

# A host-only grant record vouches for a grant inside a run span

Amends ADR 0009's third check. That check declines a `turboable` grant that falls inside any run
span in the ticket's repo, because a run posts with the developer's own identity and so its label
cannot be told from a human's. It cannot tell the reverse either: a developer who labels a ticket
while an unrelated run is going is declined too. On 2026-10-02 two tickets labelled minutes before
their own runs were declined that way, inside an unrelated UX review's span. Decided on #1168.

## What changed

The developer's grant now leaves a mark no run can forge. `npm run grant -- owner/repo#n` adds the
`turboable` label and writes a **grant record**, `{repo, number, grantedAt}`, to `state.json`. A
sandbox run cannot write that file: the manager home is not mounted into it.

The merge gate keeps all three checks. The one difference is the third: a grant that falls inside a
run span still counts when a grant record for the ticket lies within 2 minutes of the `labeled`
event the gate found. A grant outside every span needs no record, as before. The record is read
for nothing else — not the timeline check, not stripping.

- **Within 2 minutes of the event the gate found**, not of the label's current state: removing the
  label and having it added again later makes a newer event, which an old record does not cover.
- **Used up once the gate fires**, whatever it decides — merge, `ready-for-human`, or a decline. A
  record vouches for one firing.
- **Pruned on the sweep** once its ticket is closed, so a ticket that never reached the gate does
  not keep its record. A repo whose open issues cannot be read whole keeps its records until a
  sweep that can tell.
- **Refused on a project whose `turbo` is off**: the command exits non-zero and writes nothing.
- **Written from outside the loop.** An invocation re-reads the records at every save and keeps
  those it has not used up itself, so a record written mid-invocation survives the loop's own
  writes of `state.json`.

## Known gaps

- A label clicked on GitHub during a run span still declines: it has no record. That includes a
  grant made away from the computer (#1182); the developer merges by hand meanwhile.
- The command and the loop both read and rewrite `state.json` whole, so a loop save landing between
  the command's read and its write can drop one of the loop's own changes, and a command write
  landing between the loop's read and its write can drop the record. The window is a few
  milliseconds.

ADR 0009's other known gaps are unchanged.

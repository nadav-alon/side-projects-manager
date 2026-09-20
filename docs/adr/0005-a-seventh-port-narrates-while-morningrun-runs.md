---
status: accepted
---

# A seventh port narrates while `morningRun` runs

`morningRun` reported nothing about itself until the whole invocation returned: a healthy morning
working three tickets was three silent container runs and then one line, indistinguishable from a
wedged process (#78). It now takes a `progress` port — narrow, write-only, "here is something that
just happened" — and calls it as an iteration is selected, the gate decides, a container starts, a
run ends, the provider refuses mid-invocation, and a second interrupt abandons what is still
running. A no-op adapter is the default; the terminal adapter writes each event as one plain line to
stderr.

## Why it went this way

Everything else `morningRun` reports could be recorded on either side of the call, by the
composition root, without touching its signature — #66 is explicit that the signature stays. What
#78 asks for happens *inside* an iteration, between selecting a ticket and the container exiting,
which only the loop itself can see as it happens. A seventh port, called from inside, is the only
shape that reaches there without changing what the loop returns.

`morningRun`'s own decisions are unchanged by this: `notify` swallows whatever `progress.note`
throws, so a broken terminal or a full pipe is never what fails an invocation or changes its exit
code — see `src/ports/progress.ts`.

## Considered options

- **`morningRun` returns an async iterable of events**, read as the loop runs, rather than a report
  read once it returns. Turned down: a larger change to a signature #66 is explicit about
  preserving, and it would rewrite every existing loop test — for one port among seven, that cost
  buys nothing the write-only shape doesn't already give a caller that wants to watch.
- **Folding progress into the journal.** Turned down: the journal is a durable record read
  afterwards, written once per invocation; progress is ephemeral text for whoever is watching right
  now, written many times an invocation and never read back. Collapsing them would force the journal
  to be chatty or the terminal to be terse — see CONTEXT.md's "Progress" glossary entry.

## What this costs

A seventh port is one more thing every adapter list, every `MorningLoopPorts`, and `fake-ports.ts`
carries — `fakePorts()` defaults it to the no-op adapter, so almost every existing test is
unmodified, and the ones that care swap in `FakeProgress`. Nothing about what the loop decides reads
`progress` back, so that cost is paid once, at the seams, rather than throughout the loop's logic.

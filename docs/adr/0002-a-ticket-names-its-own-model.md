---
status: accepted
---

# A ticket names its own model

The spec pinned every run to Sonnet and kept Opus for the developer's own work, with the pin baked
into the sandbox image. That is now the default rather than the rule. A ticket may carry a model
label, `model:<name>`, and a run uses whatever it names; a ticket without one runs on the model the
model defaults give its kind; a kind the model defaults leave out runs on the image's pin, which is
still Sonnet. Decided while grilling #46.

## Why it went this way

Hard tickets are the case: a ticket Sonnet gives up on is handed back, and before this the only way
to try it on a stronger model was to do it by hand. A label is how the developer already tells the
loop things about a ticket, it shows when scanning the backlog, and it can be changed on the morning
before a run as easily as the week before.

The name is passed through, never ranked or checked against a list. Restricting labels to models
"no more expensive than Sonnet" was the alternative that kept the spec's asymmetry intact, and it
was turned down because cheaper is not an order the manager can hold: prices move, and a model from
another provider has no place on a Claude-only ladder. An allowlist was turned down for the same
reason — every new model would mean editing it.

## What it looks like

- **Model label**, set by the developer and read afresh each morning. It wins over everything else.
- **Model defaults**, `models.json` in the manager home: one model per ticket kind, the same for
  every project. Its own document rather than a section of the registry, because the new-project
  command rewrites the registry and would drop it. Per-project defaults are left out; a label on the
  ticket covers a project that needs something different, and per-project can be added later without
  breaking this.
- **Review tickets do not inherit** their parent's model label. The review is split out to get a
  second opinion, and a different model is more of one, not less. Copying the label would also make
  the manager apply a label other than ready-for-agent, which it otherwise never does.
- **A model label the loop cannot use is handed back with that as the reason**, not reported as an
  agent that gave up: a name the agent CLI refuses, or two model labels on one ticket, which is
  caught before a run starts.
- **Research tickets are not covered.** The loop has no research kind yet; #98 designs it, and the
  model defaults gain an entry for it then.

## What this costs

The budget cannot tell models apart. The gate counts tokens against token allowances and the ledger
ignores which model spent them, while the provider's quota counts Opus more heavily — so mornings on
Opus eat into the reserve faster than the gate projects. The spend ceiling is one figure in dollars
for every run, so an Opus run reaches it on fewer tokens and may give up sooner on exactly the ticket
Opus was picked for. Both are accepted here and handed to #38, whose projected spend is where they
belong: the provider publishes no per-model quota weights, and inventing them would rank models
after all.

The spec's asymmetry — the unattended half of the work stays cheap so it cannot starve the
developer's half — is now kept by the defaults and the reserve, not by a pin nobody could change.
A morning full of Opus labels can spend more of the week than the spec anticipated.

## Reversing it

Removing the labels and the model defaults puts every run back on the image's pin, which never
moved.

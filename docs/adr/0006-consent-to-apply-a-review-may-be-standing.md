---
status: accepted
---

# Consent to apply a review may be standing

A review ticket's reviewer posts its findings and stops. Whether those findings are acted on has
been the developer's call, made per pull request by typing `/apply-review` on it. A project may now
give that consent once instead, as `turbo` in the registry: for a project registered turbo, the
manager posts `/apply-review` itself when a review ticket closes. Decided while grilling #324.

## Why it went this way

The reviewer still has no say. It posts findings, the ticket closes, and nothing it did decides
whether the review is applied — exactly as before. What changed is when the developer says yes, not
who says it: per pull request, or once in the registry for every pull request in that project.

That distinction is worth writing down because the code says the opposite twice without this.
`container-sandbox.ts` notes that the reviewer posts with the developer's own `GH_TOKEN`, so an
apply-review workflow cannot tell the reviewer's comment from the developer's by author, and
concludes that acting on the review is the developer's call, never the reviewer's. A reader who
finds the manager posting `/apply-review` on its own will take that comment for stale and delete
it. It is not stale: it is why turbo is a registry flag the developer writes by hand rather than
something the reviewer decides, or a default.

The registry is where it belongs for the same reason `paused` is there — the hand-edited document of
developer intent, per project, so a project can be tried on turbo without committing every other
project to it. Absent means off, so every registry written before this reads as it did.

The manager posts the literal comment rather than opening the apply-review ticket directly. The
workflow that turns that comment into a ticket is a uniform file, copied byte for byte into every
scaffolded project; a second implementation of it in the manager would be a second answer to "what
does `/apply-review` mean" that drifts from the first. The cost accepted is that the manager does
not learn whether the workflow ran: the comment is posted and the chain is out of its hands.

Only the review ticket's close path triggers it. A review a human publishes has no review ticket, so
nothing fires and turbo stays invisible to them — the conservative reading, and free, because there
is no code path that could catch a human review by accident. A human who wants their own review
applied types the comment, which is the affordance turbo is automating, not replacing.

## What it looks like

- **Turbo**, `turbo` in `registry.json`, absent or `false` for every project that has not asked for
  it. Read when a review ticket closes, nowhere else.
- **The comment**, the bare string `/apply-review`. The workflow matches its trimmed body exactly,
  so the comment carries no marker saying the manager posted it; the workflow's own reply on the
  pull request, and the iteration summary, are the trail.
- **Best effort**, like the `reviewed` label it follows: a refused comment is reported on the
  iteration and never reopens the ticket or fails the run.

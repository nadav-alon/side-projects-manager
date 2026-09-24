# Handing the supertask to a spec review

A spec review ticket names only itself. The agent finds the supertask it reviews against on its own,
as the parent issue the ticket is a sub-issue of. The manager does not look the parent up and pass it
in through the spec review request.

## Why this is out of scope

This used to be a stopgap, marked by a TODO that pointed at the missing field. #641 made the agent's
own lookup the design: the parent relation already lives in the issue tracker, and the agent reads
it with the same `gh` access it uses to read the ticket. Having the manager fetch it too would mean a
second tracker read and a second place that decides which issue is the spec, and it would save one
`gh` call per run.

That changes if a spec review ever has to run without tracker access, or against a supertask that
isn't the ticket's parent. Neither happens today.

## Prior requests

- #664: pass the supertask through to `SpecReviewRequest` instead of having the agent discover it

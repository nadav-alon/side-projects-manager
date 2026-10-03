---
status: accepted
---

# A project may layer its own image on the shared one

Reverses the Dockerfile's reason for keeping the browser in one image: "every run happens in the
same image". The shared image is `node:22-slim` plus git, gh, jq, a JRE and Playwright, which says
nothing of a C++ project's compiler or a Python project's interpreter, so a run there could neither
build nor test. Baking every project's toolchain into the shared image, a registry field of apt
packages, and a setup script run at container start were all rejected. Decided on #1213.

## What changed

A project declares what its runs need in `.sandbox/Dockerfile` in its own repo, written
`FROM side-projects-sandbox:latest` with `.sandbox/` as its build context. A project without the file
runs in the shared image, as before.

- **Built from the default branch**, from the manager's checkout of the project after it is caught
  up — never from a run's own branch. A run cannot alter the sandbox it runs in; a change takes
  effect once merged.
- **Built by the manager, when stale.** Before a run starts, a digest of the Dockerfile, the files
  in its build context and the shared image's id is compared with a label on
  `side-projects-sandbox:<owner>-<repo>`, and the image is rebuilt when they differ. A merged
  toolchain change and a rebuilt shared image both reach the next run unattended. The shared image
  itself stays built by hand.
- **Every kind of run uses it**: implementation, review, spec review, ux review, apply-review and
  rebase.
- **A failed build refuses the project's runs** — no run on it starts, of any kind, and the summary
  names the project and the failure. It never falls back to the shared image, which would run the
  work without the toolchain it needs and report the result as though it had.
- **A tool missing mid-run is a blocking discovery**: the sandbox agent is not root and its branch
  cannot change its image, so a run that needs a tool the sandbox lacks files a prerequisite asking
  for a toolchain ticket (`docs/agents/ticket-scope.md`).

## Accepted gap

A `.sandbox/Dockerfile` change cannot be verified before it merges: the sandbox has no docker, and CI
has no shared image to build on. Its first real build is the next run's start; a failure there is
loud and fixed by one more pull request.

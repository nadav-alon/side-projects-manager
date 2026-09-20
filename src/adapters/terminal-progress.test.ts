import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import {
  issueNumber,
  repoSlug,
  tokenCount,
  usd,
  type Ticket,
} from "../ports/index.ts";
import { terminalProgress } from "./terminal-progress.ts";

const PILOT = repoSlug("nadav-alon/pilot");

function ticket(number: number, title = "Add the thing"): Ticket {
  return { repo: PILOT, number: issueNumber(number), title };
}

/** Every line `console.error` was called with, in order, while `run` executes. */
function capturedStderr(t: TestContext, run: () => void): string[] {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    lines.push(line);
  });
  run();
  return lines;
}

describe("terminalProgress", () => {
  it("announces an iteration's selection, naming the repo and the ticket", (t) => {
    const progress = terminalProgress();

    const lines = capturedStderr(t, () =>
      progress.note({
        kind: "iteration-selected",
        repo: PILOT,
        ticket: ticket(7),
      }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /nadav-alon\/pilot/);
    assert.match(lines[0] as string, /#7/);
  });

  it("announces a stand-down, naming why and when the window resets", (t) => {
    const progress = terminalProgress();
    const resetsAt = new Date("2026-03-05T14:00:00.000Z");

    const lines = capturedStderr(t, () =>
      progress.note({
        kind: "stood-down",
        repo: PILOT,
        ticket: ticket(7),
        reason: "weekly-reserve",
        tokensUsed: tokenCount(900),
        spendable: tokenCount(1_000),
        resetsAt,
        estimateCharged: tokenCount(50),
      }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /#7/);
    assert.match(lines[0] as string, /weekly reserve/);
    assert.match(lines[0] as string, /900/);
    assert.match(lines[0] as string, /1,000/);
    assert.match(lines[0] as string, /2026-03-05T14:00:00\.000Z/);
  });

  it("announces a starting container, naming the spend ceiling it was given", (t) => {
    const progress = terminalProgress();

    const lines = capturedStderr(t, () =>
      progress.note({
        kind: "container-started",
        repo: PILOT,
        ticket: ticket(7),
        spendCeiling: usd(5),
      }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /#7/);
    assert.match(lines[0] as string, /\$5/);
  });

  it("announces what a run cost once it ends", (t) => {
    const progress = terminalProgress();

    const lines = capturedStderr(t, () =>
      progress.note({
        kind: "run-ended",
        repo: PILOT,
        ticket: ticket(7),
        tokensUsed: tokenCount(4242),
      }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /#7/);
    assert.match(lines[0] as string, /4,242/);
  });

  it("says nothing was left running when the developer's second interrupt finds nothing in flight", (t) => {
    const progress = terminalProgress();

    const lines = capturedStderr(t, () =>
      progress.note({ kind: "abandoning" }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /nothing was left running/i);
  });

  it("names the container and clone it is abandoning, by ticket, on the developer's second interrupt", (t) => {
    const progress = terminalProgress();
    progress.note({
      kind: "container-started",
      repo: PILOT,
      ticket: ticket(7),
      spendCeiling: usd(5),
    });

    const lines = capturedStderr(t, () =>
      progress.note({ kind: "abandoning" }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /nadav-alon\/pilot #7/);
  });

  it("no longer counts a run as abandoned once it has ended", (t) => {
    const progress = terminalProgress();
    progress.note({
      kind: "container-started",
      repo: PILOT,
      ticket: ticket(7),
      spendCeiling: usd(5),
    });
    progress.note({
      kind: "run-ended",
      repo: PILOT,
      ticket: ticket(7),
      tokensUsed: tokenCount(10),
    });

    const lines = capturedStderr(t, () =>
      progress.note({ kind: "abandoning" }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /nothing was left running/i);
  });

  it("names every run still in flight, when more than one is", (t) => {
    const progress = terminalProgress();
    progress.note({
      kind: "container-started",
      repo: PILOT,
      ticket: ticket(7),
      spendCeiling: usd(5),
    });
    progress.note({
      kind: "container-started",
      repo: PILOT,
      ticket: ticket(8),
      spendCeiling: usd(5),
    });

    const lines = capturedStderr(t, () =>
      progress.note({ kind: "abandoning" }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /#7/);
    assert.match(lines[0] as string, /#8/);
  });
});

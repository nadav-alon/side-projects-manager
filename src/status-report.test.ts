import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { localDay, processId, repoSlug, tokenCount } from "./ports/index.ts";
import { statusReport, type StatusJournal, type StatusRecord } from "./status-report.ts";

const NOW = new Date("2026-09-17T09:00:00.000Z");
const TODAY = localDay(NOW);
const PILOT = repoSlug("nadav-alon/pilot");

function journal(...records: StatusRecord[]): StatusJournal {
  return { records };
}

function closed(
  openedAt: string,
  overrides: Partial<StatusRecord> = {},
): StatusRecord {
  return {
    openedAt: new Date(openedAt),
    process: processId(1234),
    closedAt: new Date(openedAt),
    outcome: "dry-queue",
    projects: [],
    ...overrides,
  };
}

function open(openedAt: string, alive: boolean): StatusRecord {
  return { openedAt: new Date(openedAt), process: processId(4321), alive };
}

describe("statusReport", () => {
  it("says nothing has ever run on a machine with an empty journal", () => {
    const lines = statusReport(journal(), false, NOW);

    assert.deepEqual(lines, ["No invocation has ever run on this machine."]);
  });

  it("reports today claimed, and the most recent invocation, on a healthy morning", () => {
    const lines = statusReport(
      journal(closed("2026-09-16T08:00:00.000Z"), closed("2026-09-17T08:00:00.000Z")),
      true,
      NOW,
    );

    assert.equal(lines[0], `Today (${TODAY}) is claimed.`);
    assert.match(lines[1]!, /Most recent invocation:.*a dry queue/);
  });

  it("says today has not been claimed yet when the loop has not run today", () => {
    const lines = statusReport(
      journal(closed("2026-09-16T08:00:00.000Z")),
      false,
      NOW,
    );

    assert.equal(
      lines[0],
      `Today (${TODAY}) has not been claimed yet: the loop has not run today.`,
    );
  });

  it("calls out today's summary never publishing when today ran but was not claimed", () => {
    const lines = statusReport(
      journal(closed("2026-09-17T08:00:00.000Z", { outcome: "work-selected", projects: [] })),
      false,
      NOW,
    );

    assert.match(lines[0]!, /finished but its summary never published/);
  });

  it("reports a record in flight whose process is alive as still running", () => {
    const lines = statusReport(
      journal(open("2026-09-17T08:55:00.000Z", true)),
      false,
      NOW,
    );

    assert.match(lines[0]!, /still in flight/);
    assert.match(lines.join("\n"), /is still running/);
  });

  it("reports a record in flight whose process has died as died, naming what to do", () => {
    const lines = statusReport(
      journal(open("2026-09-17T08:55:00.000Z", false)),
      false,
      NOW,
    );

    const text = lines.join("\n");
    assert.match(text, /has died without closing its record/);
    assert.match(text, /re-run the loop by hand/);
  });

  it("calls out a run of consecutive failures", () => {
    const lines = statusReport(
      journal(
        closed("2026-09-15T08:00:00.000Z", { outcome: "invocation-failed" }),
        closed("2026-09-16T08:00:00.000Z", { outcome: "invocation-failed" }),
        closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" }),
      ),
      false,
      NOW,
    );

    assert.match(lines.join("\n"), /3 invocations in a row have failed/);
  });

  it("does not call out a single failure as a streak", () => {
    const lines = statusReport(
      journal(
        closed("2026-09-16T08:00:00.000Z", { outcome: "dry-queue" }),
        closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" }),
      ),
      false,
      NOW,
    );

    assert.doesNotMatch(lines.join("\n"), /in a row/);
  });

  it("names the stand-down reason for a stood-down invocation", () => {
    const lines = statusReport(
      journal(
        closed("2026-09-17T08:00:00.000Z", {
          outcome: "stood-down",
          standDownReason: "weekly-reserve: 100 of 100 tokens used",
        }),
      ),
      true,
      NOW,
    );

    assert.match(lines[1]!, /stood down: weekly-reserve/);
  });

  it("names every project a work-selected invocation worked, with its cost", () => {
    const lines = statusReport(
      journal(
        closed("2026-09-17T08:00:00.000Z", {
          outcome: "work-selected",
          projects: [{ repo: PILOT, tokensUsed: tokenCount(2_000) }],
        }),
      ),
      true,
      NOW,
    );

    assert.match(lines[1]!, /nadav-alon\/pilot \(2000 tokens\)/);
  });

  it("lists every record but the most recent as history, newest first", () => {
    const oldest = new Date("2026-09-15T08:00:00.000Z");
    const middle = new Date("2026-09-16T08:00:00.000Z");
    const lines = statusReport(
      journal(
        closed(oldest.toISOString(), { outcome: "dry-queue" }),
        closed(middle.toISOString(), { outcome: "stood-down" }),
        closed("2026-09-17T08:00:00.000Z", { outcome: "work-selected" }),
      ),
      true,
      NOW,
    );

    const historyIndex = lines.indexOf("History:");
    assert.notEqual(historyIndex, -1);
    assert.match(
      lines[historyIndex + 1]!,
      new RegExp(`${localDay(middle)}.*stood down`),
    );
    assert.match(
      lines[historyIndex + 2]!,
      new RegExp(`${localDay(oldest)}.*dry queue`),
    );
  });

  it("prints no history for a journal with only one record", () => {
    const lines = statusReport(
      journal(closed("2026-09-17T08:00:00.000Z")),
      true,
      NOW,
    );

    assert.doesNotMatch(lines.join("\n"), /History:/);
  });
});

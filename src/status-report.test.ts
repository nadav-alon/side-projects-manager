import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cronMinute, exitCode, localDay, processId, repoSlug, tokenCount } from "./ports/index.ts";
import {
  statusReport,
  type StatusJournal,
  type StatusRecord,
  type StatusTriggers,
} from "./status-report.ts";

const NOW = new Date("2026-09-17T09:00:00.000Z");
const TODAY = localDay(NOW);
const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER_HOME = "/home/dev/side-projects-manager";

const ARMED_TRIGGERS: StatusTriggers = {
  schedule: { registered: true, managerHome: MANAGER_HOME, minute: cronMinute("0") },
  logonGuard: { registered: false },
  managerHome: MANAGER_HOME,
};

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

function inFlight(openedAt: string, alive: boolean): StatusRecord {
  return { openedAt: new Date(openedAt), process: processId(4321), alive };
}

/** `statusReport`, armed and pointing at `MANAGER_HOME` unless a test says otherwise. */
function report(
  j: StatusJournal,
  todayClaimed: boolean,
  now: Date = NOW,
  triggers: StatusTriggers = ARMED_TRIGGERS,
): string[] {
  return statusReport(j, todayClaimed, now, triggers);
}

/** `lines`, with the two leading trigger lines dropped — the report below them, unaffected by trigger state. */
function body(lines: string[]): string[] {
  return lines.slice(2);
}

describe("statusReport", () => {
  it("says nothing has ever run on a machine with an empty journal", () => {
    const lines = report(journal(), false);

    assert.deepEqual(body(lines), ["No invocation has ever run on this machine."]);
  });

  it("reports today claimed, and the most recent invocation, on a healthy morning", () => {
    const lines = report(
      journal(closed("2026-09-16T08:00:00.000Z"), closed("2026-09-17T08:00:00.000Z")),
      true,
    );

    assert.equal(body(lines)[0], `Today (${TODAY}) is claimed.`);
    assert.match(body(lines)[1]!, /Most recent invocation:.*a dry queue/);
  });

  it("says today has not been claimed yet when the loop has not run today", () => {
    const lines = report(journal(closed("2026-09-16T08:00:00.000Z")), false);

    assert.equal(
      body(lines)[0],
      `Today (${TODAY}) has not been claimed yet: the loop has not run today.`,
    );
  });

  it("calls out today's summary never publishing when today ran but was not claimed", () => {
    const lines = report(
      journal(closed("2026-09-17T08:00:00.000Z", { outcome: "work-selected", projects: [] })),
      false,
    );

    assert.match(body(lines)[0]!, /finished but its summary never published/);
  });

  it("calls out today's invocation failing, naming what to do, rather than blaming the tracker", () => {
    const lines = report(
      journal(closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" })),
      false,
    );

    assert.match(body(lines)[0]!, /today's invocation failed before it could finish/);
    assert.match(body(lines)[0]!, /trigger\.log/);
    assert.doesNotMatch(body(lines)[0]!, /tracker/);
  });

  it("reports a record in flight whose process is alive as still running", () => {
    const lines = report(journal(inFlight("2026-09-17T08:55:00.000Z", true)), false);

    assert.match(body(lines)[0]!, /still in flight/);
    const text = lines.join("\n");
    assert.match(text, /is still running/);
    assert.match(text, /trigger\.log/);
  });

  it("reports a record in flight whose process has died as died, naming what to do", () => {
    const lines = report(journal(inFlight("2026-09-17T08:55:00.000Z", false)), false);

    const text = lines.join("\n");
    assert.match(text, /has died without closing its record/);
    assert.match(text, /re-run the loop by hand/);
  });

  it("calls out a run of consecutive failures", () => {
    const lines = report(
      journal(
        closed("2026-09-15T08:00:00.000Z", { outcome: "invocation-failed" }),
        closed("2026-09-16T08:00:00.000Z", { outcome: "invocation-failed" }),
        closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" }),
      ),
      false,
    );

    assert.match(lines.join("\n"), /3 invocations in a row have failed/);
  });

  it("does not extend a failure streak across a record that's still running", () => {
    const lines = report(
      journal(
        closed("2026-09-15T08:00:00.000Z", { outcome: "invocation-failed" }),
        inFlight("2026-09-16T08:00:00.000Z", true),
        closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" }),
      ),
      false,
    );

    assert.doesNotMatch(body(lines).join("\n"), /in a row/);
  });

  it("counts a died-without-closing record toward a failure streak", () => {
    const lines = report(
      journal(
        closed("2026-09-15T08:00:00.000Z", { outcome: "invocation-failed" }),
        inFlight("2026-09-16T08:00:00.000Z", false),
        closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" }),
      ),
      false,
    );

    assert.match(lines.join("\n"), /3 invocations in a row have failed/);
  });

  it("does not call out a single failure as a streak", () => {
    const lines = report(
      journal(
        closed("2026-09-16T08:00:00.000Z", { outcome: "dry-queue" }),
        closed("2026-09-17T08:00:00.000Z", { outcome: "invocation-failed" }),
      ),
      false,
    );

    assert.doesNotMatch(body(lines).join("\n"), /in a row/);
  });

  it("names the stand-down reason for a stood-down invocation", () => {
    const lines = report(
      journal(
        closed("2026-09-17T08:00:00.000Z", {
          outcome: "stood-down",
          standDownReason: "weekly-reserve: 100 of 100 tokens used",
        }),
      ),
      true,
    );

    assert.match(body(lines)[1]!, /stood down: weekly-reserve/);
  });

  it("names every project a work-selected invocation worked, with its cost", () => {
    const lines = report(
      journal(
        closed("2026-09-17T08:00:00.000Z", {
          outcome: "work-selected",
          projects: [{ repo: PILOT, tokensUsed: tokenCount(2_000) }],
        }),
      ),
      true,
    );

    assert.match(body(lines)[1]!, /nadav-alon\/pilot \(2000 tokens\)/);
  });

  it("lists every record but the most recent as history, newest first", () => {
    const oldest = new Date("2026-09-15T08:00:00.000Z");
    const middle = new Date("2026-09-16T08:00:00.000Z");
    const lines = report(
      journal(
        closed(oldest.toISOString(), { outcome: "dry-queue" }),
        closed(middle.toISOString(), { outcome: "stood-down" }),
        closed("2026-09-17T08:00:00.000Z", { outcome: "work-selected" }),
      ),
      true,
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

  it("lists a record the trigger closed for a loop that never reported, with its exit code", () => {
    const lines = report(
      journal(
        closed("2026-09-16T08:00:00.000Z", {
          outcome: "never-reported",
          exitCode: exitCode(137),
        }),
        closed("2026-09-17T08:00:00.000Z"),
      ),
      true,
    );

    const historyIndex = lines.indexOf("History:");
    assert.match(lines[historyIndex + 1]!, /never reported \(exit code 137\)/);
  });

  it("prints no history for a journal with only one record", () => {
    const lines = report(journal(closed("2026-09-17T08:00:00.000Z")), true);

    assert.doesNotMatch(body(lines).join("\n"), /History:/);
  });

  it("caps history to a screen's worth, naming how many earlier records it left out", () => {
    const lines = report(
      journal(
        closed("2026-09-10T08:00:00.000Z"),
        closed("2026-09-11T08:00:00.000Z"),
        closed("2026-09-12T08:00:00.000Z"),
        closed("2026-09-13T08:00:00.000Z"),
        closed("2026-09-14T08:00:00.000Z"),
        closed("2026-09-15T08:00:00.000Z"),
        closed("2026-09-16T08:00:00.000Z"),
        closed("2026-09-17T08:00:00.000Z"),
      ),
      true,
    );

    const historyIndex = lines.indexOf("History:");
    const historyLines = lines.slice(historyIndex + 1);
    assert.equal(historyLines.length, 6);
    assert.equal(historyLines[5], "… and 2 earlier");
  });
});

describe("statusReport's trigger lines", () => {
  it("reports the schedule armed, with the minute it fires", () => {
    const lines = report(journal(), false, NOW, {
      schedule: { registered: true, managerHome: MANAGER_HOME, minute: cronMinute("0") },
      logonGuard: { registered: false },
      managerHome: MANAGER_HOME,
    });

    assert.match(lines[0]!, /^Schedule: armed, firing every hour at :00\.$/);
  });

  it("reports the schedule not registered as a problem naming the installer", () => {
    const lines = report(journal(), false, NOW, {
      schedule: { registered: false },
      logonGuard: { registered: false },
      managerHome: MANAGER_HOME,
    });

    assert.match(lines[0]!, /^Schedule: not registered\./);
    assert.match(lines[0]!, /npm run triggers:install/);
  });

  it("reports a schedule registered but pointing elsewhere, distinctly from not registered at all", () => {
    const lines = report(journal(), false, NOW, {
      schedule: { registered: true, managerHome: "/old/checkout", minute: cronMinute("0") },
      logonGuard: { registered: false },
      managerHome: MANAGER_HOME,
    });

    assert.match(lines[0]!, /registered, but pointing at \/old\/checkout/);
    assert.match(lines[0]!, new RegExp(MANAGER_HOME.replaceAll("/", "\\/")));
    assert.match(lines[0]!, /npm run triggers:install/);
    assert.doesNotMatch(lines[0]!, /^Schedule: not registered/);
  });

  it("reports a logon guard not registered as expected, not as a problem", () => {
    const lines = report(journal(), false, NOW, {
      schedule: { registered: true, managerHome: MANAGER_HOME, minute: cronMinute("0") },
      logonGuard: { registered: false },
      managerHome: MANAGER_HOME,
    });

    assert.match(lines[1]!, /^Logon guard: not registered/);
  });

  it("reports a logon guard still armed as leftover from an older install", () => {
    const lines = report(journal(), false, NOW, {
      schedule: { registered: true, managerHome: MANAGER_HOME, minute: cronMinute("0") },
      logonGuard: { registered: true, managerHome: MANAGER_HOME },
      managerHome: MANAGER_HOME,
    });

    assert.match(lines[1]!, /still registered from an older install/);
    assert.match(lines[1]!, /npm run triggers:install/);
  });

  it("reports a logon guard registered but pointing elsewhere, distinctly from one still pointing here", () => {
    const lines = report(journal(), false, NOW, {
      schedule: { registered: true, managerHome: MANAGER_HOME, minute: cronMinute("0") },
      logonGuard: { registered: true, managerHome: "/old/checkout" },
      managerHome: MANAGER_HOME,
    });

    assert.match(lines[1]!, /pointing at \/old\/checkout/);
    assert.match(lines[1]!, /npm run triggers:install/);
  });
});

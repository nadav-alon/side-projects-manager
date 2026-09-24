import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BudgetStatus, WindowStatus } from "./budget-gate.ts";
import {
  cronMinute,
  exitCode,
  issueNumber,
  localDay,
  localTimeOfMinute,
  processId,
  repoSlug,
  tokenCount,
  transcriptDirectory,
  type RunInProgress,
} from "./ports/index.ts";
import {
  statusReport,
  type StatusJournal,
  type StatusRecord,
  type StatusRun,
  type StatusTriggers,
} from "./status-report.ts";
import type { TranscriptStep } from "./transcript-steps.ts";

const NOW = new Date("2026-09-17T09:00:00.000Z");
const TODAY = localDay(NOW);
const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER_HOME = "/home/dev/side-projects-manager";

const ARMED_TRIGGERS: StatusTriggers = {
  schedule: { registered: true, managerHome: MANAGER_HOME, minute: cronMinute("0") },
  logonGuard: { registered: false },
  managerHome: MANAGER_HOME,
};

/** A window with room to spare, for tests the budget lines don't concern. */
const IDLE_WINDOW: WindowStatus = {
  tokensUsed: tokenCount(0),
  loopSpent: tokenCount(0),
  developerSpent: tokenCount(0),
  allowance: tokenCount(1_000),
  spendable: tokenCount(1_000),
  resetsAt: new Date("2026-09-17T14:00:00.000Z"),
  reserveReached: false,
};
const IDLE_BUDGET: BudgetStatus = { fiveHour: IDLE_WINDOW, weekly: IDLE_WINDOW };

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

function inFlight(openedAt: string, alive: boolean, runs: StatusRun[] = []): StatusRecord {
  return { openedAt: new Date(openedAt), process: processId(4321), alive, runs };
}

/** `statusReport`, armed and pointing at `MANAGER_HOME`, with an idle budget, unless a test says otherwise. */
function report(
  j: StatusJournal,
  todayClaimed: boolean,
  now: Date = NOW,
  triggers: StatusTriggers = ARMED_TRIGGERS,
  budget: BudgetStatus = IDLE_BUDGET,
): string[] {
  return statusReport(j, todayClaimed, now, triggers, budget);
}

/** How many trigger lines head every report — see `body` and `budgetLines`. */
const TRIGGER_LINE_COUNT = 2;
/** How many budget lines follow the trigger lines — see `body` and `budgetLines`. */
const BUDGET_LINE_COUNT = 2;

/** `lines`, with the leading trigger lines and budget lines dropped — the report below them, unaffected by trigger or budget state. */
function body(lines: string[]): string[] {
  return lines.slice(TRIGGER_LINE_COUNT + BUDGET_LINE_COUNT);
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

describe("statusReport's run-in-progress lines", () => {
  const RUN: RunInProgress = {
    kind: "implementation",
    repo: PILOT,
    number: issueNumber(7),
    startedAt: new Date("2026-09-17T08:45:00.000Z"),
    transcriptDirectory: transcriptDirectory("/manager-home/transcripts/run-abc123"),
  };

  it("says nothing about runs when the in-flight record has none", () => {
    const lines = report(journal(inFlight("2026-09-17T08:55:00.000Z", true)), false);

    assert.doesNotMatch(lines.join("\n"), /Running:/);
  });

  it("says nothing about runs when nothing is in flight", () => {
    const lines = report(journal(closed("2026-09-17T08:00:00.000Z")), true);

    assert.doesNotMatch(lines.join("\n"), /Running:/);
  });

  it("names a run's kind, target and how long it has been running, from what the manager itself recorded", () => {
    const lines = report(
      journal(inFlight("2026-09-17T08:55:00.000Z", true, [{ run: RUN, steps: [] }])),
      false,
    );

    const text = lines.join("\n");
    assert.match(text, /implementation nadav-alon\/pilot #7/);
    assert.match(text, /running for 15m/);
  });

  it("prints a run's recent steps, oldest first, each with local time", () => {
    const steps: TranscriptStep[] = [
      { at: new Date("2026-09-17T08:46:00.000Z"), line: "Reading the ticket." },
      { at: new Date("2026-09-17T08:47:00.000Z"), line: "→ Bash: npm test" },
    ];

    const lines = report(
      journal(inFlight("2026-09-17T08:55:00.000Z", true, [{ run: RUN, steps }])),
      false,
    );

    const text = lines.join("\n");
    const first = text.indexOf("Reading the ticket.");
    const second = text.indexOf("→ Bash: npm test");
    assert.ok(first !== -1 && second !== -1 && first < second);
    assert.match(text, new RegExp(`${localTimeOfMinute(steps[0]!.at)} Reading the ticket\\.`));
    assert.match(text, new RegExp(`${localTimeOfMinute(steps[1]!.at)} → Bash: npm test`));
  });

  it("says a run's transcript could not be read yet, instead of failing, when steps is undefined", () => {
    const lines = report(
      journal(inFlight("2026-09-17T08:55:00.000Z", true, [{ run: RUN, steps: undefined }])),
      false,
    );

    assert.match(lines.join("\n"), /Transcript not readable yet/);
  });

  it("says a run was running when the invocation died, rather than that it still is", () => {
    const lines = report(
      journal(inFlight("2026-09-17T08:55:00.000Z", false, [{ run: RUN, steps: [] }])),
      false,
    );

    const text = lines.join("\n");
    assert.match(text, /Was running when the invocation died: implementation nadav-alon\/pilot #7/);
    assert.doesNotMatch(text, /\n {2}Running: /);
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

/** The two budget lines, dropping the trigger lines above them. */
function budgetLines(lines: string[]): [string, string] {
  return [lines[TRIGGER_LINE_COUNT]!, lines[TRIGGER_LINE_COUNT + 1]!];
}

describe("statusReport's budget lines", () => {
  it("prints the five-hour window before the weekly one, each naming its own consumption, allowance and percentage", () => {
    const fiveHour: WindowStatus = {
      ...IDLE_WINDOW,
      tokensUsed: tokenCount(250),
      allowance: tokenCount(1_000),
      resetsAt: new Date("2026-09-17T11:00:00.000Z"),
    };
    const weekly: WindowStatus = {
      ...IDLE_WINDOW,
      tokensUsed: tokenCount(3_000),
      allowance: tokenCount(10_000),
      resetsAt: new Date("2026-09-21T00:00:00.000Z"),
    };
    const lines = report(journal(), false, NOW, ARMED_TRIGGERS, { fiveHour, weekly });
    const [fiveHourLine, weeklyLine] = budgetLines(lines);

    assert.match(fiveHourLine, /^Five-hour window: 250 of 1,000 tokens \(25\.0%\)/);
    assert.match(weeklyLine, /^Weekly window: 3,000 of 10,000 tokens \(30\.0%\)/);
  });

  it("says when a window resets", () => {
    const lines = report(journal(), false, NOW, ARMED_TRIGGERS, {
      ...IDLE_BUDGET,
      fiveHour: { ...IDLE_WINDOW, resetsAt: new Date("2026-09-17T11:00:00.000Z") },
    });

    assert.match(
      budgetLines(lines)[0],
      new RegExp(`Resets ${localDay(new Date("2026-09-17T11:00:00.000Z"))}`),
    );
  });

  it("splits a window's consumption between what the loop spent and what the developer spent", () => {
    const lines = report(journal(), false, NOW, ARMED_TRIGGERS, {
      ...IDLE_BUDGET,
      weekly: {
        ...IDLE_WINDOW,
        tokensUsed: tokenCount(1_000),
        loopSpent: tokenCount(700),
        developerSpent: tokenCount(300),
      },
    });

    assert.match(budgetLines(lines)[1], /loop spent 700, developer spent 300/);
  });

  it("says the reserve has room, without claiming the gate would let a run start", () => {
    const lines = report(journal(), false, NOW, ARMED_TRIGGERS, {
      ...IDLE_BUDGET,
      fiveHour: { ...IDLE_WINDOW, reserveReached: false },
    });

    assert.match(budgetLines(lines)[0], /The reserve has room\.$/);
    assert.doesNotMatch(budgetLines(lines)[0], /would let a run start/);
  });

  it("says the reserve is already reached when the gate would refuse a run now", () => {
    const lines = report(journal(), false, NOW, ARMED_TRIGGERS, {
      ...IDLE_BUDGET,
      weekly: { ...IDLE_WINDOW, reserveReached: true },
    });

    assert.match(
      budgetLines(lines)[1],
      /reserve is already reached: the gate would refuse a run now/,
    );
  });
});

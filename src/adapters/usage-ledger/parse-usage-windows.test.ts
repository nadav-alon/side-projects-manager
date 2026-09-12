import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parseUsageWindows } from "./parse-usage-windows.ts";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("parseUsageWindows", () => {
  it("returns zero totals for empty history, rather than failing", () => {
    const windows = parseUsageWindows([fixture("empty.jsonl")], NOW);

    assert.equal(windows.fiveHour.tokensUsed, 0);
    assert.equal(windows.weekly.tokensUsed, 0);
  });

  it("aggregates input, output, and both cache token fields", () => {
    const windows = parseUsageWindows([fixture("token-fields.jsonl")], NOW);

    // 111 input + 222 output + 333 cache-creation + 444 cache-read
    assert.equal(windows.fiveHour.tokensUsed, 1110);
    assert.equal(windows.weekly.tokensUsed, 1110);
  });

  it("skips malformed lines without aborting the parse", () => {
    const windows = parseUsageWindows([fixture("malformed.jsonl")], NOW);

    // only the one well-formed entry (40 input + 10 output) should count
    assert.equal(windows.fiveHour.tokensUsed, 50);
  });

  describe("against a history spanning weeks and five-hour blocks", () => {
    const windows = parseUsageWindows([fixture("session-history.jsonl")], NOW);

    it("excludes entries outside both windows", () => {
      // the 2026-08-20 entry (1500 tokens) predates the weekly window
      // (opened 2026-08-30) and any five-hour block near `now`
      assert.equal(windows.weekly.tokensUsed, 225);
      assert.equal(windows.fiveHour.tokensUsed, 110);
    });

    it("counts an entry straddling the weekly boundary in the correct window", () => {
      // 23:59:59.999 the Saturday before falls in the prior week (excluded);
      // 00:00:00.000 the following instant opens the current week (included)
      assert.equal(windows.weekly.openedAt.toISOString(), "2026-08-30T00:00:00.000Z");
      assert.equal(windows.weekly.tokensUsed, 225);
    });

    it("counts an entry straddling a five-hour block boundary in the correct window", () => {
      // 05:00 opens a block; the 10:00 entry lands exactly five hours later,
      // which opens the next block rather than extending the first
      assert.equal(windows.fiveHour.openedAt.toISOString(), "2026-09-05T10:00:00.000Z");
      assert.equal(windows.fiveHour.tokensUsed, 110);
    });

    it("computes windows relative to the injected clock, not wall time", () => {
      assert.ok(windows.fiveHour.openedAt < NOW);
      assert.ok(windows.fiveHour.resetsAt > NOW);
      assert.ok(windows.weekly.openedAt < NOW);
      assert.ok(windows.weekly.resetsAt > NOW);
    });
  });

  it("treats a window as reset, not still open, at the instant `now` equals `resetsAt`", () => {
    // one entry opens a block exactly five hours before `now`, so its
    // `resetsAt` lands exactly on `now` — the reset instant is the boundary
    // of the next window, not the last instant of this one
    const entry = logLine({
      timestamp: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(),
      inputTokens: 40,
      outputTokens: 10,
    });

    const windows = parseUsageWindows([entry], NOW);

    assert.equal(windows.fiveHour.openedAt.toISOString(), NOW.toISOString());
    assert.equal(windows.fiveHour.tokensUsed, 0);
  });

  describe("given a reset the developer observed", () => {
    function at(time: string, tokens: number): string {
      return logLine({
        timestamp: `2026-09-05T${time}:00.000Z`,
        inputTokens: tokens,
        outputTokens: 0,
      });
    }

    it("takes a reset still to come as the block now open, whatever the logs suggest", () => {
      // the logs would open the block at 09:00 and reset it at 14:00; the
      // provider says it resets at 13:00, so it opened at 08:00 and the 07:30
      // entry belongs to the block before it
      const windows = parseUsageWindows(
        [[at("07:30", 7), at("09:00", 100), at("11:00", 50)].join("\n")],
        NOW,
        new Date("2026-09-05T13:00:00.000Z"),
      );

      assert.equal(
        windows.fiveHour.openedAt.toISOString(),
        "2026-09-05T08:00:00.000Z",
      );
      assert.equal(
        windows.fiveHour.resetsAt.toISOString(),
        "2026-09-05T13:00:00.000Z",
      );
      assert.equal(windows.fiveHour.tokensUsed, 150);
    });

    it("drops the spend of blocks a past reset ended, and infers the open one from what follows", () => {
      // the straddle this exists to repair: the logs see no message between
      // 08:40 and the reset, so they read one block still open and holding
      // all 62 tokens, when 55 were spent in a block that has since ended
      const logs = [at("08:40", 55), at("10:10", 7)].join("\n");

      const inferred = parseUsageWindows([logs], NOW);
      assert.equal(
        inferred.fiveHour.openedAt.toISOString(),
        "2026-09-05T08:40:00.000Z",
      );
      assert.equal(inferred.fiveHour.tokensUsed, 62);

      const corrected = parseUsageWindows(
        [logs],
        NOW,
        new Date("2026-09-05T10:00:00.000Z"),
      );
      assert.equal(
        corrected.fiveHour.openedAt.toISOString(),
        "2026-09-05T10:10:00.000Z",
      );
      assert.equal(corrected.fiveHour.tokensUsed, 7);
    });

    it("reports an empty window when a past reset leaves no messages after it", () => {
      const windows = parseUsageWindows(
        [at("06:40", 55)],
        NOW,
        new Date("2026-09-05T08:00:00.000Z"),
      );

      assert.equal(windows.fiveHour.openedAt.toISOString(), NOW.toISOString());
      assert.equal(windows.fiveHour.tokensUsed, 0);
    });

    it("leaves the inference alone when the observed reset is old enough to discard nothing", () => {
      const logs = [fixture("session-history.jsonl")];

      assert.deepEqual(
        parseUsageWindows(logs, NOW, new Date("2026-08-01T00:00:00.000Z"))
          .fiveHour,
        parseUsageWindows(logs, NOW).fiveHour,
      );
    });

    /**
     * The one direction a wrong instant is expensive in. Believed, it would
     * state a window that has not opened, which holds no entries and no run
     * costs — an empty 5-hour window waving every morning through.
     */
    it("refuses a reset further ahead than a block is long, rather than believing it", () => {
      const logs = [at("09:00", 90), at("11:00", 5)].join("\n");

      assert.throws(
        () => parseUsageWindows([logs], NOW, new Date("2027-09-05T13:00:00.000Z")),
        /observedResetAt/,
      );
    });

    it("accepts a reset a whole block ahead, which is as far as one can honestly be", () => {
      const windows = parseUsageWindows(
        [at("09:00", 90)],
        NOW,
        new Date(NOW.getTime() + 5 * 60 * 60 * 1000),
      );

      assert.equal(windows.fiveHour.openedAt.toISOString(), NOW.toISOString());
      assert.equal(windows.fiveHour.tokensUsed, 0);
    });

    it("corrects the five-hour window without touching the weekly one", () => {
      const logs = [fixture("session-history.jsonl")];

      assert.deepEqual(
        parseUsageWindows(logs, NOW, new Date("2026-09-05T11:00:00.000Z"))
          .weekly,
        parseUsageWindows(logs, NOW).weekly,
      );
    });
  });
});

function logLine(options: {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: {
      model: "claude-sonnet-5",
      id: "msg_boundary",
      type: "message",
      role: "assistant",
      content: "REDACTED",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: options.inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: options.outputTokens,
      },
    },
    type: "assistant",
    uuid: "c1000000-0000-0000-0000-000000000001",
    timestamp: options.timestamp,
    sessionId: "boundary-test",
    version: "2.1.261",
  });
}

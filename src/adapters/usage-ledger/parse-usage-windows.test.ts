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
});

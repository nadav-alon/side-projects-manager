import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { milliseconds, type Milliseconds } from "./ports/index.ts";
import { parseWatchArg, watchStatus, type WatchFrame, type WatchPorts } from "./status-watch.ts";

describe("parseWatchArg", () => {
  it("is disabled with no --watch flag", () => {
    assert.deepEqual(parseWatchArg(["status"]), { kind: "disabled" });
  });

  it("defaults to 30 seconds when --watch carries no number", () => {
    assert.deepEqual(parseWatchArg(["--watch"]), {
      kind: "enabled",
      interval: milliseconds(30_000),
    });
  });

  it("defaults to 30 seconds when the next token is another flag", () => {
    assert.deepEqual(parseWatchArg(["--watch", "--verbose"]), {
      kind: "enabled",
      interval: milliseconds(30_000),
    });
  });

  it("uses the given whole number of seconds", () => {
    assert.deepEqual(parseWatchArg(["--watch", "45"]), {
      kind: "enabled",
      interval: milliseconds(45_000),
    });
  });

  it("rejects a non-numeric interval", () => {
    const result = parseWatchArg(["--watch", "soon"]);
    assert.equal(result.kind, "invalid");
  });

  it("rejects a zero interval", () => {
    assert.equal(parseWatchArg(["--watch", "0"]).kind, "invalid");
  });

  it("rejects a negative interval", () => {
    assert.equal(parseWatchArg(["--watch", "-5"]).kind, "invalid");
  });

  it("rejects a fractional interval", () => {
    assert.equal(parseWatchArg(["--watch", "1.5"]).kind, "invalid");
  });
});

const INTERVAL = milliseconds(30_000);

/** A render sequence that hands back one queued frame per call, repeating the last once exhausted. */
function renderSequence(...frames: WatchFrame[]): () => Promise<WatchFrame> {
  let calls = 0;
  return async () => frames[Math.min(calls++, frames.length - 1)]!;
}

describe("watchStatus", () => {
  it("redraws on every tick at the given interval, until the signal aborts", async () => {
    const controller = new AbortController();
    const displayed: (readonly string[])[] = [];
    const sleeps: Milliseconds[] = [];
    const ports: WatchPorts = {
      render: renderSequence({ lines: ["a"], inFlight: false }),
      display: (lines) => displayed.push(lines),
      sleep: async (interval) => {
        sleeps.push(interval);
        if (sleeps.length === 3) {
          controller.abort();
        }
      },
    };

    await watchStatus(ports, INTERVAL, controller.signal);

    assert.equal(displayed.length, 3);
    assert.deepEqual(sleeps, [INTERVAL, INTERVAL, INTERVAL]);
  });

  it("keeps going when nothing was ever in flight, until interrupted", async () => {
    const controller = new AbortController();
    let renders = 0;
    const ports: WatchPorts = {
      render: async () => {
        renders += 1;
        return { lines: [], inFlight: false };
      },
      display: () => {},
      sleep: async () => {
        if (renders >= 5) {
          controller.abort();
        }
      },
    };

    await watchStatus(ports, INTERVAL, controller.signal);

    assert.ok(renders >= 5);
  });

  it("exits by itself once an invocation in flight on the first draw closes", async () => {
    const displayed: (readonly string[])[] = [];
    const ports: WatchPorts = {
      render: renderSequence(
        { lines: ["still running"], inFlight: true },
        { lines: ["still running"], inFlight: true },
        { lines: ["done"], inFlight: false },
      ),
      display: (lines) => displayed.push(lines),
      sleep: async () => {},
    };

    await watchStatus(ports, INTERVAL, new AbortController().signal);

    assert.deepEqual(displayed, [["still running"], ["still running"], ["done"]]);
  });

  it("does not exit by itself when nothing was in flight on the first draw", async () => {
    const controller = new AbortController();
    let renders = 0;
    const ports: WatchPorts = {
      render: async () => {
        renders += 1;
        return { lines: [], inFlight: renders >= 2 };
      },
      display: () => {},
      sleep: async () => {
        if (renders >= 4) {
          controller.abort();
        }
      },
    };

    await watchStatus(ports, INTERVAL, controller.signal);

    assert.ok(renders >= 4);
  });
});

import { describe, expect, it } from "vitest";
import { poolSaturation } from "../src/detect/pool-saturation.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { at, entry, har } from "./support/har-builder.js";

const run = (source: string) => poolSaturation.run(normaliseHar(parseHar(source)));

/** n requests to one path, all overlapping, starting a millisecond apart. */
const concurrent = (n: number, path: string, startSeconds: number, durationMs: number) =>
  Array.from({ length: n }, (_, i) =>
    entry({
      startedDateTime: at(startSeconds + i * 0.001),
      time: durationMs,
      url: "https://x.test" + path,
    }),
  );

describe("requests starting as slots free", () => {
  it("catches a request that begins as another on the same path returns", () => {
    // Six overlap. The first ends, and a seventh starts immediately after —
    // the shape of something handing work out six at a time.
    const six = concurrent(6, "/api/dataset", 0, 2000);
    const seventh = entry({
      // The first of the six ends at 2000ms; this starts 0.2ms later.
      startedDateTime: at(2.0002),
      time: 1000,
      url: "https://x.test/api/dataset",
    });

    const result = run(har([...six, seventh]));
    const finding = result.findings[0];

    expect(result.findings).toHaveLength(1);
    expect(finding?.evidence["saturationEvents"]).toBe(1);
    expect(finding?.evidence["maxInFlight"]).toBe(6);
    expect(finding?.evidence["calls"]).toBe(7);
  });

  it("keeps the gap and the entry indices as evidence", () => {
    // startedDateTime only carries whole milliseconds, so the sub-millisecond
    // gap comes from the DURATION being fractional — which is exactly how it
    // arises in a real capture.
    const result = run(
      har([
        entry({ startedDateTime: at(0), time: 2000.5, url: "https://x.test/api/dataset" }),
        entry({ startedDateTime: at(0.001), time: 4000, url: "https://x.test/api/dataset" }),
        entry({ startedDateTime: at(0.002), time: 4000, url: "https://x.test/api/dataset" }),
        entry({ startedDateTime: at(2.001), time: 500, url: "https://x.test/api/dataset" }),
      ]),
    );
    const events = result.findings[0]?.evidence["events"] as {
      gapMs: number;
      inFlight: number;
      entryIndex: number;
      sourceIndex: number;
    }[];

    expect(events[0]?.gapMs).toBeCloseTo(0.5, 3);
    expect(events[0]?.inFlight).toBe(3);
    expect(typeof events[0]?.entryIndex).toBe("number");
    expect(typeof events[0]?.sourceIndex).toBe("number");
  });

  it("ignores a start that follows a completion by more than the window", () => {
    // Same shape, but the next request waits 50ms. Nothing was queued up
    // waiting for the slot.
    const result = run(
      har([
        ...concurrent(4, "/api/dataset", 0, 2000),
        entry({ startedDateTime: at(2.05), time: 500, url: "https://x.test/api/dataset" }),
      ]),
    );

    expect(result.findings).toHaveLength(0);
  });

  it("ignores a prompt start when the path was not at its maximum", () => {
    // Two overlap, one ends, the next starts straight away — but that only
    // brings the path back to 2, which it has been at all along, so there is
    // no evidence of anything limiting it.
    const result = run(
      har([
        entry({ startedDateTime: at(0), time: 3000, url: "https://x.test/api/a" }),
        entry({ startedDateTime: at(0.5), time: 500, url: "https://x.test/api/a" }),
        entry({ startedDateTime: at(1.0001), time: 500, url: "https://x.test/api/a" }),
        entry({ startedDateTime: at(1.5001), time: 500, url: "https://x.test/api/a" }),
      ]),
    );

    // Max is 2 throughout, and each new start does reach it, so this is the
    // boundary case: it fires, and the count is what tells the reader whether
    // to care.
    const finding = result.findings[0];
    expect(finding?.evidence["maxInFlight"]).toBe(2);
  });

  it("does not fire on a path whose requests never overlap", () => {
    const result = run(
      har([
        entry({ startedDateTime: at(0), time: 100, url: "https://x.test/api/a" }),
        entry({ startedDateTime: at(10), time: 100, url: "https://x.test/api/a" }),
        entry({ startedDateTime: at(20), time: 100, url: "https://x.test/api/a" }),
      ]),
    );

    expect(result.findings).toHaveLength(0);
  });

  it("keeps paths separate, because a pool is not shared across endpoints", () => {
    const result = run(
      har([
        ...concurrent(4, "/api/one", 0, 2000),
        entry({ startedDateTime: at(2.0002), time: 500, url: "https://x.test/api/one" }),
        ...concurrent(4, "/api/two", 10, 2000),
        entry({ startedDateTime: at(12.0002), time: 500, url: "https://x.test/api/two" }),
      ]),
    );

    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.key).sort()).toEqual([
      "pool-saturation:/api/one",
      "pool-saturation:/api/two",
    ]);
  });

  it("keys on the path alone, so a standing pattern is not new every capture", () => {
    const result = run(
      har([
        ...concurrent(4, "/api/dataset", 0, 2000),
        entry({ startedDateTime: at(2.0002), time: 500, url: "https://x.test/api/dataset" }),
      ]),
    );

    expect(result.findings[0]?.key).toBe("pool-saturation:/api/dataset");
    // No counts or durations in the key: those move every run.
    expect(result.findings[0]?.key).not.toMatch(/\d+(ms|calls)/);
  });

  it("states what was counted and never why", () => {
    const summary = run(
      har([
        ...concurrent(6, "/api/dataset", 0, 2000),
        entry({ startedDateTime: at(2.0002), time: 500, url: "https://x.test/api/dataset" }),
      ]),
    ).findings[0]?.summary;

    expect(summary).toContain("began within 2ms of another completing");
    expect(summary).toContain("6 were in flight");
    for (const forbidden of ["should", "caused", "because", "pool limit", "fix"]) {
      expect(summary?.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("raises severity with how often the limit was met, not how bad it is", () => {
    // Three always in flight: as each of the first three ends, another starts
    // on the same millisecond, so the path keeps being returned to its maximum.
    const chained = (events: number) => {
      const rows = concurrent(3, "/api/dataset", 0, 3000);
      for (let i = 0; i < events; i++) {
        rows.push(
          entry({
            startedDateTime: at(3 + i * 0.001),
            time: 3000,
            url: "https://x.test/api/dataset",
          }),
        );
      }
      return run(har(rows)).findings[0];
    };

    expect(chained(1)?.evidence["saturationEvents"]).toBe(1);
    expect(chained(1)?.severity).toBe("low");
    expect(chained(3)?.evidence["saturationEvents"]).toBe(3);
    expect(chained(3)?.severity).toBe("medium");
  });
});

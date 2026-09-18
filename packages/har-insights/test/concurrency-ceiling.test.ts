import { describe, expect, it } from "vitest";
import { concurrencyCeiling } from "../src/detect/concurrency-ceiling.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { at, entry, har, page } from "./support/har-builder.js";

const sweep = (source: string) =>
  concurrencyCeiling.run(normaliseHar(parseHar(source))).metrics as {
    maxInFlight: number;
    consideredEntries: number;
    excludedUnknownDuration: number;
    excludedZeroDuration: number;
    peakEntryIndices: number[];
  };

describe("concurrency ceiling", () => {
  it("processes an end before a start at the same millisecond", () => {
    // The case this exists for. Three requests run from t=0 to t=1000. A fourth
    // starts at exactly t=1000, the instant the first returns, because the pool
    // was full and a slot freed. The ceiling is 3, not 4 — and 4 would hide the
    // very limit the sweep is looking for.
    const source = har([
      entry({ startedDateTime: at(0), time: 1000 }),
      entry({ startedDateTime: at(0), time: 1000 }),
      entry({ startedDateTime: at(0), time: 1000 }),
      entry({ startedDateTime: at(1), time: 500 }),
    ]);

    expect(sweep(source).maxInFlight).toBe(3);
  });

  it("counts genuinely overlapping requests", () => {
    // Same shape, but the fourth starts a millisecond BEFORE the first ends, so
    // they really were in flight together.
    const source = har([
      entry({ startedDateTime: at(0), time: 1000 }),
      entry({ startedDateTime: at(0), time: 1000 }),
      entry({ startedDateTime: at(0), time: 1000 }),
      entry({ startedDateTime: at(0.999), time: 500 }),
    ]);

    expect(sweep(source).maxInFlight).toBe(4);
  });

  it("does not let a zero-duration request leak into the in-flight set", () => {
    // REGRESSION. Ends are processed before starts at the same instant, so a
    // request that starts and ends on the same millisecond would have its end
    // processed before its own start: it would be added and never removed, and
    // sit in the set for the rest of the capture inflating every later peak.
    //
    // Found against a real capture, where twenty-five cached responses landed
    // in one millisecond. The wrong answer looks entirely plausible, which is
    // what makes it dangerous.
    const cached = Array.from({ length: 10 }, () =>
      entry({ startedDateTime: at(0), time: 0, transferSize: 0 }),
    );
    const real = entry({ startedDateTime: at(5), time: 100 });
    const result = sweep(har([...cached, real]));

    expect(result.maxInFlight).toBe(1);
    expect(result.excludedZeroDuration).toBe(10);
    expect(result.consideredEntries).toBe(1);
  });

  it("excludes entries whose duration is unknown rather than inventing an end", () => {
    const source = har([
      entry({ startedDateTime: at(0), time: -1 }),
      entry({ startedDateTime: at(1), time: 1000 }),
    ]);
    const result = sweep(source);

    expect(result.excludedUnknownDuration).toBe(1);
    expect(result.consideredEntries).toBe(1);
    expect(result.maxInFlight).toBe(1);
  });

  it("reports which entries were in flight at the peak", () => {
    const source = har([
      entry({ startedDateTime: at(0), time: 2000 }),
      entry({ startedDateTime: at(0.5), time: 2000 }),
    ]);
    const result = sweep(source);

    expect(result.maxInFlight).toBe(2);
    expect(result.peakEntryIndices).toEqual([0, 1]);
  });

  it("reports a ceiling of zero for a capture with nothing to sweep", () => {
    expect(sweep(har([], [page()])).maxInFlight).toBe(0);
  });
});

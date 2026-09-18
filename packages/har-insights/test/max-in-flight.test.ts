import { describe, expect, it } from "vitest";
import { maxInFlight } from "../src/detect/max-in-flight.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { at, entry, har, page } from "./support/har-builder.js";

interface Scope {
  maxInFlight: number;
  requests: number;
  peakEntryIndices: number[];
}

const metrics = (source: string) =>
  maxInFlight.run(normaliseHar(parseHar(source))).metrics as unknown as {
    network: Scope;
    allRequests: Scope;
    excludedUnknownDuration: number;
    excludedZeroDuration: number;
    byPath: { path: string; calls: number; maxInFlight: number; source: string }[];
  };

/** The all-requests scope, which is what most of these cases are about. */
const sweep = (source: string) => {
  const m = metrics(source);
  return {
    maxInFlight: m.allRequests.maxInFlight,
    consideredEntries: m.allRequests.requests,
    excludedUnknownDuration: m.excludedUnknownDuration,
    excludedZeroDuration: m.excludedZeroDuration,
    peakEntryIndices: m.allRequests.peakEntryIndices,
  };
};

describe("maximum observed in flight", () => {
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

  it("reports the network figure apart from the all-requests figure", () => {
    // Cache hits are not competing for a connection. Counting them answers a
    // question nobody asked.
    const cached = Array.from({ length: 8 }, (_, i) =>
      entry({ startedDateTime: at(0), time: 0.02, transferSize: 0, url: "https://x.test/a" + i }),
    );
    const real = Array.from({ length: 2 }, (_, i) =>
      entry({ startedDateTime: at(0), time: 900, transferSize: 5000, url: "https://x.test/b" + i }),
    );
    const m = metrics(har([...cached, ...real]));

    expect(m.allRequests.maxInFlight).toBe(10);
    expect(m.network.maxInFlight).toBe(2);
    expect(m.network.requests).toBe(2);
  });

  it("reports a maximum for every path, with its call count beside it", () => {
    // A maximum without a denominator cannot be read: 6 of 21 is a limit being
    // pressed against, 2 of 3 is a quiet endpoint.
    const busy = Array.from({ length: 6 }, (_, i) =>
      entry({ startedDateTime: at(i * 0.001), time: 5000, url: "https://x.test/api/busy" }),
    );
    const quiet = [
      entry({ startedDateTime: at(0), time: 100, url: "https://x.test/api/quiet" }),
      entry({ startedDateTime: at(20), time: 100, url: "https://x.test/api/quiet" }),
    ];
    const m = metrics(har([...busy, ...quiet]));

    const busyRow = m.byPath.find((row) => row.path === "/api/busy");
    expect(busyRow?.maxInFlight).toBe(6);
    expect(busyRow?.calls).toBe(6);

    const quietRow = m.byPath.find((row) => row.path === "/api/quiet");
    expect(quietRow?.maxInFlight).toBe(1);
    expect(quietRow?.calls).toBe(2);
  });

  it("says whether a path came off the network or out of cache", () => {
    const m = metrics(
      har([
        entry({ startedDateTime: at(0), url: "https://x.test/api/net", transferSize: 900 }),
        entry({ startedDateTime: at(1), url: "https://x.test/api/net", transferSize: 900 }),
        entry({ startedDateTime: at(0), url: "https://x.test/a.css", transferSize: -1 }),
        entry({ startedDateTime: at(1), url: "https://x.test/a.css", transferSize: -1 }),
        entry({ startedDateTime: at(0), url: "https://x.test/b.css", transferSize: -1 }),
        entry({ startedDateTime: at(1), url: "https://x.test/b.css", transferSize: 400 }),
      ]),
    );

    expect(m.byPath.find((r) => r.path === "/api/net")?.source).toBe("network");
    expect(m.byPath.find((r) => r.path === "/a.css")?.source).toBe("cache");
    expect(m.byPath.find((r) => r.path === "/b.css")?.source).toBe("mixed");
  });

  it("omits paths called once, whose maximum is one by definition", () => {
    const m = metrics(har([entry({ url: "https://x.test/api/once" })]));
    expect(m.byPath.find((row) => row.path === "/api/once")).toBeUndefined();
  });
});

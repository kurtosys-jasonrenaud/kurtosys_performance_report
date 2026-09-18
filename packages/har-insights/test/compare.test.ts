import { describe, expect, it } from "vitest";
import { compareRuns, durationNoiseThreshold } from "../src/compare/compare.js";
import type { RunComparison } from "../src/compare/types.js";
import { runDetectors } from "../src/detect/registry.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { buildRunRecord } from "../src/record/emit.js";
import type { RunMetadata, RunRecord, RunWorkload } from "../src/record/types.js";
import { at, entry, har, page } from "./support/har-builder.js";

/**
 * The failure mode of a comparison tool is showing an improvement that is not
 * real. These tests are mostly about the guardrails rather than the arithmetic,
 * because the arithmetic being right is not what makes a comparison honest.
 */

const BASE_METADATA: RunMetadata = {
  client: "Example Client",
  environment: "production",
  build: "2026.09.01-1",
  ticket: "HV-1512",
  journey: "log in, open dashboard",
  recordedAt: "2026-09-18T12:00:00.000Z",
};

const BASE_WORKLOAD: RunWorkload = { accountCount: 3, emulated: false, asOfDate: "2026-08-31" };

function record(
  entries: Record<string, unknown>[],
  metadata: Partial<RunMetadata> = {},
  workload: Partial<RunWorkload> = {},
  pages: Record<string, unknown>[] | null = [page({ id: "page_1", title: "https://x.test/home" })],
): RunRecord {
  const model = normaliseHar(parseHar(har(entries, pages)));
  return buildRunRecord(
    model,
    runDetectors(model),
    { ...BASE_METADATA, ...metadata },
    { ...BASE_WORKLOAD, ...workload },
  );
}

const compared = (a: RunRecord, b: RunRecord): RunComparison => {
  const result = compareRuns(a, b);
  if (result.outcome !== "compared") throw new Error("expected a comparison, got a refusal");
  return result;
};

describe("version guards", () => {
  it("refuses outright when the record shapes differ", () => {
    // A field present in one shape and absent from the other reads as a change
    // in the system rather than a change in the tool.
    const a = record([entry()]);
    const b = { ...record([entry()]), schemaVersion: a.schemaVersion + 1 };
    const result = compareRuns(a, b);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reason).toContain("different shapes");
    }
  });

  it("warns but continues when the analyzer version differs", () => {
    const a = record([entry()]);
    const b = { ...record([entry()]), analyzerVersion: a.analyzerVersion + 1 };
    const result = compared(a, b);

    expect(result.guards.analyzerVersionMismatch).toBe(true);
    expect(result.endpoints.length).toBeGreaterThan(0);
  });

  it("marks one detector's findings incomparable and leaves the rest intact", () => {
    const a = record([
      entry({ startedDateTime: at(0), method: "POST", requestBody: '{"a":1}' }),
      entry({ startedDateTime: at(1), method: "POST", requestBody: '{"a":1}' }),
    ]);
    const b = {
      ...record([
        entry({ startedDateTime: at(0), method: "POST", requestBody: '{"a":1}' }),
        entry({ startedDateTime: at(1), method: "POST", requestBody: '{"a":1}' }),
      ]),
      detectorVersions: {
        ...a.detectorVersions,
        "duplicate-payload-within-page": 99,
      },
    };
    const result = compared(a, b);

    expect(result.guards.detectorVersionMismatches).toHaveLength(1);
    const duplicates = result.findings.filter(
      (f) => f.detectorId === "duplicate-payload-within-page",
    );
    expect(duplicates.length).toBeGreaterThan(0);
    expect(duplicates.every((f) => f.comparable)).toBe(false);
    // The rest of the diff survives.
    expect(result.endpoints.length).toBeGreaterThan(0);
    expect(result.capture.length).toBeGreaterThan(0);
  });
});

describe("confounders", () => {
  it("fires on a different environment and marks it severe", () => {
    const result = compared(
      record([entry()], { environment: "staging" }),
      record([entry()], { environment: "production" }),
    );

    const environment = result.confounders.find((c) => c.field === "environment");
    expect(environment).toBeDefined();
    expect(environment?.severe).toBe(true);
    expect(environment?.before).toBe("staging");
    expect(environment?.after).toBe("production");
  });

  it("fires on account count, emulation and as-at date", () => {
    const result = compared(
      record([entry()], {}, { accountCount: 3, emulated: false, asOfDate: "2026-08-31" }),
      record([entry()], {}, { accountCount: 400, emulated: true, asOfDate: "2026-09-30" }),
    );

    expect(result.confounders.map((c) => c.field).sort()).toEqual([
      "accountCount",
      "asOfDate",
      "emulated",
    ]);
  });

  it("stays quiet when nothing differs", () => {
    expect(compared(record([entry()]), record([entry()])).confounders).toEqual([]);
  });

  it("reports a missing value as not recorded rather than treating it as zero", () => {
    const result = compared(
      record([entry()], {}, { accountCount: null }),
      record([entry()], {}, { accountCount: 12 }),
    );
    expect(result.confounders[0]?.before).toBe("not recorded");
  });
});

describe("structural and duration are different kinds of fact", () => {
  it("still compares counts across environments, and refuses to compare durations", () => {
    // The central claim of the whole tool: what the code does travels between
    // environments, how long it took does not.
    const before = record(
      [entry({ startedDateTime: at(0), time: 8000, url: "https://x.test/api/thing" })],
      { environment: "staging" },
    );
    const after = record(
      [
        entry({ startedDateTime: at(0), time: 1000, url: "https://x.test/api/thing" }),
        entry({ startedDateTime: at(1), time: 1000, url: "https://x.test/api/thing" }),
      ],
      { environment: "production" },
    );
    const result = compared(before, after);

    expect(result.durationsComparable).toBe(false);

    const row = result.endpoints.find((e) => e.path === "/api/thing");
    // The count moved from 1 to 2 and that is reportable.
    expect(row?.calls.confidence).toBe("precise");
    expect(row?.calls.change).toBe(1);
    // It looks 6 seconds faster. It is not: it ran somewhere else.
    expect(row?.duration.change).toBe(-6000);
    expect(row?.duration.confidence).toBe("not-comparable");
  });

  it("classifies every capture metric as structural except the window", () => {
    const result = compared(record([entry()]), record([entry()]));
    const kinds = Object.fromEntries(result.capture.map((d) => [d.label, d.kind]));

    expect(kinds["entries"]).toBe("structural");
    expect(kinds["transferred"]).toBe("structural");
    expect(kinds["max in flight"]).toBe("structural");
    expect(kinds["capture window"]).toBe("duration");
  });
});

describe("noise threshold", () => {
  it("demands more from an endpoint called once than one called often", () => {
    // Anchored to a measured 168% swing on a single call, tightening as
    // 1/sqrt(calls) and resting on a 30% floor.
    expect(durationNoiseThreshold(1)).toBeCloseTo(1.7, 5);
    expect(durationNoiseThreshold(4)).toBeCloseTo(0.85, 5);
    expect(durationNoiseThreshold(9)).toBeCloseTo(0.5667, 3);
    expect(durationNoiseThreshold(100)).toBeCloseTo(0.3, 5);
    expect(durationNoiseThreshold(0)).toBeCloseTo(1.7, 5);
  });

  it("calls a small absolute movement indicative however large the percentage", () => {
    // 100ms to 300ms is a tripling, and it is nothing.
    const before = record([entry({ time: 100, url: "https://x.test/api/a" })]);
    const after = record([entry({ time: 300, url: "https://x.test/api/a" })]);
    const row = compared(before, after).endpoints.find((e) => e.path === "/api/a");

    expect(row?.duration.change).toBe(200);
    expect(row?.duration.confidence).toBe("indicative");
  });

  it("calls a large, well-sampled movement precise", () => {
    const many = (time: number) =>
      Array.from({ length: 20 }, (_, i) =>
        entry({ startedDateTime: at(i), time, url: "https://x.test/api/a" }),
      );
    const row = compared(record(many(500)), record(many(2000))).endpoints.find(
      (e) => e.path === "/api/a",
    );

    expect(row?.duration.change).toBe(30000);
    expect(row?.duration.confidence).toBe("precise");
  });

  it("stays indicative for a single call that swung the way we have seen them swing", () => {
    // The real pair: 4,163ms and 11,176ms from the same endpoint in one session.
    const row = compared(
      record([entry({ time: 4163, url: "https://x.test/api/a" })]),
      record([entry({ time: 11176, url: "https://x.test/api/a" })]),
    ).endpoints.find((e) => e.path === "/api/a");

    expect(row?.duration.confidence).toBe("indicative");
  });
});

describe("endpoint deltas", () => {
  it("ranks by absolute call change, so a big move cannot be buried", () => {
    const before = record([
      entry({ startedDateTime: at(0), url: "https://x.test/api/search" }),
      entry({ startedDateTime: at(1), url: "https://x.test/api/small" }),
    ]);
    const after = record([
      ...Array.from({ length: 30 }, (_, i) =>
        entry({ startedDateTime: at(i), url: "https://x.test/api/search" }),
      ),
      entry({ startedDateTime: at(40), url: "https://x.test/api/small" }),
      entry({ startedDateTime: at(41), url: "https://x.test/api/small" }),
    ]);

    expect(compared(before, after).endpoints[0]?.path).toBe("/api/search");
  });

  it("ranks a disappearance as highly as an appearance", () => {
    const before = record(
      Array.from({ length: 40 }, (_, i) =>
        entry({ startedDateTime: at(i), url: "https://x.test/api/gone" }),
      ),
    );
    const after = record([entry({ url: "https://x.test/api/kept" })]);
    const top = compared(before, after).endpoints[0];

    expect(top?.path).toBe("/api/gone");
    expect(top?.presence).toBe("only-before");
    expect(top?.calls.change).toBe(-40);
  });

  it("marks endpoints that appeared or disappeared", () => {
    const result = compared(
      record([entry({ url: "https://x.test/api/old" })]),
      record([entry({ url: "https://x.test/api/new" })]),
    );

    expect(result.endpoints.find((e) => e.path === "/api/old")?.presence).toBe("only-before");
    expect(result.endpoints.find((e) => e.path === "/api/new")?.presence).toBe("only-after");
  });
});

describe("journey alignment", () => {
  const pageAt = (id: string, route: string) =>
    page({ id, title: "https://x.test" + route, startedDateTime: at(0) });

  it("matches pages on route, not on position", () => {
    // The routes arrive in a different order in each run. Aligning by position
    // would compare the dashboard against the documents list.
    const before = record(
      [
        entry({ startedDateTime: at(0), pageref: "page_1" }),
        entry({ startedDateTime: at(1), pageref: "page_2" }),
        entry({ startedDateTime: at(2), pageref: "page_2" }),
      ],
      {},
      {},
      [pageAt("page_1", "/dashboards/"), pageAt("page_2", "/documents/")],
    );
    const after = record(
      [
        entry({ startedDateTime: at(0), pageref: "page_7" }),
        entry({ startedDateTime: at(1), pageref: "page_8" }),
        entry({ startedDateTime: at(2), pageref: "page_8" }),
        entry({ startedDateTime: at(3), pageref: "page_8" }),
      ],
      {},
      {},
      [pageAt("page_7", "/documents/"), pageAt("page_8", "/dashboards/")],
    );

    const result = compared(before, after);
    const dashboards = result.pages.find((p) => p.route === "/dashboards/");
    const documents = result.pages.find((p) => p.route === "/documents/");

    expect(dashboards?.beforeRef).toBe("page_1");
    expect(dashboards?.afterRef).toBe("page_8");
    expect(dashboards?.requests.change).toBe(2);
    expect(documents?.requests.change).toBe(-1);
  });

  it("shows an unmatched step as present in one run only", () => {
    const before = record([entry({ pageref: "page_1" })], {}, {}, [
      pageAt("page_1", "/home"),
    ]);
    const after = record(
      [entry({ startedDateTime: at(0), pageref: "page_1" }), entry({ startedDateTime: at(1), pageref: "page_2" })],
      {},
      {},
      [pageAt("page_1", "/home"), pageAt("page_2", "/reports/")],
    );

    const reports = compared(before, after).pages.find((p) => p.route === "/reports/");
    expect(reports?.presence).toBe("only-after");
    expect(reports?.beforeRef).toBeNull();
  });

  it("does not collapse two visits to the same route into one", () => {
    const after = record(
      [entry({ startedDateTime: at(0), pageref: "page_1" }), entry({ startedDateTime: at(1), pageref: "page_2" })],
      {},
      {},
      [pageAt("page_1", "/home"), pageAt("page_2", "/home")],
    );
    const before = record([entry({ pageref: "page_1" })], {}, {}, [pageAt("page_1", "/home")]);

    const visits = compared(before, after).pages.filter((p) => p.route === "/home");
    expect(visits).toHaveLength(2);
    expect(visits[1]?.presence).toBe("only-after");
  });
});

describe("findings", () => {
  const duplicated = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      entry({
        startedDateTime: at(i),
        method: "POST",
        url: "https://x.test/api/thing",
        requestBody: '{"a":1}',
        pageref: "page_1",
      }),
    );

  it("classifies findings as new, resolved or persisting by key", () => {
    const withDuplicates = record(duplicated(3));
    const without = record([entry({ method: "POST", url: "https://x.test/api/thing", requestBody: '{"a":1}' })]);

    const resolved = compared(withDuplicates, without).findings;
    expect(resolved.every((f) => f.status === "resolved")).toBe(true);

    const appeared = compared(without, withDuplicates).findings;
    expect(appeared.every((f) => f.status === "new")).toBe(true);

    const persisting = compared(withDuplicates, withDuplicates).findings;
    expect(persisting.every((f) => f.status === "persisting")).toBe(true);
  });

  it("notices a severity change on a finding that persists", () => {
    const result = compared(record(duplicated(2)), record(duplicated(7)));
    const finding = result.findings[0];

    expect(finding?.status).toBe("persisting");
    expect(finding?.severityChanged).toBe(true);
    expect(finding?.before?.severity).toBe("low");
    expect(finding?.after?.severity).toBe("high");
  });
});

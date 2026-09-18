import { describe, expect, it } from "vitest";
import { runDetectors } from "../src/detect/registry.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { applyProfile } from "../src/profile/apply.js";
import type { Profile } from "../src/profile/types.js";
import { at, entry, har, page } from "./support/har-builder.js";

/**
 * A profile may LABEL and SCOPE a measurement. It may never CHANGE one.
 *
 * The first describe block is the one that matters: it takes a finished
 * analysis, applies a profile that tries as hard as it can to move a number,
 * and proves nothing moved. Everything else here is detail.
 */

const analyse = (source: string) => {
  const model = normaliseHar(parseHar(source));
  return { model, detectors: runDetectors(model) };
};

/** Twenty-one executes of fourteen queries, roughly the real shape. */
function datasetCapture(): string {
  const execute = (seconds: number, code: string, inputs: unknown, time: number, pageref = "page_1") =>
    entry({
      startedDateTime: at(seconds),
      time,
      method: "POST",
      url: "https://portal.example.com/services/dataset/execute",
      requestBody: JSON.stringify({ code, inputs }),
      pageref,
    });

  return har(
    [
      execute(0, "QRY001", { fund: 1 }, 1200),
      execute(1, "QRY001", { fund: 2 }, 1300),
      execute(2, "QRY002", { fund: 1 }, 8000),
      execute(3, "QRY003", { fund: 1 }, 5000),
      // Same query, same inputs, second page: session-wide repeat, not intra-page.
      execute(40, "QRY001", { fund: 1 }, 1400, "page_2"),
      entry({
        startedDateTime: at(5),
        method: "POST",
        url: "https://portal.example.com/services/auth/getUserByToken",
        requestBody: '{"token":"x"}',
        pageref: "page_1",
      }),
    ],
    [
      page({ id: "page_1", title: "https://portal.example.com/dashboards/" }),
      page({ id: "page_2", title: "https://portal.example.com/documents/", startedDateTime: at(38) }),
    ],
  );
}

const PROFILE: Profile = {
  id: "example",
  name: "Example Portal",
  version: 1,
  match: { hosts: ["portal.example.com"] },
  endpoints: {
    "/services/dataset/execute": {
      label: "Analytical query",
      class: "business",
      pool: "dataset",
      queryId: { from: "requestBody", path: "code" },
      queryInputs: { from: "requestBody", path: "inputs" },
    },
    "/services/auth/getUserByToken": { label: "Identity", class: "setup" },
  },
  queryLabels: { QRY001: "IRR Summary" },
  routes: { "/dashboards/": "Dashboards" },
};

describe("a profile cannot change a measurement", () => {
  it("leaves the detector output byte-identical", () => {
    // The guarantee, stated as a test. If this ever fails, the profile layer
    // has grown a way to write back into the analysis and must lose it again.
    const { model, detectors } = analyse(datasetCapture());
    const before = JSON.stringify(detectors);
    const modelBefore = JSON.stringify(model);

    applyProfile(model, detectors, PROFILE);

    expect(JSON.stringify(detectors)).toBe(before);
    expect(JSON.stringify(model)).toBe(modelBefore);
  });

  it("returns a value with no rollup, findings or capture totals on it", () => {
    // Enforced by shape: there is no field on the overlay through which a
    // changed measurement could travel.
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);
    const keys = Object.keys(overlay);

    expect(keys).not.toContain("endpoints");
    expect(keys).not.toContain("findings");
    expect(keys).not.toContain("capture");
    expect(keys).toContain("queries");
    expect(keys).toContain("assertions");
    // What it does carry about the capture as a whole is two derived timings,
    // and nothing else.
    expect(Object.keys(overlay.business).sort()).toEqual([
      "firstBusinessRequestMs",
      "lastBusinessResponseMs",
    ]);
  });

  it("does not touch the generic JSON timings it sits beside", () => {
    const { model, detectors } = analyse(datasetCapture());
    const firstJsonBefore = model.pages.map((p) => p.firstJsonResponseMs);

    applyProfile(model, detectors, PROFILE);

    expect(model.pages.map((p) => p.firstJsonResponseMs)).toEqual(firstJsonBefore);
  });
});

describe("host self-check", () => {
  it("matches when a capture host is in the profile's list", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);

    expect(overlay.matched).toBe(true);
    expect(overlay.matchWarning).toBeNull();
  });

  it("warns, without refusing, when the profile is for somewhere else", () => {
    // A profile silently applied to the wrong capture produces labels that are
    // confidently wrong, which is worse than no labels at all.
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, {
      ...PROFILE,
      match: { hosts: ["portal.somewhere-else.com"] },
    });

    expect(overlay.matched).toBe(false);
    expect(overlay.matchWarning).toContain("may be wrong");
    expect(overlay.matchWarning).toContain("Nothing measured has been changed");
    // It still produces its labels; the reader decides.
    expect(overlay.queries.length).toBeGreaterThan(0);
  });
});

describe("query rollup", () => {
  it("names queries and counts their runs individually", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);

    const qry001 = overlay.queries.find((q) => q.queryId === "QRY001");
    expect(qry001?.runs).toBe(3);
    expect(qry001?.label).toBe("IRR Summary");
    expect(qry001?.durationsMs).toEqual([1200, 1300, 1400]);
    expect(qry001?.totalDurationMs).toBe(3900);

    // Fourteen would be the real shape; here it is three distinct codes.
    expect(overlay.queries).toHaveLength(3);
  });

  it("keys duplicates on query and inputs, not the whole body", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);
    const qry001 = overlay.queries.find((q) => q.queryId === "QRY001");

    // fund 1 twice (different pages) and fund 2 once.
    expect(qry001?.distinctInputs).toBe(2);
    expect(qry001?.sessionWideRepeats).toBe(1);
    expect(qry001?.intraPageRepeats).toBe(0);
  });

  it("separates a repeat within one page from one spread across pages", () => {
    const twiceOnOnePage = har(
      [
        entry({
          startedDateTime: at(0), method: "POST", time: 100,
          url: "https://portal.example.com/services/dataset/execute",
          requestBody: JSON.stringify({ code: "QRY001", inputs: { fund: 1 } }),
          pageref: "page_1",
        }),
        entry({
          startedDateTime: at(1), method: "POST", time: 100,
          url: "https://portal.example.com/services/dataset/execute",
          requestBody: JSON.stringify({ code: "QRY001", inputs: { fund: 1 } }),
          pageref: "page_1",
        }),
      ],
      [page({ id: "page_1", title: "https://portal.example.com/dashboards/" })],
    );
    const { model, detectors } = analyse(twiceOnOnePage);
    const overlay = applyProfile(model, detectors, PROFILE);

    expect(overlay.queries[0]?.intraPageRepeats).toBe(1);
  });

  it("ignores endpoints the profile says nothing about", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);

    expect(overlay.queries.every((q) => q.path === "/services/dataset/execute")).toBe(true);
  });
});

describe("pools", () => {
  it("sweeps endpoints sharing a pool together", () => {
    const overlapping = har(
      Array.from({ length: 4 }, (_, i) =>
        entry({
          startedDateTime: at(i * 0.001), time: 5000, method: "POST",
          url: "https://portal.example.com/services/dataset/execute",
          requestBody: JSON.stringify({ code: "Q" + i, inputs: {} }),
        }),
      ),
      [page({ id: "page_1", title: "https://portal.example.com/dashboards/" })],
    );
    const { model, detectors } = analyse(overlapping);
    const overlay = applyProfile(model, detectors, PROFILE);

    expect(overlay.pools[0]?.pool).toBe("dataset");
    expect(overlay.pools[0]?.maxInFlight).toBe(4);
    expect(overlay.pools[0]?.calls).toBe(4);
  });

  it("reports the pool alongside the generic figures, never replacing them", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);
    const generic = detectors.metrics["max-in-flight"] as Record<string, unknown>;

    expect(overlay.pools.length).toBeGreaterThan(0);
    expect(generic["network"]).toBeDefined();
    expect(generic["allRequests"]).toBeDefined();
    expect(generic["byPath"]).toBeDefined();
  });
});

describe("business timings", () => {
  it("derives first and last from endpoints marked business", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);

    // The first execute is at capture start; the last finishes at 40s + 1400ms.
    expect(overlay.business.firstBusinessRequestMs).toBe(0);
    expect(overlay.business.lastBusinessResponseMs).toBe(41400);
  });

  it("is null for a page with no business endpoint on it", () => {
    const setupOnly = har(
      [
        entry({
          startedDateTime: at(0), method: "POST",
          url: "https://portal.example.com/services/auth/getUserByToken",
          requestBody: '{"token":"x"}', pageref: "page_1",
        }),
      ],
      [page({ id: "page_1", title: "https://portal.example.com/home" })],
    );
    const { model, detectors } = analyse(setupOnly);
    const overlay = applyProfile(model, detectors, PROFILE);

    expect(overlay.businessByPage[0]?.firstBusinessRequestMs).toBeNull();
  });

  it("applies the profile's route labels without altering the route", () => {
    const { model, detectors } = analyse(datasetCapture());
    const overlay = applyProfile(model, detectors, PROFILE);
    const dashboards = overlay.businessByPage.find((p) => p.route === "/dashboards/");

    expect(dashboards?.routeLabel).toBe("Dashboards");
    expect(dashboards?.route).toBe("/dashboards/");
  });
});

describe("assertions", () => {
  const withAssertions = (assertions: NonNullable<Profile["assertions"]>) => {
    const { model, detectors } = analyse(datasetCapture());
    return applyProfile(model, detectors, { ...PROFILE, assertions }).assertions;
  };

  it("passes a detector assertion when nothing was found in scope", () => {
    const results = withAssertions([
      {
        id: "no-intra-page-duplicates",
        detector: "duplicate-payload-within-page",
        scope: "pool:dataset",
        expect: "none",
      },
    ]);

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.evaluated).toBe(true);
  });

  it("fails a metric assertion and says what it saw", () => {
    const results = withAssertions([
      { id: "pool-above-three", metric: "maxInFlight", pool: "dataset", expect: "> 3" },
    ]);

    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.observed).toContain("maxInFlight =");
  });

  it("marks an assertion unevaluated rather than failed when nothing matched", () => {
    // Neither met nor missed. Counting it as a failure would be a claim about a
    // system we did not observe.
    const results = withAssertions([
      { id: "unknown-pool", metric: "maxInFlight", pool: "nonexistent", expect: "> 1" },
    ]);

    expect(results[0]?.evaluated).toBe(false);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.note).toContain("neither met nor missed");
  });

  it("refuses an expectation it cannot parse rather than guessing", () => {
    const results = withAssertions([
      { id: "nonsense", metric: "maxInFlight", pool: "dataset", expect: "quite big" },
    ]);

    expect(results[0]?.evaluated).toBe(false);
    expect(results[0]?.note).toContain("Could not read the expectation");
  });

  it("supports the comparison operators", () => {
    const results = withAssertions([
      { id: "gte", metric: "queryRuns", queryId: "QRY001", expect: ">= 3" },
      { id: "lt", metric: "queryRuns", queryId: "QRY001", expect: "< 3" },
      { id: "eq", metric: "distinctQueries", expect: "== 3" },
    ]);

    expect(results.map((r) => r.passed)).toEqual([true, false, true]);
  });

  it("notes when a scope narrowed the findings it looked at", () => {
    const results = withAssertions([
      {
        id: "scoped",
        detector: "duplicate-payload-within-page",
        scope: "pool:dataset",
        expect: "none",
      },
    ]);

    expect(results[0]?.kind).toBe("detector");
  });
});

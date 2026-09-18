import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runDetectors } from "../src/detect/registry.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import type { NormaliseResult } from "../src/normalise/types.js";
import {
  CAPTURES_DIR,
  EXPECTATIONS_DIR,
  findOrphanCaptures,
  loadGoldenCases,
  type CaptureExpectations,
  type GoldenCase,
} from "./support/expectations.js";

/**
 * Golden validation against real captures.
 *
 * The acceptance criterion for phase 1: the package reproduces findings we
 * already derived by hand. Every value asserted here is a pure function of the
 * file — counts, sizes, summed durations recorded IN the capture. Nothing is a
 * benchmark and nothing is measured on the machine running the test, so there
 * is no tolerance and no flakiness. Any variance is a bug in one of the two.
 *
 * When a value disagrees, do NOT edit the expectation to make it pass. The
 * expectation came from manual analysis, and manual analysis can be wrong —
 * two figures in this project have already been corrected. A disagreement means
 * one side is wrong and somebody has to find out which.
 */

const cases = loadGoldenCases();
const orphans = findOrphanCaptures(cases);

let ran = 0;
let skipped = 0;

/** Tenth-of-a-second comparison, for values quoted to one decimal place. */
function toTenthSecond(ms: number): number {
  return Math.round(ms / 100);
}

function analyse(path: string): {
  model: NormaliseResult;
  detectors: ReturnType<typeof runDetectors>;
} {
  const source = readFileSync(path, "utf8");
  const model = normaliseHar(parseHar(source));
  return { model, detectors: runDetectors(model) };
}

describe("golden captures", () => {
  if (cases.length === 0) {
    it("no expectations files found, so nothing was validated", () => {
      // Deliberately not a failure: the fixtures are gitignored, so a clean
      // checkout legitimately has none. The summary at the end of this file is
      // what stops that reading as a green validation run.
      console.warn(
        "\n  No golden expectations found in " +
          EXPECTATIONS_DIR +
          "\n  Nothing was validated against a real capture.\n",
      );
      expect(cases).toHaveLength(0);
    });
  }

  for (const goldenCase of cases) {
    const { expectations, capturePresent } = goldenCase;

    if (!capturePresent) {
      skipped++;
      describe.skip(expectations.captureId + " (capture file absent)", () => {
        it("skipped: " + expectations.file + " is not in " + CAPTURES_DIR, () => {
          // Named explicitly so the reason is readable from the test output
          // without anyone having to go and look.
        });
      });
      continue;
    }

    ran++;
    describeCapture(goldenCase);
  }

  /**
   * A capture present with no expectations file FAILS. Skipping it would mean
   * somebody copied a capture in expecting it to be validated, and nothing
   * validated it.
   */
  if (orphans.length > 0) {
    it("every capture in fixtures/captures has an expectations file", () => {
      expect(
        orphans,
        "These captures have no expectations file in fixtures/expectations/, so " +
          "they were not validated against anything: " +
          orphans.join(", "),
      ).toEqual([]);
    });
  }
});

function describeCapture({ expectations, capturePath }: GoldenCase): void {
  describe(expectations.captureId, () => {
    const { model, detectors } = analyse(capturePath);
    const want = expectations.expect;

    it("parsed the capture without losing entries to truncation", () => {
      // Stated rather than assumed: every count below is a count of what was
      // parsed, and a truncated capture would make all of them lower bounds.
      if (!model.capture.complete) {
        console.warn(
          "\n  " +
            expectations.captureId +
            " is TRUNCATED: recovered " +
            model.capture.recoveredEntries +
            " entries, cut at char offset " +
            String(model.capture.truncatedAtCharOffset) +
            ".\n  Every expected total below is a total of what survived.\n",
        );
      }
      expect(model.capture.reliable).toBe(true);
    });

    if (want.capture !== undefined) {
      const c = want.capture;

      if (c.entries !== undefined) {
        it("entry count", () => {
          expect(model.capture.entryCount).toBe(c.entries);
        });
      }

      if (c.windowMsToTenthSecond !== undefined) {
        it("capture window", () => {
          expect(toTenthSecond(model.capture.windowMs)).toBe(
            toTenthSecond(c.windowMsToTenthSecond as number),
          );
        });
      }

      if (c.transferBytesMb !== undefined) {
        it("total transferred bytes", () => {
          const base = c.transferBytesMbBase ?? 1048576;
          const mb = model.capture.totalTransferBytes / base;
          expect(Math.round(mb * 100) / 100).toBe(c.transferBytesMb);
        });
      }

      if (c.pageLoads !== undefined) {
        it("page count", () => {
          expect(model.capture.pageCount).toBe(c.pageLoads);
        });
      }

      if (c.unpagedEntries !== undefined) {
        it("unpaged entries are reachable, not silently dropped", () => {
          const unpaged = model.capture.unpagedEntryIndices;
          expect(unpaged).toHaveLength(c.unpagedEntries as number);

          // Reachability is the real assertion: each index resolves to a real
          // entry, and that entry genuinely resolves to no page.
          const pageRefs = new Set(model.pages.map((page) => page.pageRef));
          for (const index of unpaged) {
            const entry = model.entries[index];
            expect(entry).toBeDefined();
            if (entry?.pageRef !== null && entry?.pageRef !== undefined) {
              expect(pageRefs.has(entry.pageRef)).toBe(false);
            }
          }
        });
      }
    }

    if (want.servicesRollup !== undefined) {
      const spec = want.servicesRollup;
      const rows = (
        detectors.metrics["endpoint-rollup"]?.["endpoints"] as
          | { path: string; calls: number; totalDurationMs: number; statusDistribution: Record<string, number> }[]
          | undefined
      )?.filter((row) => row.path.startsWith(spec.pathPrefix)) ?? [];

      if (spec.totalCalls !== undefined) {
        it("total calls under " + spec.pathPrefix, () => {
          const total = rows.reduce((sum, row) => sum + row.calls, 0);
          expect(total).toBe(spec.totalCalls);
        });
      }

      if (spec.totalDurationMsToTenthSecond !== undefined) {
        it("total summed duration under " + spec.pathPrefix, () => {
          const total = rows.reduce((sum, row) => sum + row.totalDurationMs, 0);
          expect(toTenthSecond(total)).toBe(
            toTenthSecond(spec.totalDurationMsToTenthSecond as number),
          );
        });
      }

      for (const endpoint of spec.endpoints ?? []) {
        describe(endpoint.path, () => {
          const row = rows.find((candidate) => candidate.path === endpoint.path);

          it("is present in the rollup", () => {
            expect(row, "no rollup row for " + endpoint.path).toBeDefined();
          });

          it("call count", () => {
            expect(row?.calls).toBe(endpoint.calls);
          });

          if (endpoint.durationSeconds !== undefined) {
            it("summed duration", () => {
              expect(toTenthSecond(row?.totalDurationMs ?? 0)).toBe(
                toTenthSecond((endpoint.durationSeconds as number) * 1000),
              );
            });
          }

          if (endpoint.statusDistribution !== undefined) {
            it("status distribution", () => {
              expect(row?.statusDistribution).toEqual(endpoint.statusDistribution);
            });
          }
        });
      }
    }

    if (want.concurrency?.globalMaxInFlight !== undefined) {
      it("observed global concurrency ceiling", () => {
        expect(detectors.metrics["concurrency-ceiling"]?.["maxInFlight"]).toBe(
          want.concurrency?.globalMaxInFlight,
        );
      });
    }

    for (const wantedPage of want.pages ?? []) {
      describe("page " + wantedPage.pageRef, () => {
        const page = model.pages.find((candidate) => candidate.pageRef === wantedPage.pageRef);

        it("is present", () => {
          expect(page, "no page with pageRef " + wantedPage.pageRef).toBeDefined();
        });

        if (wantedPage.requests !== undefined) {
          it("request count", () => {
            expect(page?.entryCount).toBe(wantedPage.requests);
          });
        }

        if (wantedPage.onLoadMs !== undefined) {
          it("onLoad timing", () => {
            expect(page?.onLoadMs).toBe(wantedPage.onLoadMs);
          });
        }
      });
    }

    if (want.duplicatePayload !== undefined) {
      const dup = want.duplicatePayload;
      const findings = detectors.findings.filter(
        (finding) => finding.detectorId === "duplicate-payload-within-page",
      );

      if (dup.intraPageFindings !== undefined) {
        it("intra-page duplicate findings", () => {
          expect(
            findings.length,
            "Intra-page duplicates reported: " +
              findings.map((finding) => finding.key).join(" | ") +
              ". If a fix for these shipped, this is worth investigating before " +
              "assuming the detector is wrong.",
          ).toBe(dup.intraPageFindings);
        });
      }

      // Session-wide repetition crosses pages, so it is computed here from the
      // entries rather than by the within-page detector.
      const byBodyKey = new Map<string, number>();
      for (const entry of model.entries) {
        if (entry.requestBodyKey === null) continue;
        byBodyKey.set(entry.requestBodyKey, (byBodyKey.get(entry.requestBodyKey) ?? 0) + 1);
      }
      const repeats = [...byBodyKey.values()].filter((count) => count > 1).sort((a, b) => b - a);

      if (dup.sessionWideRepeatedPayloads !== undefined) {
        it("distinct payloads repeated anywhere in the capture", () => {
          expect(repeats).toHaveLength(dup.sessionWideRepeatedPayloads as number);
        });
      }

      if (dup.largestSessionWideRepeat !== undefined) {
        it("occurrences of the most repeated payload", () => {
          expect(repeats[0]).toBe(dup.largestSessionWideRepeat);
        });
      }
    }

    reportPending(expectations);
  });
}

/** Values recorded but not asserted, printed so they cannot go quiet. */
function reportPending(expectations: CaptureExpectations): void {
  const pending = expectations.pendingDefinitions;
  if (pending === undefined || Object.keys(pending).length === 0) return;

  it("records values awaiting an agreed definition", () => {
    console.warn(
      "\n  " +
        expectations.captureId +
        ": these values are known but NOT asserted, because how to compute " +
        "them has not been agreed:\n" +
        Object.entries(pending)
          .map(([name, note]) => "    - " + name + ": " + note)
          .join("\n") +
        "\n",
    );
    expect(Object.keys(pending).length).toBeGreaterThan(0);
  });
}

/**
 * The summary exists for one failure mode: a green badge on a run that
 * validated nothing. An empty fixtures directory must never look like success.
 */
afterAll(() => {
  const banner = "=".repeat(64);
  const lines = [
    "",
    banner,
    "GOLDEN CAPTURE VALIDATION",
    "  captures validated : " + ran,
    "  captures skipped   : " + skipped + (skipped > 0 ? "  (expectations present, file absent)" : ""),
    "  orphan captures    : " + orphans.length + (orphans.length > 0 ? "  (present, unasserted — FAILED)" : ""),
  ];

  if (ran === 0) {
    lines.push(
      "",
      "  NOTHING WAS VALIDATED AGAINST A REAL CAPTURE.",
      "  The rest of the suite passing does not mean phase 1 is accepted.",
      "  Put captures in packages/har-insights/test/fixtures/captures/",
      "  and expectations in .../fixtures/expectations/ (both gitignored).",
    );
  }
  lines.push(banner, "");
  console.warn(lines.join("\n"));
});

/**
 * Opt-in hard failure for anyone running validation deliberately:
 *   GOLDEN_REQUIRED=1 pnpm test
 * Off by default because a clean checkout has no fixtures and should still be
 * able to run the rest of the suite green.
 */
describe("golden validation coverage", () => {
  it("ran at least one golden capture when GOLDEN_REQUIRED is set", () => {
    if (process.env["GOLDEN_REQUIRED"] !== "1") {
      expect(true).toBe(true);
      return;
    }
    expect(
      ran,
      "GOLDEN_REQUIRED=1 was set but no real capture was validated.",
    ).toBeGreaterThan(0);
  });
});

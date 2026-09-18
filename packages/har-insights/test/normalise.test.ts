import { describe, expect, it } from "vitest";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { at, entry, har, page, truncatedHar } from "./support/har-builder.js";

const run = (source: string) => normaliseHar(parseHar(source));

describe("ordering and offsets", () => {
  it("sorts by start time rather than trusting file order", () => {
    // Exporters do not guarantee order, and every finding's evidence indexes
    // into this array.
    const result = run(
      har([
        entry({ startedDateTime: at(8), url: "https://example.test/late" }),
        entry({ startedDateTime: at(0), url: "https://example.test/early" }),
        entry({ startedDateTime: at(3), url: "https://example.test/middle" }),
      ]),
    );

    expect(result.entries.map((e) => e.path)).toEqual(["/early", "/middle", "/late"]);
    expect(result.entries.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it("measures offsetMs from the earliest entry, not the first in the file", () => {
    const result = run(
      har([
        entry({ startedDateTime: at(8) }),
        entry({ startedDateTime: at(0) }),
        entry({ startedDateTime: at(3) }),
      ]),
    );

    expect(result.entries.map((e) => e.offsetMs)).toEqual([0, 3000, 8000]);
    expect(result.entries.every((e) => e.offsetMs >= 0)).toBe(true);
  });

  it("keeps sourceIndex pointing at the file position, not the sorted one", () => {
    // A sorted position handed to someone as a file pointer sends them to the
    // wrong entry and they do not notice.
    const result = run(
      har([
        entry({ startedDateTime: at(8), url: "https://example.test/late" }),
        entry({ startedDateTime: at(0), url: "https://example.test/early" }),
      ]),
    );

    const early = result.entries[0];
    const late = result.entries[1];

    expect(early?.path).toBe("/early");
    expect(early?.index).toBe(0);
    expect(early?.sourceIndex).toBe(1);
    expect(late?.index).toBe(1);
    expect(late?.sourceIndex).toBe(0);
  });

  it("honours the timezone offset rather than slicing the string", () => {
    // Same instant, written in two zones. They must normalise to one time.
    const result = run(
      har([
        entry({ startedDateTime: "2026-09-18T12:00:00.000+00:00" }),
        entry({ startedDateTime: "2026-09-18T14:00:00.000+02:00" }),
      ]),
    );

    expect(result.entries[0]?.startedAt).toBe(result.entries[1]?.startedAt);
    // Both start at the same instant, so neither is offset from the other. The
    // window is the 100ms the entries last, not the two hours a string-slicing
    // parser would have invented.
    expect(result.entries.map((e) => e.offsetMs)).toEqual([0, 0]);
    expect(result.capture.windowMs).toBe(100);
  });

  it("keeps file order for entries sharing a start time", () => {
    const result = run(
      har([
        entry({ startedDateTime: at(1), url: "https://example.test/first" }),
        entry({ startedDateTime: at(1), url: "https://example.test/second" }),
      ]),
    );

    expect(result.entries.map((e) => e.path)).toEqual(["/first", "/second"]);
  });
});

describe("sizes and durations", () => {
  it("floors a -1 transfer size to 0, which Chrome writes for a cache hit", () => {
    const result = run(har([entry({ transferSize: -1, contentSize: 4096 })]));

    expect(result.entries[0]?.transferBytes).toBe(0);
    expect(result.entries[0]?.contentBytes).toBe(4096);
    expect(result.capture.totalTransferBytes).toBe(0);
    expect(result.capture.totalContentBytes).toBe(4096);
  });

  it("keeps transfer and uncompressed totals apart", () => {
    const result = run(
      har([
        entry({ transferSize: 594, contentSize: 2550 }),
        entry({ transferSize: 100, contentSize: 100 }),
      ]),
    );

    expect(result.capture.totalTransferBytes).toBe(694);
    expect(result.capture.totalContentBytes).toBe(2650);
  });

  it("treats an unreported duration as unknown rather than instantaneous", () => {
    const result = run(
      har([entry({ startedDateTime: at(0), time: -1 }), entry({ startedDateTime: at(1), time: 250 })]),
    );

    const unknown = result.entries[0];
    expect(unknown?.durationMs).toBeNull();
    expect(unknown?.endedAt).toBeNull();

    const known = result.entries[1];
    expect(known?.durationMs).toBe(250);
    expect(known?.endedAt).toBe((known?.startedAt ?? 0) + 250);

    const diagnostic = result.diagnostics.find((d) => d.code === "entry-missing-duration");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.count).toBe(1);
  });

  it("excludes an unknown duration from the capture window instead of guessing", () => {
    const result = run(har([entry({ startedDateTime: at(0), time: -1 })]));

    // The entry contributes its start only, so the window stays a lower bound.
    expect(result.capture.windowMs).toBe(0);
    expect(result.capture.endedAt).toBe(result.capture.startedAt);
  });

  it("floors unreported wait and blocked to 0 but says the sums are lower bounds", () => {
    const result = run(har([entry({ wait: -1, blocked: -1 }), entry({ wait: 30, blocked: 2 })]));

    expect(result.entries[0]?.waitMs).toBe(0);
    expect(result.entries[0]?.blockedMs).toBe(0);

    const diagnostic = result.diagnostics.find((d) => d.code === "unreported-timings");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("LOWER BOUND");
  });
});

describe("request bodies", () => {
  it("gives key-order-differing bodies the same requestBodyKey through a capture", () => {
    const result = run(
      har([
        entry({ requestBody: '{"fundId":"abc","asOf":"2024-01-01"}' }),
        entry({ requestBody: '{"asOf":"2024-01-01","fundId":"abc"}' }),
      ]),
    );

    expect(result.entries[0]?.requestBodyKey).toBe(result.entries[1]?.requestBodyKey);
    expect(result.entries[0]?.requestBodyKey).not.toBeNull();
  });

  it("falls back to the raw string for a non-JSON body and flags the blind spot", () => {
    const result = run(
      har([entry({ requestBody: "a=1&b=2", requestMimeType: "application/x-www-form-urlencoded" })]),
    );

    expect(result.entries[0]?.requestBodyKey).not.toBeNull();

    const diagnostic = result.diagnostics.find((d) => d.code === "non-json-request-body");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("UNDER-REPORT");
    expect(diagnostic?.count).toBe(1);
  });

  it("does not flag non-JSON bodies when every body is JSON", () => {
    const result = run(har([entry({ requestBody: '{"a":1}' }), entry()]));
    expect(result.diagnostics.map((d) => d.code)).not.toContain("non-json-request-body");
  });

  it("keeps an absent body distinct from one that is literally null", () => {
    const result = run(
      har([entry({ requestBody: null }), entry({ requestBody: "null" })]),
    );

    expect(result.entries[0]?.requestBody).toBeNull();
    expect(result.entries[0]?.requestBodyKey).toBeNull();
    expect(result.entries[1]?.requestBodyKey).not.toBeNull();
  });

  it("hashes the response body only when the capture recorded one", () => {
    const result = run(
      har([entry({ responseText: '{"ok":true}' }), entry({ responseText: null })]),
    );

    expect(result.entries[0]?.responseBodyHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.entries[1]?.responseBodyHash).toBeNull();
  });
});

describe("headers, status and failure", () => {
  it("reads cache-control and etag case-insensitively", () => {
    const result = run(har([entry({ etag: 'W/"abc"', cacheControl: "max-age=60" })]));

    expect(result.entries[0]?.etag).toBe('W/"abc"');
    expect(result.entries[0]?.cacheControl).toBe("max-age=60");
  });

  it("returns null for headers the response did not carry", () => {
    const result = run(har([entry()]));

    expect(result.entries[0]?.etag).toBeNull();
    expect(result.entries[0]?.cacheControl).toBeNull();
  });

  it("counts a transport error as a failure", () => {
    const result = run(har([entry({ status: 0, error: "net::ERR_ABORTED" })]));

    expect(result.entries[0]?.isFailure).toBe(true);
    expect(result.entries[0]?.error).toBe("net::ERR_ABORTED");
  });

  it("does NOT count a 404 or a 500 as a failure, because those are answers", () => {
    const result = run(har([entry({ status: 404 }), entry({ status: 500 })]));

    expect(result.entries.every((e) => e.isFailure)).toBe(false);
    expect(result.entries.map((e) => e.status)).toEqual([404, 500]);
  });
});

describe("pages", () => {
  it("handles a capture with no pages array", () => {
    const result = run(har([entry({ pageref: "page_1" })], null));

    expect(result.pages).toEqual([]);
    expect(result.capture.pageCount).toBe(0);
    // The reference is kept: it still groups entries that belong together.
    expect(result.entries[0]?.pageRef).toBe("page_1");
  });

  it("keeps a pageRef that resolves to no page, and diagnoses it", () => {
    const result = run(
      har([entry({ pageref: "page_ghost" }), entry({ pageref: "page_1" })], [page({ id: "page_1" })]),
    );

    expect(result.entries.find((e) => e.pageRef === "page_ghost")).toBeDefined();
    expect(result.pages.map((p) => p.pageRef)).toEqual(["page_1"]);

    const diagnostic = result.diagnostics.find((d) => d.code === "unresolved-page-ref");
    expect(diagnostic?.count).toBe(1);
    expect(diagnostic?.data?.["references"]).toBe(1);
  });

  it("derives the page window from its entries, not the page record alone", () => {
    const result = run(
      har(
        [
          entry({ startedDateTime: at(1), time: 5000, pageref: "page_1" }),
          entry({ startedDateTime: at(2), time: 100, pageref: "page_1" }),
        ],
        [page({ id: "page_1", startedDateTime: at(0) })],
      ),
    );

    const only = result.pages[0];
    // The long first request outlasts the one that started after it, so the
    // page ends later than its last entry began.
    expect(only?.firstEntryAt).toBe(result.entries[0]?.startedAt);
    expect(only?.lastEntryEndAt).toBe((result.entries[0]?.startedAt ?? 0) + 5000);
    expect(only?.durationMs).toBe(5000);
    expect(only?.entryCount).toBe(2);
  });

  it("exposes entryIndices that index the sorted array", () => {
    const result = run(
      har(
        [
          entry({ startedDateTime: at(5), pageref: "page_1" }),
          entry({ startedDateTime: at(0), pageref: "page_1" }),
        ],
        [page({ id: "page_1" })],
      ),
    );

    const indices = result.pages[0]?.entryIndices ?? [];
    expect([...indices]).toEqual([0, 1]);
    for (const i of indices) {
      expect(result.entries[i]?.index).toBe(i);
    }
  });

  it("keeps null page timings null rather than flooring them to zero", () => {
    const result = run(har([entry()], [page({ onLoad: -1, onContentLoad: 400 })]));

    expect(result.pages[0]?.onLoadMs).toBeNull();
    expect(result.pages[0]?.onContentLoadMs).toBe(400);
  });

  it("ignores a repeated page id and says so", () => {
    const result = run(
      har([entry()], [page({ id: "page_1", title: "first" }), page({ id: "page_1", title: "second" })]),
    );

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.title).toBe("first");
    expect(result.diagnostics.map((d) => d.code)).toContain("duplicate-page-id");
  });

  it("lists unpaged entries so a page walk cannot silently miss them", () => {
    // Not hypothetical: a real capture had unpaged entries spanning minutes.
    const result = run(
      har(
        [
          entry({ startedDateTime: at(0), pageref: "page_1" }),
          entry({ startedDateTime: at(1), pageref: null }),
          entry({ startedDateTime: at(2), pageref: null }),
        ],
        [page({ id: "page_1" })],
      ),
    );

    expect([...result.capture.unpagedEntryIndices]).toEqual([1, 2]);
    expect(result.entries[1]?.pageRef).toBeNull();

    const reachableViaPages = new Set(result.pages.flatMap((p) => [...p.entryIndices]));
    for (const index of result.capture.unpagedEntryIndices) {
      expect(reachableViaPages.has(index)).toBe(false);
    }
    // Every entry is reachable through pages plus the unpaged list, together.
    expect(reachableViaPages.size + result.capture.unpagedEntryIndices.length).toBe(
      result.capture.entryCount,
    );
  });
});

describe("dropped entries and reliability", () => {
  it("drops an entry with no usable timestamp rather than inventing one", () => {
    const broken = entry();
    delete (broken as Record<string, unknown>)["startedDateTime"];
    const result = run(har([broken, entry({ startedDateTime: at(0) })]));

    expect(result.capture.entryCount).toBe(1);
    expect(result.capture.droppedEntries).toBe(1);

    const diagnostic = result.diagnostics.find((d) => d.code === "entry-missing-timestamp");
    expect(diagnostic?.data?.["attempted"]).toBe(2);
  });

  it("stays reliable when the loss is a footnote", () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry({ startedDateTime: at(i) }));
    const broken = entry();
    delete (broken as Record<string, unknown>)["startedDateTime"];
    const result = run(har([...entries, broken]));

    expect(result.capture.droppedEntries).toBe(1);
    expect(result.capture.reliable).toBe(true);
    expect(
      result.diagnostics.find((d) => d.code === "entry-missing-timestamp")?.severity,
    ).toBe("warning");
  });

  it("becomes unreliable, at error severity, once losses exceed 1%", () => {
    // The failure mode this guards against is a clean-looking report built on
    // missing data.
    const kept = Array.from({ length: 90 }, (_, i) => entry({ startedDateTime: at(i) }));
    const dropped = Array.from({ length: 10 }, () => {
      const broken = entry();
      delete (broken as Record<string, unknown>)["startedDateTime"];
      return broken;
    });
    const result = run(har([...kept, ...dropped]));

    expect(result.capture.droppedEntries).toBe(10);
    expect(result.capture.reliable).toBe(false);

    const diagnostic = result.diagnostics.find((d) => d.code === "entry-missing-timestamp");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("must not be presented as whole");
  });
});

describe("capture completeness", () => {
  it("carries truncation through to the capture", () => {
    const entries = [
      entry({ startedDateTime: at(0) }),
      entry({ startedDateTime: at(1) }),
      entry({ startedDateTime: at(2) }),
    ];
    const result = run(truncatedHar(entries, 2, 40));

    expect(result.capture.complete).toBe(false);
    expect(result.capture.recoveredEntries).toBe(2);
    expect(result.capture.entryCount).toBe(2);
    expect(result.capture.truncatedAtCharOffset).toBeGreaterThan(0);
  });

  it("marks a whole capture complete with no truncation offset", () => {
    const result = run(har([entry()]));

    expect(result.capture.complete).toBe(true);
    expect(result.capture.truncatedAtCharOffset).toBeNull();
    expect(result.capture.reliable).toBe(true);
  });

  it("produces a usable empty model for a capture with no entries", () => {
    const result = run(har([]));

    expect(result.capture.entryCount).toBe(0);
    expect(result.capture.windowMs).toBe(0);
    expect(result.capture.startedAt).toBe(0);
    expect(result.capture.reliable).toBe(true);
  });
});

describe("immutability", () => {
  it("freezes the result so nothing can re-sort the array under the indices", () => {
    // Every finding references entries by their position in this array. A
    // consumer sorting it in place would invalidate stored evidence silently.
    const result = run(har([entry({ startedDateTime: at(1) }), entry({ startedDateTime: at(0) })]));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries[0])).toBe(true);
    expect(Object.isFrozen(result.capture)).toBe(true);
    expect(() => (result.entries as unknown as unknown[]).sort()).toThrow();
  });
});

describe("JSON response markers", () => {
  it("measures the first and last JSON response from the page start", () => {
    const result = run(
      har(
        [
          // HTML first, then JSON, then an image, then more JSON.
          entry({ startedDateTime: at(1), time: 100, mimeType: "text/html", pageref: "page_1" }),
          entry({ startedDateTime: at(2), time: 500, mimeType: "application/json", pageref: "page_1" }),
          entry({ startedDateTime: at(3), time: 100, mimeType: "image/png", pageref: "page_1" }),
          entry({ startedDateTime: at(5), time: 250, mimeType: "application/json; charset=utf-8", pageref: "page_1" }),
        ],
        [page({ id: "page_1", startedDateTime: at(0) })],
      ),
    );

    const only = result.pages[0];
    // First JSON starts 2s after the page started.
    expect(only?.firstJsonResponseMs).toBe(2000);
    // Last JSON ends 5s + 250ms after the page started.
    expect(only?.lastJsonResponseMs).toBe(5250);
  });

  it("matches any mime type containing json, including +json suffixes", () => {
    const result = run(
      har(
        [entry({ startedDateTime: at(1), time: 100, mimeType: "application/problem+json", pageref: "page_1" })],
        [page({ id: "page_1", startedDateTime: at(0) })],
      ),
    );

    expect(result.pages[0]?.firstJsonResponseMs).toBe(1000);
  });

  it("is null for a page with no JSON response at all", () => {
    const result = run(
      har(
        [entry({ startedDateTime: at(1), mimeType: "text/css", pageref: "page_1" })],
        [page({ id: "page_1", startedDateTime: at(0) })],
      ),
    );

    expect(result.pages[0]?.firstJsonResponseMs).toBeNull();
    expect(result.pages[0]?.lastJsonResponseMs).toBeNull();
  });

  it("falls back to the first entry when the page declares no start time", () => {
    const broken = page({ id: "page_1" });
    delete (broken as Record<string, unknown>)["startedDateTime"];
    const result = run(
      har(
        [entry({ startedDateTime: at(4), time: 100, mimeType: "application/json", pageref: "page_1" })],
        [broken],
      ),
    );

    // Measured from its own first entry, so the first JSON is at zero.
    expect(result.pages[0]?.startedAt).toBeNull();
    expect(result.pages[0]?.firstJsonResponseMs).toBe(0);
    expect(result.pages[0]?.lastJsonResponseMs).toBe(100);
  });

  it("treats an entry with unknown duration as ending when it started", () => {
    const result = run(
      har(
        [entry({ startedDateTime: at(2), time: -1, mimeType: "application/json", pageref: "page_1" })],
        [page({ id: "page_1", startedDateTime: at(0) })],
      ),
    );

    expect(result.pages[0]?.lastJsonResponseMs).toBe(2000);
  });
});

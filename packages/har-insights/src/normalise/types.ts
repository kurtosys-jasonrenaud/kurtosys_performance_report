import type { Diagnostic } from "../diagnostics.js";

/**
 * One request from a capture, in the shape every detector reads.
 *
 * This is the contract. Detectors depend on it, run records are derived from
 * it, and stored comparisons are only valid while it holds still — changing it
 * means bumping analyzerVersion, which invalidates every stored run record for
 * comparison.
 *
 * Every field is readonly, and normaliseHar freezes what it returns. The array
 * is sorted by start time and `index` points into that order, so anything that
 * re-sorted it would silently invalidate every index in every finding.
 *
 * Two rules run through the design:
 *
 *   1. Counts and durations are different kinds of fact. Request counts,
 *      payload sizes and concurrency follow from the code and compare cleanly
 *      between environments; durations do not, because they are a property of
 *      the machine, the network and the day.
 *   2. Nothing here asserts intent or cause. Every field is something the
 *      capture said, or "unknown" where it said nothing.
 */
export interface NormalisedEntry {
  /**
   * Position in the normalised, time-ordered entry array. Findings refer to
   * entries by this index.
   */
  readonly index: number;

  /**
   * Position in the file's own entries array — what to count to in DevTools or
   * jq to find this exact request.
   *
   * Kept separate from `index` because entries are mostly, but not reliably,
   * in file order. A sorted position handed to someone as a pointer into a file
   * lands on the wrong entry, and they do not notice. On a truncated capture
   * this is the position within the entries that were readable, which remains
   * a valid pointer.
   */
  readonly sourceIndex: number;

  /**
   * The page this entry declared. Kept as captured even when it resolves to no
   * page in `pages`, because it still groups entries that belong together; a
   * diagnostic records the mismatch. null when the entry declared no page — see
   * NormalisedCapture.unpagedEntryIndices, which is how those are reached.
   */
  readonly pageRef: string | null;

  /** Epoch milliseconds, parsed from startedDateTime including its offset. */
  readonly startedAt: number;
  /** Milliseconds since the earliest entry in the capture. Never negative. */
  readonly offsetMs: number;
  /** startedAt + durationMs, or null when the duration is unknown. */
  readonly endedAt: number | null;

  /**
   * entry.time, or null when the capture did not report it.
   *
   * null rather than 0, deliberately. HAR writes -1 for "not measured", and
   * flooring that to 0 asserts an instantaneous request: it understates
   * duration sums and, worse, gives the concurrency sweep a false end time so
   * the request appears to close the moment it opened. Null forces every
   * consumer to decide what to do about an unknown, and those entries are
   * excluded from sums and sweeps rather than counted as zero.
   */
  readonly durationMs: number | null;

  /**
   * timings.wait — time spent waiting for the first response byte. Unreported
   * timings (HAR's -1) become 0.
   *
   * This differs from durationMs on purpose, and the difference should not be
   * "tidied up": wait and blocked are components, not the whole, so a missing
   * one costs precision rather than inventing an event that did not happen.
   * The consequence is that any SUM of waitMs across entries is a LOWER BOUND,
   * not a total. A capture containing unreported timings raises the
   * "unreported-timings" diagnostic so the figure can be caveated.
   */
  readonly waitMs: number;
  /** timings.blocked — time queued before the request went out. See waitMs. */
  readonly blockedMs: number;

  readonly method: string;
  /**
   * The URL as captured, query string included.
   *
   * WARNING: query strings in these captures carry session and access tokens.
   * This field exists for the in-browser view model. It must never be copied
   * into a run record — see the allowlist rule in the package README.
   */
  readonly url: string;
  /** scheme://host[:port], lowercased, credentials stripped. */
  readonly origin: string;
  /** Pathname only, query stripped. The grouping key for endpoint rollups. */
  readonly path: string;

  /** HTTP status. 0 when the request never completed. */
  readonly status: number;

  /** request.postData.text, or null when the request carried no body. */
  readonly requestBody: string | null;
  /**
   * Stable hash of the request body with JSON object keys recursively sorted,
   * falling back to a hash of the raw string for non-JSON bodies. null when
   * there was no body. Two requests differing only in key order share this
   * value; that is the whole point of it.
   */
  readonly requestBodyKey: string | null;
  /** Hash of the response body, or null when the capture did not include one. */
  readonly responseBodyHash: string | null;

  /** response._transferSize, floored at 0. Chrome reports -1 on a cache hit. */
  readonly transferBytes: number;
  /** response.content.size — decoded size, floored at 0. */
  readonly contentBytes: number;

  /** response.content.mimeType as captured, parameters and all. */
  readonly mimeType: string;
  readonly cacheControl: string | null;
  readonly etag: string | null;
  /** response.httpVersion, e.g. "h2" or "http/1.1". */
  readonly protocol: string;

  /** response._error, e.g. "net::ERR_ABORTED". null when there was none. */
  readonly error: string | null;
  /**
   * A transport-level failure: the request produced no status, or the browser
   * reported an error. Note that a 404 or a 500 is NOT a failure by this
   * definition — those are answers, and belong to status distribution.
   */
  readonly isFailure: boolean;
}

/**
 * A page from the capture, with its window derived from the entries that
 * claimed it rather than from the page record alone.
 */
export interface NormalisedPage {
  readonly pageRef: string;
  /** page.title. Chrome puts the page URL here; no route is inferred from it. */
  readonly title: string;
  /** Epoch ms from the page's own startedDateTime, null if unusable. */
  readonly startedAt: number | null;

  /**
   * pageTimings.onContentLoad, null when the browser did not report it.
   *
   * Unlike waitMs this keeps null instead of flooring to 0, and the asymmetry
   * is deliberate: page timings are never summed, so "not reported" and
   * "happened at zero milliseconds" are genuinely different statements and
   * collapsing them would lose the distinction for no gain.
   */
  readonly onContentLoadMs: number | null;
  /** pageTimings.onLoad. See onContentLoadMs for why this is null, not 0. */
  readonly onLoadMs: number | null;

  readonly entryCount: number;
  /**
   * Indices into the SORTED entry array — NormalisedEntry.index, not
   * sourceIndex — in time order.
   *
   * Carried on the page so detectors working per page do not each re-filter
   * the whole capture. Valid only because the entry array is frozen and cannot
   * be re-sorted underneath it.
   */
  readonly entryIndices: readonly number[];

  /** Earliest entry start on this page. Falls back to startedAt when empty. */
  readonly firstEntryAt: number;
  /**
   * Latest known entry end on this page. Entries with an unknown duration
   * contribute their start time, so this is a lower bound when any are present.
   */
  readonly lastEntryEndAt: number;
  /** lastEntryEndAt - firstEntryAt. 0 for a page with no entries. */
  readonly durationMs: number;

  readonly transferBytes: number;
}

/** Capture-wide totals. All of these are counts or sizes except windowMs. */
export interface NormalisedCapture {
  readonly entryCount: number;
  readonly pageCount: number;

  /** Earliest entry start, epoch ms. 0 when the capture has no entries. */
  readonly startedAt: number;
  /**
   * Latest known entry end, epoch ms. 0 when the capture has no entries.
   * Entries with an unknown duration contribute their start time.
   */
  readonly endedAt: number;
  /** endedAt - startedAt. Meaningless, and 0, when entryCount is 0. */
  readonly windowMs: number;

  readonly totalTransferBytes: number;
  /**
   * Summed decoded content size, which exceeds transfer when responses are
   * compressed. Kept alongside transfer because the gap between the two is
   * itself a measurement people ask about.
   */
  readonly totalContentBytes: number;

  /**
   * Indices of entries that declared no page.
   *
   * These belong to no NormalisedPage and are therefore unreachable through
   * page.entryIndices. A detector that only walks pages will silently miss
   * them, and that is not hypothetical — a real capture had 18 unpaged entries
   * spanning 290 seconds. Walk this as well as the pages, or walk the entry
   * array directly.
   */
  readonly unpagedEntryIndices: readonly number[];

  /**
   * false when the capture was recovered from a truncated file. Carried this
   * far because every total above is then a total of what survived, and a
   * comparison against a complete capture is not like for like.
   */
  readonly complete: boolean;
  readonly recoveredEntries: number;
  /** UTF-16 code unit offset where recovery stopped. See HarParseResult. */
  readonly truncatedAtCharOffset: number | null;

  /** How many entries were discarded for having no usable timestamp. */
  readonly droppedEntries: number;
  /**
   * false when enough entries were dropped that the totals above cannot be
   * trusted — currently more than 1% of the capture.
   *
   * The threshold exists because the failure mode is a clean-looking report
   * built on missing data. Losing five entries is a footnote; losing five
   * hundred makes every total wrong while the output still looks finished.
   */
  readonly reliable: boolean;
}

export interface NormaliseResult {
  readonly entries: readonly NormalisedEntry[];
  readonly pages: readonly NormalisedPage[];
  readonly capture: NormalisedCapture;
  /** Parsing and normalisation diagnostics, in that order. */
  readonly diagnostics: readonly Diagnostic[];
}

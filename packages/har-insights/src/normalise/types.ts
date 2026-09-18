import type { Diagnostic } from "../diagnostics.js";

/**
 * One request from a capture, in the shape every detector reads.
 *
 * This is the contract. Detectors depend on it, run records are derived from
 * it, and stored comparisons are only valid while it holds still — so it is
 * expensive to change once there are callers, and worth arguing about now.
 *
 * Two rules run through it:
 *
 *   1. Counts and durations are different kinds of fact. Request counts,
 *      payload sizes and concurrency follow from the code and compare cleanly
 *      between environments; durations do not, because they are a property of
 *      the machine, the network and the day. Both live here, but a consumer
 *      that treats them alike is making a mistake the model is trying to warn
 *      it about.
 *   2. Nothing here asserts intent or cause. Every field is something the
 *      capture said.
 */
export interface NormalisedEntry {
  /**
   * Position in the normalised, time-ordered entry array — NOT the position in
   * the file. Entries are sorted by start time during normalisation because
   * exporters do not guarantee file order, and every piece of evidence refers
   * to entries by this index.
   */
  index: number;

  /**
   * The page this entry declared. Kept as captured even when it resolves to no
   * page in `pages`, because it still groups entries that belong together; a
   * diagnostic records the mismatch. null when the entry declared no page.
   */
  pageRef: string | null;

  /** Epoch milliseconds, parsed from startedDateTime including its offset. */
  startedAt: number;
  /** Milliseconds since the earliest entry in the capture. Never negative. */
  offsetMs: number;
  /** startedAt + durationMs. */
  endedAt: number;

  /** entry.time. Negative values, which HAR uses for "unknown", become 0. */
  durationMs: number;
  /** timings.wait — time spent waiting for the first response byte. */
  waitMs: number;
  /** timings.blocked — time queued before the request went out. */
  blockedMs: number;

  method: string;
  /** The URL as captured, query included. */
  url: string;
  /** scheme://host[:port], lowercased, credentials stripped. */
  origin: string;
  /** Pathname only, query stripped. The grouping key for endpoint rollups. */
  path: string;

  /** HTTP status. 0 when the request never completed. */
  status: number;

  /** request.postData.text, or null when the request carried no body. */
  requestBody: string | null;
  /**
   * Stable hash of the request body with JSON object keys recursively sorted,
   * falling back to the raw string for non-JSON bodies. null when there was no
   * body. Two requests differing only in key order share this value; that is
   * the whole point of it.
   */
  requestBodyKey: string | null;
  /** Hash of the response body, or null when the capture did not include one. */
  responseBodyHash: string | null;

  /** response._transferSize, floored at 0. Chrome reports -1 on a cache hit. */
  transferBytes: number;
  /** response.content.size — decoded size, floored at 0. */
  contentBytes: number;

  /** response.content.mimeType as captured, parameters and all. */
  mimeType: string;
  cacheControl: string | null;
  etag: string | null;
  /** response.httpVersion, e.g. "h2" or "http/1.1". */
  protocol: string;

  /** response._error, e.g. "net::ERR_ABORTED". null when there was none. */
  error: string | null;
  /**
   * A transport-level failure: the request produced no status, or the browser
   * reported an error. Note that a 404 or a 500 is NOT a failure by this
   * definition — those are answers, and belong to status distribution.
   */
  isFailure: boolean;
}

/**
 * A page from the capture, with its window derived from the entries that
 * claimed it rather than from the page record alone.
 */
export interface NormalisedPage {
  pageRef: string;
  /** page.title. Chrome puts the page URL here; no route is inferred from it. */
  title: string;
  /** Epoch ms from the page's own startedDateTime, null if unusable. */
  startedAt: number | null;

  /** pageTimings.onContentLoad. null when the browser did not report it. */
  onContentLoadMs: number | null;
  /** pageTimings.onLoad. null when the browser did not report it. */
  onLoadMs: number | null;

  entryCount: number;
  /**
   * Indices into the normalised entry array, in time order. Carried on the page
   * so that detectors working per page do not each re-filter the whole capture.
   */
  entryIndices: number[];

  /** Earliest entry start on this page. Falls back to startedAt when empty. */
  firstEntryAt: number;
  /** Latest entry end on this page. Falls back to startedAt when empty. */
  lastEntryEndAt: number;
  /** lastEntryEndAt - firstEntryAt. 0 for a page with no entries. */
  durationMs: number;

  transferBytes: number;
}

/** Capture-wide totals. All of these are counts or sizes except windowMs. */
export interface NormalisedCapture {
  entryCount: number;
  pageCount: number;

  /** Earliest entry start, epoch ms. 0 when the capture has no entries. */
  startedAt: number;
  /** Latest entry end, epoch ms. 0 when the capture has no entries. */
  endedAt: number;
  /** endedAt - startedAt. Meaningless, and 0, when entryCount is 0. */
  windowMs: number;

  totalTransferBytes: number;
  /** Summed decoded content size, which exceeds transfer when responses are
   *  compressed. Kept alongside transfer because the gap between the two is
   *  itself a measurement people ask about. */
  totalContentBytes: number;

  /**
   * false when the capture was recovered from a truncated file. Carried this
   * far because every total above is then a total of what survived, and a
   * comparison against a complete capture is not like for like.
   */
  complete: boolean;
  recoveredEntries: number;
  truncatedAt: number | null;
}

export interface NormaliseResult {
  entries: NormalisedEntry[];
  pages: NormalisedPage[];
  capture: NormalisedCapture;
  /** Parsing and normalisation diagnostics, in that order. */
  diagnostics: Diagnostic[];
}

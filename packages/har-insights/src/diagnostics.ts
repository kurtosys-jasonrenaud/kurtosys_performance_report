/**
 * A machine-readable note about something the analyser had to tolerate.
 *
 * Diagnostics are not findings. A finding is a statement about the captured
 * system; a diagnostic is a statement about the capture file itself — it was
 * truncated, an entry had no timestamp, a pageRef pointed at nothing.
 *
 * They are structured, and `code` is a closed union rather than free text, for
 * one reason: run records carry diagnostics forward, and the comparison view
 * has to match them across runs. Free-text codes cannot be matched, so a
 * caveat that applied to both of two captures would read as a new problem in
 * the second. Anything a reader might need to act on numerically goes in
 * `data`, not only into the prose of `message`.
 */
export interface Diagnostic {
  /** Stable identifier. Safe to switch on, safe to store, safe to match. */
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** Human-readable, already containing any counts. Never client-identifying. */
  message: string;
  /** How many occurrences this one diagnostic stands for. At least 1. */
  count: number;
  /**
   * Machine-readable detail, so a consumer never has to parse `message`.
   * Must stay free of payloads and identifiers, like everything that can reach
   * a run record.
   */
  data?: Record<string, unknown>;
}

/**
 * - info: worth knowing, changes nothing about how the numbers are read.
 * - warning: the numbers are usable but carry a caveat.
 * - error: something is wrong enough that totals should not be trusted as-is.
 */
export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticCode =
  /** The file did not parse whole; entries were recovered by scanning. */
  | "truncated-capture"
  /** No `entries` array could be located at all. */
  | "entries-not-found"
  /** The file parsed, but carried no entries. */
  | "empty-capture"
  /** The file did not have the shape of a HAR log. */
  | "unrecognised-shape"
  /** Entries had no usable startedDateTime and were dropped. */
  | "entry-missing-timestamp"
  /** Entries reported no duration; they are excluded from sums and sweeps. */
  | "entry-missing-duration"
  /** Some wait/blocked timings were unreported, so their sums are lower bounds. */
  | "unreported-timings"
  /** Non-JSON request bodies present; duplicate detection may under-report. */
  | "non-json-request-body"
  /** An entry's pageRef did not resolve to any page in `pages`. */
  | "unresolved-page-ref"
  /** Two pages declared the same id; the first one wins. */
  | "duplicate-page-id";

export function diagnostic(
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  count = 1,
  data?: Record<string, unknown>,
): Diagnostic {
  // Built without the key rather than with an undefined key, so that a
  // serialised diagnostic never carries a meaningless "data": null.
  return data === undefined
    ? { code, severity, message, count }
    : { code, severity, message, count, data };
}

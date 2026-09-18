/**
 * A machine-readable note about something the analyser had to tolerate.
 *
 * Diagnostics are not findings. A finding is a statement about the captured
 * system; a diagnostic is a statement about the capture file itself — it was
 * truncated, an entry had no timestamp, a pageRef pointed at nothing. They are
 * kept structured rather than as free text because the run record has to carry
 * them forward: a comparison between a complete capture and a recovered one is
 * not a like-for-like comparison, and the person reading it needs to know.
 */
export interface Diagnostic {
  /** Stable identifier. Safe to switch on; safe to store. */
  code: DiagnosticCode;
  /** Human-readable, already containing any counts. Never client-identifying. */
  message: string;
  /** How many occurrences this one diagnostic stands for. At least 1. */
  count: number;
}

export type DiagnosticCode =
  /** The file did not parse whole; entries were recovered by scanning. */
  | "truncated-capture"
  /** No `entries` array could be located at all. */
  | "entries-not-found"
  /** The file parsed, but carried no entries. */
  | "empty-capture"
  /** The file did not have the shape of a HAR log. */
  | "unrecognised-shape"
  /** An entry had no usable startedDateTime and was dropped. */
  | "entry-missing-timestamp"
  /** An entry's pageRef did not resolve to any page in `pages`. */
  | "unresolved-page-ref"
  /** Two pages declared the same id; the first one wins. */
  | "duplicate-page-id";

export function diagnostic(
  code: DiagnosticCode,
  message: string,
  count = 1,
): Diagnostic {
  return { code, message, count };
}

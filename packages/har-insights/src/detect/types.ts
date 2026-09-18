import type { Diagnostic } from "../diagnostics.js";
import type {
  NormalisedCapture,
  NormalisedEntry,
  NormalisedPage,
} from "../normalise/types.js";

/**
 * Identifier for a detector. A plain string for now; it becomes a union once
 * the set stabilises, at which point a typo in a finding's detectorId stops
 * compiling.
 */
export type DetectorId = string;

export type FindingSeverity = "low" | "medium" | "high";

export type DetectorCategory =
  | "redundancy"
  | "concurrency"
  | "payload"
  | "caching"
  | "errors";

/**
 * What a detector reads. An OBJECT rather than positional arguments, because a
 * client profile and a configuration land here in a later phase and adding them
 * to a positional signature breaks every existing call site.
 */
export interface DetectorContext {
  readonly entries: readonly NormalisedEntry[];
  readonly pages: readonly NormalisedPage[];
  readonly capture: NormalisedCapture;
  /**
   * Parse and normalise diagnostics. A detector reads these to know what it
   * cannot see — a truncated capture or a set of non-JSON bodies changes what
   * its silence means.
   */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A measured statement about the captured system, with the evidence that backs
 * it.
 *
 * EVIDENCE CARRIES HASHES, NEVER BODIES, AND PATHS, NEVER URLS. This is the
 * point at which the privacy design fails if anyone is careless: a duplicate
 * payload finding whose evidence contained the duplicated payload would be
 * carrying investor data, and a finding that quoted a url would be carrying the
 * session token in its query string. Entry indices are what make a hash
 * sufficient — they let a person open the capture and look at the real thing,
 * which never has to leave their browser.
 */
export interface Finding {
  readonly detectorId: DetectorId;
  /** The version of the detector that produced it. See DetectorSpec.version. */
  readonly detectorVersion: number;

  /**
   * Identifies the SUBJECT of the finding, and must be stable across captures.
   *
   * This is what lets a later phase say a finding is new, resolved or still
   * present. Build it from the detector id, method, PATH and page route —
   * things that describe what the finding is about. Never from counts,
   * durations or sizes: those change every capture, so a value-derived key
   * makes every finding look new on every run and the comparison view becomes
   * noise.
   *
   *   good: duplicate-payload-within-page:POST:/services/dataset/execute:/dashboards/
   *   bad:  duplicate-payload-within-page:3-calls-4163ms
   */
  readonly key: string;

  readonly severity: FindingSeverity;

  /**
   * What was measured, in one sentence.
   *
   * It states the measurement and nothing else. It never states cause, intent
   * or remedy — those are a person's job, written with context this tool does
   * not have.
   *
   *   good: "Identical request payload issued 3 times within /dashboards/"
   *   bad:  "Redundant call caused by two components requesting independently"
   *   bad:  "Should be deduplicated with a request cache"
   *
   * The second is a hypothesis; the third is advice. Neither is a measurement.
   */
  readonly summary: string;

  /** Enough to reconstruct the claim without re-reading the capture. */
  readonly evidence: Record<string, unknown>;
}

export interface DetectorResult {
  readonly findings: Finding[];
  /**
   * Measurements that are not findings. An observed number — a concurrency
   * ceiling, an endpoint rollup — is a fact about the capture, not a problem
   * with it. It becomes a finding only when compared against an expectation,
   * and expectations live in profiles, not here.
   */
  readonly metrics?: Record<string, unknown>;
}

/**
 * A detector: a pure function from a context to findings and metrics.
 *
 * Pure means pure. No I/O, no Date.now(), no randomness, no reading anything
 * outside the context. The same capture must produce byte-identical output
 * including ORDER, because run records are diffed against each other and any
 * instability in ordering shows up in a comparison as churn we invented
 * ourselves.
 */
export interface DetectorSpec {
  readonly id: DetectorId;
  /**
   * Version of THIS detector, independent of the package's analyzerVersion.
   *
   * Deliberately per-detector: the package version is too coarse a stamp, and
   * fixing a typo in one detector should not invalidate cross-run comparison
   * for every other one. A later phase needs to be able to say "endpoint-rollup
   * is unchanged, safe to compare; duplicate-payload went from v1 to v2, flag
   * that comparison".
   *
   * Bump it whenever the meaning of the output changes — different grouping,
   * different severity thresholds, a different key. Not for a comment.
   */
  readonly version: number;
  readonly title: string;
  readonly category: DetectorCategory;
  run(context: DetectorContext): DetectorResult;
}

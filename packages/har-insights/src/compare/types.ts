import type { RunRecordFinding } from "../record/types.js";

/**
 * Comparing two runs.
 *
 * The failure mode of a comparison tool is showing an improvement that is not
 * real. Every report we have written by hand has had to caveat exactly that, so
 * the caveats are built into the output rather than left to whoever reads it.
 */

/**
 * Counts follow from the code. Durations follow from the machine, the network
 * and the day. Presenting them the same way invites a reader to trust them the
 * same amount, which is the mistake.
 */
export type DeltaKind = "structural" | "duration";

/**
 * How much weight a number carries.
 *
 * - precise: report the figure.
 * - indicative: the movement is inside what one session varies by anyway. Show
 *   a direction, not a percentage.
 * - not-comparable: a duration measured in a different environment. There is no
 *   honest percentage to show at all.
 */
export type DeltaConfidence = "precise" | "indicative" | "not-comparable";

export interface MetricDelta {
  readonly label: string;
  readonly kind: DeltaKind;
  readonly before: number;
  readonly after: number;
  readonly change: number;
  /** null when the baseline was zero, where a percentage means nothing. */
  readonly percentChange: number | null;
  readonly confidence: DeltaConfidence;
}

/** Something about the two runs that makes the numbers less comparable. */
export interface Confounder {
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly message: string;
  /** true when it undermines the comparison entirely rather than qualifying it. */
  readonly severe: boolean;
}

export type Presence = "both" | "only-before" | "only-after";

export interface EndpointDelta {
  readonly path: string;
  readonly presence: Presence;
  readonly calls: MetricDelta;
  readonly duration: MetricDelta;
  readonly transfer: MetricDelta;
  readonly failures: MetricDelta;
  readonly statusBefore: Record<string, number>;
  readonly statusAfter: Record<string, number>;
  /** Ranking keys. Absolute, because a drop of 300 matters as much as a rise. */
  readonly absoluteCallChange: number;
  readonly absoluteDurationChange: number;
}

export interface PageDelta {
  readonly route: string;
  readonly presence: Presence;
  readonly beforeRef: string | null;
  readonly afterRef: string | null;
  readonly requests: MetricDelta;
  readonly transfer: MetricDelta;
  readonly onLoad: MetricDelta;
  readonly firstJsonResponse: MetricDelta;
  readonly lastJsonResponse: MetricDelta;
}

export type FindingStatus = "new" | "resolved" | "persisting";

export interface FindingDelta {
  readonly key: string;
  readonly detectorId: string;
  readonly status: FindingStatus;
  /** false when the detector changed version between the two runs. */
  readonly comparable: boolean;
  readonly before: RunRecordFinding | null;
  readonly after: RunRecordFinding | null;
  readonly severityChanged: boolean;
}

export interface VersionGuards {
  readonly schemaVersionBefore: number;
  readonly schemaVersionAfter: number;
  readonly analyzerVersionBefore: number;
  readonly analyzerVersionAfter: number;
  readonly analyzerVersionMismatch: boolean;
  /** Detectors whose version moved. Their findings are not comparable. */
  readonly detectorVersionMismatches: readonly {
    readonly detectorId: string;
    readonly before: number | null;
    readonly after: number | null;
  }[];
  /**
   * The profiles that labelled each run, and whether they differ.
   *
   * A profile cannot change a measurement, so this never invalidates a count.
   * It does decide what things are called and how they are grouped, so a query
   * rollup or a pool figure may not line up across the two — and an unlabelled
   * run has none of it at all.
   */
  readonly profileBefore: string | null;
  readonly profileAfter: string | null;
  readonly profileMismatch: boolean;
}

/** A comparison that was refused outright, with the reason. */
export interface RefusedComparison {
  readonly outcome: "refused";
  readonly reason: string;
  readonly guards: VersionGuards;
}

export interface RunComparison {
  readonly outcome: "compared";
  readonly guards: VersionGuards;
  /** Rendered above every number, never as a footnote. */
  readonly confounders: readonly Confounder[];
  /**
   * false when the two runs came from different environments. Every duration
   * delta is then marked not-comparable, because a query that ran somewhere
   * else is not a slower or faster version of this one.
   */
  readonly durationsComparable: boolean;
  readonly capture: readonly MetricDelta[];
  /** Ranked by absolute call change, then absolute duration change. */
  readonly endpoints: readonly EndpointDelta[];
  /** The same rows ranked by absolute duration change instead. */
  readonly endpointsByDuration: readonly EndpointDelta[];
  readonly pages: readonly PageDelta[];
  readonly findings: readonly FindingDelta[];
  readonly labels: { readonly before: string; readonly after: string };
}

export type ComparisonResult = RunComparison | RefusedComparison;

import type { Diagnostic } from "../diagnostics.js";

/**
 * Shape of the run record. Bumped when the RECORD SHAPE changes — a field
 * added, removed or renamed — regardless of whether any computation changed.
 *
 * 2: pages gained firstJsonResponseMs and lastJsonResponseMs. Purely additive,
 *    so analyzerVersion stays where it is: no existing value changed meaning,
 *    and a version-1 record remains comparable with a version-2 one on every
 *    field they share.
 * 3: added the workload block and a route on each page. Both exist for
 *    comparison: workload carries the confounders that decide whether two runs
 *    can be compared at all, and route is how journeys are aligned, since page
 *    refs are not stable between captures.
 * 4: concurrency became maxInFlight, split into a network figure and an
 *    all-requests figure, with a per-path table and a call count beside every
 *    maximum. Added poolSaturation. The old single number was dominated by
 *    cache reads and answered nothing anyone asked.
 * 5: added everything a client profile contributes — its identity, the query
 *    rollup, pool figures, business timings and assertion results. All of it is
 *    additive and all of it is absent when no profile was loaded, so a record
 *    made without one is still a complete record.
 */
export const SCHEMA_VERSION = 5;

/**
 * Version of the COMPUTATION as a whole. Bumped when the meaning of the derived
 * numbers changes in a way that spans detectors: the normalised contract, the
 * canonicalisation, the hash.
 *
 * Per-detector versions live alongside this and are finer grained on purpose,
 * so that fixing one detector does not invalidate comparison for every other.
 * A comparison across differing analyzerVersion must be flagged or refused.
 */
export const ANALYZER_VERSION = 1;

/**
 * What a capture cannot tell us, and a person has to.
 *
 * All of these are required. An unlabelled record is worthless in six months:
 * "1946 entries, 7.01 MB" means nothing without knowing whose system it was,
 * which environment, which build, and what the person was doing at the time.
 * The whole point of keeping history is comparison, and you cannot compare two
 * runs you cannot identify.
 */
export interface RunMetadata {
  client: string;
  environment: string;
  build: string;
  /** Optional: an investigation often starts before a ticket exists. */
  ticket: string;
  /** What the person was doing — "log in, open dashboard, filter documents". */
  journey: string;
  /**
   * ISO timestamp for when the record was made. Supplied by the caller rather
   * than read from a clock, because this package is pure and must produce
   * identical output for identical input.
   */
  recordedAt: string;
  notes?: string;
}

/**
 * What the session was doing, as opposed to which system it ran against.
 *
 * These are the confounders. A run against 3 accounts and a run against 400 are
 * not the same measurement however carefully each was taken, and an emulated
 * session does work a real one does not. None of it is derivable from a capture
 * without a client profile, so a person supplies it, and a comparison that
 * cannot see it is a comparison that will quietly mislead.
 */
export interface RunWorkload {
  /** null when unknown rather than 0, which would be a claim. */
  accountCount: number | null;
  /** Whether the session was emulating or impersonating another user. */
  emulated: boolean | null;
  /** The as-at date the data was requested for, if the journey used one. */
  asOfDate: string | null;
}

export interface RunRecordCapture {
  entryCount: number;
  pageCount: number;
  windowMs: number;
  totalTransferBytes: number;
  totalContentBytes: number;
  unpagedEntryCount: number;
  complete: boolean;
  recoveredEntries: number;
  truncatedAtCharOffset: number | null;
  droppedEntries: number;
  reliable: boolean;
  /** Distinct origins seen in the capture, sorted. Derivable; hosts are not payload. */
  hosts: string[];
}

export interface RunRecordFinding {
  detectorId: string;
  detectorVersion: number;
  key: string;
  severity: string;
  summary: string;
  evidence: Record<string, unknown>;
  /**
   * true when the emitter had no evidence allowlist for this detector and
   * therefore copied nothing. Visible rather than silent — see the allowlist
   * note in record/emit.ts.
   */
  evidenceOmitted?: boolean;
}

/**
 * Everything derivable from the capture alone. Built inside the worker, where
 * the bodies are, so that nothing sensitive has to travel to build it later.
 */
/**
 * Which profile labelled this run, if any.
 *
 * Recorded so two runs can be compared knowingly. A profile cannot change a
 * measurement, but it decides what things are called and how they are grouped,
 * and comparing a labelled run against an unlabelled one — or against one
 * labelled differently — is a comparison somebody should be told about.
 */
export interface RunRecordProfile {
  id: string;
  name: string;
  version: number;
  /** Whether the profile's host list matched the capture. */
  matched: boolean;
}

export interface RunRecordCore {
  schemaVersion: number;
  analyzerVersion: number;
  detectorVersions: Record<string, number>;
  /** null when the capture was analysed without a profile. */
  profile: RunRecordProfile | null;
  /** Profile-derived. Empty without one. */
  queries: Record<string, unknown>[];
  pools: Record<string, unknown>[];
  business: Record<string, unknown>;
  assertions: Record<string, unknown>[];
  captureStartedAt: number;
  capture: RunRecordCapture;
  diagnostics: Diagnostic[];
  endpoints: Record<string, unknown>[];
  maxInFlight: Record<string, unknown>;
  poolSaturation: Record<string, unknown>;
  pages: Record<string, unknown>[];
  findings: RunRecordFinding[];
}

export interface RunRecord extends RunRecordCore {
  metadata: RunMetadata;
  workload: RunWorkload;
}

import type { Diagnostic } from "../diagnostics.js";

/**
 * Shape of the run record. Bumped when the RECORD SHAPE changes — a field
 * added, removed or renamed — regardless of whether any computation changed.
 */
export const SCHEMA_VERSION = 1;

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
  ticket: string;
  /** What the person was doing — "log in, open dashboard, filter documents". */
  journey: string;
  /**
   * ISO timestamp for when the record was made. Supplied by the caller rather
   * than read from a clock, because this package is pure and must produce
   * identical output for identical input.
   */
  recordedAt: string;
  /** Not derivable from a capture without a client profile. Optional. */
  accountCount?: number;
  notes?: string;
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
export interface RunRecordCore {
  schemaVersion: number;
  analyzerVersion: number;
  detectorVersions: Record<string, number>;
  captureStartedAt: number;
  capture: RunRecordCapture;
  diagnostics: Diagnostic[];
  endpoints: Record<string, unknown>[];
  concurrency: Record<string, unknown>;
  pages: Record<string, unknown>[];
  findings: RunRecordFinding[];
}

export interface RunRecord extends RunRecordCore {
  metadata: RunMetadata;
}

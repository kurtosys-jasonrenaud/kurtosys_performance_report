import type {
  Diagnostic,
  Finding,
  NormalisedCapture,
  RunRecordCore,
} from "@kurtosys/har-insights";

/**
 * The contract between the worker and the page.
 *
 * WHAT IS ABSENT FROM THIS FILE IS THE POINT.
 *
 * There is no requestBody field, and no url field, anywhere in the outbound
 * types. Not present-and-nulled — absent. A field that does not exist cannot be
 * populated by accident, and TypeScript refuses the mistake at compile time
 * rather than a reviewer having to catch it.
 *
 * The consequence is that bodies and query strings live only for the lifetime
 * of the worker that parsed them. They are never in a React state tree, never
 * in a devtools component snapshot, never in a screenshot of this page, and
 * never in an error report. Anything a person needs to inspect by hand they
 * find in their own copy of the HAR by sourceIndex.
 */

export type Phase = "reading" | "parsing" | "normalising" | "detecting" | "done";

export interface AnalyseRequest {
  kind: "analyse";
  /**
   * The File itself, not its text.
   *
   * A File is structured-cloneable and its underlying data is not copied across
   * the boundary, so the page never holds 67MB as a string. The worker calls
   * file.text() on its own side.
   */
  file: File;
}

export interface PageRow {
  pageRef: string;
  /** Path only, derived from the page title. Never the title itself. */
  route: string;
  requests: number;
  onLoadMs: number | null;
  onContentLoadMs: number | null;
  durationMs: number;
  transferBytes: number;
  startOffsetMs: number;
  endOffsetMs: number;
  /** Proxy for when data fetching began. See the contract for why it is a proxy. */
  firstJsonResponseMs: number | null;
  lastJsonResponseMs: number | null;
}

export interface EndpointRow {
  path: string;
  calls: number;
  totalDurationMs: number;
  unknownDurationCalls: number;
  transferBytes: number;
  contentBytes: number;
  failures: number;
  statusDistribution: Record<string, number>;
  methods: Record<string, number>;
}

export interface ConcurrencyPageRow {
  pageRef: string;
  route: string;
  maxInFlight: number;
  peakAtOffsetMs: number | null;
  consideredEntries: number;
  excludedUnknownDuration: number;
  excludedZeroDuration: number;
}

export interface ConcurrencySummary {
  maxInFlight: number;
  peakAtOffsetMs: number | null;
  peakEntryIndices: number[];
  consideredEntries: number;
  excludedUnknownDuration: number;
  excludedZeroDuration: number;
  perPage: ConcurrencyPageRow[];
}

export interface Timings {
  readMs: number;
  parseMs: number;
  normaliseMs: number;
  detectMs: number;
  recordMs: number;
  totalMs: number;
}

/**
 * Everything the page renders. Note that there is no entry array: the page has
 * no view that needs one, and not sending it keeps the postMessage small on a
 * 67MB capture as well as keeping payloads out of the page entirely.
 */
export interface ReportModel {
  fileName: string;
  fileBytes: number;
  timings: Timings;
  capture: NormalisedCapture;
  diagnostics: Diagnostic[];
  pages: PageRow[];
  endpoints: EndpointRow[];
  concurrency: ConcurrencySummary;
  findings: Finding[];
  detectorVersions: Record<string, number>;
  /** Derived half of the run record. Metadata is added on the page. */
  recordCore: RunRecordCore;
}

export type WorkerMessage =
  | { kind: "progress"; phase: Phase; note: string }
  | { kind: "done"; model: ReportModel }
  | { kind: "error"; message: string };

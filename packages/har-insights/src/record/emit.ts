import { buildRouteLookup } from "../detect/page-route.js";
import type { DetectorRunResult } from "../detect/registry.js";
import type { NormaliseResult } from "../normalise/types.js";
import type {
  RunMetadata,
  RunRecord,
  RunRecordCore,
  RunRecordFinding,
  RunWorkload,
} from "./types.js";
import { ANALYZER_VERSION, SCHEMA_VERSION } from "./types.js";

/**
 * Building the run record — the artefact designed to be stored, transmitted and
 * compared months later.
 *
 * EVERY FIELD HERE IS COPIED BY AN EXPLICIT ALLOWLIST. Not a denylist, not a
 * spread, not Object.assign. This is structural and it is not a style choice:
 *
 *   - With an allowlist, a field added to NormalisedEntry or to a detector's
 *     evidence next year is ABSENT from records until somebody deliberately
 *     adds it here. The safe outcome is the default and forgetting is harmless.
 *   - With a spread, the next person to add a field leaks it silently. Nothing
 *     fails, no test goes red, and the leak ships.
 *
 * What is at stake: NormalisedEntry.url retains query strings and query strings
 * in these captures carry session tokens; requestBody is investor data. Neither
 * appears anywhere below, and the test in record.test.ts proves it by putting a
 * token and an email into a capture and searching the serialised record for
 * them.
 *
 * If you add a field, add it here on purpose, and extend that test.
 */

/**
 * Evidence keys the emitter will copy, per detector.
 *
 * A detector absent from this map contributes NO evidence to the record — its
 * finding is recorded with evidenceOmitted set, which is visible in the output
 * rather than silently empty. That is the allowlist property applied one level
 * down: a new detector cannot leak through evidence just by existing.
 */
const EVIDENCE_ALLOWLIST: Record<string, EvidenceSpec> = {
  "duplicate-payload-within-page": {
    keys: [
      "method",
      "path",
      "pageRoute",
      "pageRef",
      "duplicatedPayloads",
      "totalCalls",
      "redundantCalls",
      "largestGroupCalls",
      "responseClass",
    ],
    arrays: {
      groups: [
        "requestHash",
        "requestBodyKey",
        "callCount",
        "entryIndices",
        "sourceIndexes",
        "durationsMs",
      ],
    },
  },
  "pool-saturation": {
    keys: ["path", "calls", "maxInFlight", "saturationEvents", "withinMs"],
    arrays: {
      events: ["entryIndex", "sourceIndex", "gapMs", "inFlight", "atOffsetMs"],
    },
  },
};

interface EvidenceSpec {
  keys: readonly string[];
  /** Arrays of objects, each copied by its own key allowlist. */
  arrays?: Record<string, readonly string[]>;
}

/** Rollup row fields that may be recorded. Note the absence of anything url-shaped. */
const ENDPOINT_KEYS = [
  "path",
  "calls",
  "totalDurationMs",
  "unknownDurationCalls",
  "transferBytes",
  "contentBytes",
  "failures",
  "statusDistribution",
  "methods",
] as const;

/** Every maximum is recorded with the call count it was drawn from. */
const IN_FLIGHT_SCOPE_KEYS = [
  "maxInFlight",
  "requests",
  "peakAtOffsetMs",
  "peakEntryIndices",
] as const;

const IN_FLIGHT_PATH_KEYS = [
  "path",
  "calls",
  "maxInFlight",
  "networkCalls",
  "cachedCalls",
  "source",
] as const;

const IN_FLIGHT_PAGE_KEYS = [
  "pageRef",
  "route",
  "requests",
  "maxInFlight",
  "maxInFlightNetwork",
  "networkRequests",
  "peakAtOffsetMs",
] as const;

const SATURATION_KEYS = ["totalEvents", "pathsSaturated", "withinMs"] as const;

function pick(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === undefined) return out;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function pickEvidence(finding: {
  detectorId: string;
  evidence: Record<string, unknown>;
}): { evidence: Record<string, unknown>; omitted: boolean } {
  const spec = EVIDENCE_ALLOWLIST[finding.detectorId];
  if (spec === undefined) return { evidence: {}, omitted: true };

  const evidence = pick(finding.evidence, spec.keys);

  for (const [arrayKey, arrayKeys] of Object.entries(spec.arrays ?? {})) {
    const rows = finding.evidence[arrayKey];
    if (!Array.isArray(rows)) continue;
    evidence[arrayKey] = rows.map((row) =>
      pick(row as Record<string, unknown>, arrayKeys),
    );
  }

  return { evidence, omitted: false };
}

/**
 * Distinct origins in the capture, sorted.
 *
 * Hosts are recorded because a run record has to say which system it describes,
 * and a host is infrastructure rather than payload. Credentials were already
 * stripped from origins during normalisation.
 */
function hostsIn(model: NormaliseResult): string[] {
  const hosts = new Set<string>();
  for (const entry of model.entries) {
    if (entry.origin !== "") hosts.add(entry.origin);
  }
  return [...hosts].sort();
}

/**
 * Everything derivable from the capture alone, with no metadata attached.
 *
 * Built where the capture is — inside the worker — so the sensitive parts of
 * the model never have to outlive it just to produce a record later.
 */
export function buildRunRecordCore(
  model: NormaliseResult,
  detectors: DetectorRunResult,
): RunRecordCore {
  const routeOf = buildRouteLookup(model.pages);
  const rollup = detectors.metrics["endpoint-rollup"];
  const inFlight = detectors.metrics["max-in-flight"];
  const saturation = detectors.metrics["pool-saturation"];

  const endpointRows = Array.isArray(rollup?.["endpoints"])
    ? (rollup["endpoints"] as Record<string, unknown>[])
    : [];

  const asRows = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

  const findings: RunRecordFinding[] = detectors.findings.map((finding) => {
    const { evidence, omitted } = pickEvidence(finding);
    const record: RunRecordFinding = {
      detectorId: finding.detectorId,
      detectorVersion: finding.detectorVersion,
      key: finding.key,
      severity: finding.severity,
      summary: finding.summary,
      evidence,
    };
    if (omitted) record.evidenceOmitted = true;
    return record;
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    detectorVersions: { ...detectors.detectorVersions },
    captureStartedAt: model.capture.startedAt,
    capture: {
      entryCount: model.capture.entryCount,
      pageCount: model.capture.pageCount,
      windowMs: model.capture.windowMs,
      totalTransferBytes: model.capture.totalTransferBytes,
      totalContentBytes: model.capture.totalContentBytes,
      unpagedEntryCount: model.capture.unpagedEntryIndices.length,
      complete: model.capture.complete,
      recoveredEntries: model.capture.recoveredEntries,
      truncatedAtCharOffset: model.capture.truncatedAtCharOffset,
      droppedEntries: model.capture.droppedEntries,
      reliable: model.capture.reliable,
      hosts: hostsIn(model),
    },
    diagnostics: model.diagnostics.map((one) => ({ ...one })),
    endpoints: endpointRows.map((row) => pick(row, ENDPOINT_KEYS)),
    maxInFlight: {
      // The transport figure leads. The all-requests figure is kept because it
      // is occasionally the question, never because it is usually the answer.
      network: pick(inFlight?.["network"] as Record<string, unknown>, IN_FLIGHT_SCOPE_KEYS),
      allRequests: pick(
        inFlight?.["allRequests"] as Record<string, unknown>,
        IN_FLIGHT_SCOPE_KEYS,
      ),
      excludedUnknownDuration: inFlight?.["excludedUnknownDuration"] ?? 0,
      excludedZeroDuration: inFlight?.["excludedZeroDuration"] ?? 0,
      byPath: asRows(inFlight?.["byPath"]).map((row) => pick(row, IN_FLIGHT_PATH_KEYS)),
      perPage: asRows(inFlight?.["perPage"]).map((row) => pick(row, IN_FLIGHT_PAGE_KEYS)),
    },
    poolSaturation: pick(saturation, SATURATION_KEYS),
    pages: model.pages.map((page) => ({
      pageRef: page.pageRef,
      // The route, not the title. Journeys are aligned on route because page
      // refs are not stable between captures; the title is the page URL with
      // its query string, which is where a session token lives.
      route: routeOf(page.pageRef),
      startedAt: page.startedAt,
      onContentLoadMs: page.onContentLoadMs,
      onLoadMs: page.onLoadMs,
      entryCount: page.entryCount,
      firstEntryAt: page.firstEntryAt,
      lastEntryEndAt: page.lastEntryEndAt,
      durationMs: page.durationMs,
      transferBytes: page.transferBytes,
      firstJsonResponseMs: page.firstJsonResponseMs,
      lastJsonResponseMs: page.lastJsonResponseMs,
      // page.title is NOT recorded: Chrome writes the page URL there, query
      // string included, which is exactly where a session token lives.
    })),
    findings,
  };
}

export class MissingMetadataError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      "A run record needs " +
        fields.join(", ") +
        ". An unlabelled record cannot be compared against anything later.",
    );
    this.name = "MissingMetadataError";
    this.fields = fields;
  }
}

/**
 * What a record cannot be written without.
 *
 * Ticket is deliberately absent: plenty of investigations start before anyone
 * has raised one, and refusing to record a capture because it has no ticket
 * number loses the capture, which is worse.
 */
const REQUIRED_METADATA = [
  "client",
  "environment",
  "build",
  "journey",
  "recordedAt",
] as const;

/** Attach metadata to a core, refusing to produce an unlabelled record. */
export function finaliseRunRecord(
  core: RunRecordCore,
  metadata: RunMetadata,
  workload: RunWorkload = { accountCount: null, emulated: null, asOfDate: null },
): RunRecord {
  const missing = REQUIRED_METADATA.filter(
    (field) => typeof metadata[field] !== "string" || metadata[field].trim() === "",
  );
  if (missing.length > 0) throw new MissingMetadataError([...missing]);

  const cleaned: RunMetadata = {
    client: metadata.client.trim(),
    environment: metadata.environment.trim(),
    build: metadata.build.trim(),
    ticket: metadata.ticket.trim(),
    journey: metadata.journey.trim(),
    recordedAt: metadata.recordedAt,
  };
  if (typeof metadata.notes === "string" && metadata.notes.trim() !== "") {
    cleaned.notes = metadata.notes.trim();
  }

  return { ...core, metadata: cleaned, workload };
}

/** Convenience for callers holding both halves. */
export function buildRunRecord(
  model: NormaliseResult,
  detectors: DetectorRunResult,
  metadata: RunMetadata,
  workload?: RunWorkload,
): RunRecord {
  return finaliseRunRecord(buildRunRecordCore(model, detectors), metadata, workload);
}

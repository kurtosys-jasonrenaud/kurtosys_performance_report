import type { RunRecord, RunRecordFinding } from "../record/types.js";
import type {
  ComparisonResult,
  Confounder,
  DeltaConfidence,
  EndpointDelta,
  FindingDelta,
  MetricDelta,
  PageDelta,
  Presence,
  VersionGuards,
} from "./types.js";

/**
 * Below this, a duration movement is not worth a number.
 *
 * We have watched one endpoint return 4,163ms and 11,176ms in the same session.
 * A delta smaller than half a second can be one call having a bad moment, and
 * says nothing about the code that issued it.
 */
const MIN_ABSOLUTE_DURATION_MS = 500;

/**
 * The relative spread we have actually measured on a single call.
 *
 * One endpoint returned 4,163ms and 11,176ms in the same session: the larger is
 * 2.7x the smaller, a movement of 168% against the baseline. This constant is
 * that observation, rounded up slightly, rather than a number somebody liked
 * the look of. If we ever measure a wider swing, this is what moves.
 */
const OBSERVED_SINGLE_CALL_SPREAD = 1.7;

/**
 * The floor on relative movement, for endpoints called often enough for the
 * average to settle.
 */
const MIN_RELATIVE_DURATION = 0.3;

/**
 * How much an endpoint's summed duration must move before we report a figure
 * rather than a direction.
 *
 * The rule starts from the spread we have measured on ONE call and tightens as
 * calls accumulate, by 1/sqrt(calls) — the usual rate at which an average
 * settles as samples are added.
 *
 * At one call the threshold is 170%, which is deliberately brutal: a single
 * call tells you nothing about its own variance, and the one pair we have
 * watched moved 168% with no code change between them. At four calls it is 85%,
 * at nine 57%, and from about thirty-two calls it rests on the 30% floor.
 *
 * It is floored rather than continuing to shrink because these calls are not
 * independent samples. They share a database, a cache and a network, so beyond
 * a point more calls stop buying more confidence and a tighter threshold would
 * only be false precision.
 *
 * This governs how precisely we PRESENT a movement. Clearing it is not a claim
 * that the change under test caused anything.
 */
export function durationNoiseThreshold(calls: number): number {
  if (calls <= 0) return OBSERVED_SINGLE_CALL_SPREAD;
  return Math.max(MIN_RELATIVE_DURATION, OBSERVED_SINGLE_CALL_SPREAD / Math.sqrt(calls));
}

function percentChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

function structural(label: string, before: number, after: number): MetricDelta {
  return {
    label,
    kind: "structural",
    before,
    after,
    change: after - before,
    percentChange: percentChange(before, after),
    // Counts, sizes and ceilings follow from the code. They compare cleanly
    // between environments, which is the entire reason for the distinction.
    confidence: "precise",
  };
}

function duration(
  label: string,
  before: number,
  after: number,
  calls: number,
  comparable: boolean,
): MetricDelta {
  const change = after - before;
  return {
    label,
    kind: "duration",
    before,
    after,
    change,
    percentChange: percentChange(before, after),
    confidence: durationConfidence(before, change, calls, comparable),
  };
}

function durationConfidence(
  before: number,
  change: number,
  calls: number,
  comparable: boolean,
): DeltaConfidence {
  if (!comparable) return "not-comparable";
  const magnitude = Math.abs(change);
  if (magnitude < MIN_ABSOLUTE_DURATION_MS) return "indicative";
  if (before === 0) return "precise";
  return magnitude / before >= durationNoiseThreshold(calls) ? "precise" : "indicative";
}

function guardsFor(before: RunRecord, after: RunRecord): VersionGuards {
  const detectorIds = new Set([
    ...Object.keys(before.detectorVersions ?? {}),
    ...Object.keys(after.detectorVersions ?? {}),
  ]);

  const mismatches: VersionGuards["detectorVersionMismatches"] = [...detectorIds]
    .sort()
    .map((detectorId) => ({
      detectorId,
      before: before.detectorVersions?.[detectorId] ?? null,
      after: after.detectorVersions?.[detectorId] ?? null,
    }))
    .filter((row) => row.before !== row.after);

  return {
    schemaVersionBefore: before.schemaVersion,
    schemaVersionAfter: after.schemaVersion,
    analyzerVersionBefore: before.analyzerVersion,
    analyzerVersionAfter: after.analyzerVersion,
    analyzerVersionMismatch: before.analyzerVersion !== after.analyzerVersion,
    detectorVersionMismatches: mismatches,
  };
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "not recorded";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Differences between the two runs that change what the numbers mean.
 *
 * These render above every figure, not beside them. A reader who sees "43%
 * faster" and only later learns the runs were against different environments
 * has already formed the wrong belief.
 */
function confoundersFor(before: RunRecord, after: RunRecord): Confounder[] {
  const found: Confounder[] = [];

  const add = (
    field: string,
    a: unknown,
    b: unknown,
    message: string,
    severe = false,
  ): void => {
    if (describe(a) === describe(b)) return;
    found.push({ field, before: describe(a), after: describe(b), message, severe });
  };

  add(
    "client",
    before.metadata.client,
    after.metadata.client,
    "These runs are from different clients. Almost nothing below is a like-for-like comparison.",
    true,
  );
  add(
    "environment",
    before.metadata.environment,
    after.metadata.environment,
    "Different environments. Request counts and payload sizes still compare, because they follow from the code. Durations do not, and are marked accordingly.",
    true,
  );
  add(
    "accountCount",
    before.workload?.accountCount,
    after.workload?.accountCount,
    "A different number of accounts was in play. Call counts that scale with accounts will move for that reason alone.",
  );
  add(
    "emulated",
    before.workload?.emulated,
    after.workload?.emulated,
    "One run was an emulated session and the other was not. Emulation does work a real session does not.",
  );
  add(
    "asOfDate",
    before.workload?.asOfDate,
    after.workload?.asOfDate,
    "Different as-at dates. The amount of data behind each query differs, so both counts and durations can move without any code change.",
  );

  return found;
}

interface EndpointRow {
  path: string;
  calls: number;
  totalDurationMs: number;
  transferBytes: number;
  failures: number;
  statusDistribution: Record<string, number>;
}

function endpointsOf(record: RunRecord): Map<string, EndpointRow> {
  const rows = new Map<string, EndpointRow>();
  for (const raw of record.endpoints ?? []) {
    const path = typeof raw["path"] === "string" ? raw["path"] : "";
    if (path === "") continue;
    rows.set(path, {
      path,
      calls: Number(raw["calls"] ?? 0),
      totalDurationMs: Number(raw["totalDurationMs"] ?? 0),
      transferBytes: Number(raw["transferBytes"] ?? 0),
      failures: Number(raw["failures"] ?? 0),
      statusDistribution: (raw["statusDistribution"] as Record<string, number>) ?? {},
    });
  }
  return rows;
}

function presenceOf(hasBefore: boolean, hasAfter: boolean): Presence {
  if (hasBefore && hasAfter) return "both";
  return hasBefore ? "only-before" : "only-after";
}

const EMPTY_ENDPOINT: EndpointRow = {
  path: "",
  calls: 0,
  totalDurationMs: 0,
  transferBytes: 0,
  failures: 0,
  statusDistribution: {},
};

function compareEndpoints(
  before: RunRecord,
  after: RunRecord,
  durationsComparable: boolean,
): EndpointDelta[] {
  const beforeRows = endpointsOf(before);
  const afterRows = endpointsOf(after);
  const paths = [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort();

  return paths.map((path) => {
    const a = beforeRows.get(path) ?? EMPTY_ENDPOINT;
    const b = afterRows.get(path) ?? EMPTY_ENDPOINT;
    // The smaller call count governs how steady the duration sum is.
    const calls = Math.max(1, Math.min(a.calls || b.calls, b.calls || a.calls));

    return {
      path,
      presence: presenceOf(beforeRows.has(path), afterRows.has(path)),
      calls: structural("calls", a.calls, b.calls),
      duration: duration(
        "summed duration",
        a.totalDurationMs,
        b.totalDurationMs,
        calls,
        durationsComparable,
      ),
      transfer: structural("transferred", a.transferBytes, b.transferBytes),
      failures: structural("failures", a.failures, b.failures),
      statusBefore: a.statusDistribution,
      statusAfter: b.statusDistribution,
      absoluteCallChange: Math.abs(b.calls - a.calls),
      absoluteDurationChange: Math.abs(b.totalDurationMs - a.totalDurationMs),
    };
  });
}

interface PageRow {
  pageRef: string;
  route: string;
  entryCount: number;
  transferBytes: number;
  onLoadMs: number | null;
  firstJsonResponseMs: number | null;
  lastJsonResponseMs: number | null;
}

function pagesOf(record: RunRecord): PageRow[] {
  return (record.pages ?? []).map((raw) => ({
    pageRef: String(raw["pageRef"] ?? ""),
    // Records written before routes were stored fall back to the ref, which at
    // least keeps them visible rather than silently collapsing into one group.
    route: typeof raw["route"] === "string" ? raw["route"] : String(raw["pageRef"] ?? ""),
    entryCount: Number(raw["entryCount"] ?? 0),
    transferBytes: Number(raw["transferBytes"] ?? 0),
    onLoadMs: raw["onLoadMs"] === null ? null : Number(raw["onLoadMs"] ?? 0),
    firstJsonResponseMs:
      raw["firstJsonResponseMs"] === null ? null : Number(raw["firstJsonResponseMs"] ?? 0),
    lastJsonResponseMs:
      raw["lastJsonResponseMs"] === null ? null : Number(raw["lastJsonResponseMs"] ?? 0),
  }));
}

/**
 * Align journeys on route, never on position.
 *
 * Page refs are assigned by the browser in capture order and mean nothing
 * across two files; page_10 in one run and page_10 in another are not the same
 * step. Journeys also differ in shape — someone visits a page twice, or skips
 * one — so aligning by position quietly compares the dashboard against the
 * documents list and reports the difference as a regression.
 *
 * Where one route occurs several times in both runs, visits are paired in the
 * order they happened WITHIN that route, which is the only ordering available
 * once the route is fixed. Any surplus visit on either side is reported as
 * present in one run only rather than matched to something it is not.
 */
function comparePages(
  before: RunRecord,
  after: RunRecord,
  durationsComparable: boolean,
): PageDelta[] {
  const group = (rows: PageRow[]): Map<string, PageRow[]> => {
    const grouped = new Map<string, PageRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.route);
      if (list === undefined) grouped.set(row.route, [row]);
      else list.push(row);
    }
    return grouped;
  };

  const beforeByRoute = group(pagesOf(before));
  const afterByRoute = group(pagesOf(after));
  const routes = [...new Set([...beforeByRoute.keys(), ...afterByRoute.keys()])].sort();

  const deltas: PageDelta[] = [];

  for (const route of routes) {
    const a = beforeByRoute.get(route) ?? [];
    const b = afterByRoute.get(route) ?? [];
    const visits = Math.max(a.length, b.length);

    for (let visit = 0; visit < visits; visit++) {
      const left = a[visit];
      const right = b[visit];
      const l = left ?? null;
      const r = right ?? null;

      deltas.push({
        route,
        presence: presenceOf(l !== null, r !== null),
        beforeRef: l?.pageRef ?? null,
        afterRef: r?.pageRef ?? null,
        requests: structural("requests", l?.entryCount ?? 0, r?.entryCount ?? 0),
        transfer: structural("transferred", l?.transferBytes ?? 0, r?.transferBytes ?? 0),
        onLoad: duration("onLoad", l?.onLoadMs ?? 0, r?.onLoadMs ?? 0, 1, durationsComparable),
        firstJsonResponse: duration(
          "first JSON",
          l?.firstJsonResponseMs ?? 0,
          r?.firstJsonResponseMs ?? 0,
          1,
          durationsComparable,
        ),
        lastJsonResponse: duration(
          "last JSON",
          l?.lastJsonResponseMs ?? 0,
          r?.lastJsonResponseMs ?? 0,
          1,
          durationsComparable,
        ),
      });
    }
  }

  return deltas;
}

function compareFindings(
  before: RunRecord,
  after: RunRecord,
  guards: VersionGuards,
): FindingDelta[] {
  const incomparable = new Set(
    guards.detectorVersionMismatches.map((row) => row.detectorId),
  );

  const index = (findings: readonly RunRecordFinding[] | undefined) => {
    const map = new Map<string, RunRecordFinding>();
    for (const finding of findings ?? []) map.set(finding.key, finding);
    return map;
  };

  const beforeFindings = index(before.findings);
  const afterFindings = index(after.findings);
  const keys = [...new Set([...beforeFindings.keys(), ...afterFindings.keys()])].sort();

  return keys.map((key) => {
    const a = beforeFindings.get(key) ?? null;
    const b = afterFindings.get(key) ?? null;
    const detectorId = (a ?? b)?.detectorId ?? "";

    return {
      key,
      detectorId,
      status: a === null ? "new" : b === null ? "resolved" : "persisting",
      // A detector that changed version may have changed what it looks for, so
      // a finding appearing or vanishing says as much about us as the system.
      comparable: !incomparable.has(detectorId),
      before: a,
      after: b,
      severityChanged: a !== null && b !== null && a.severity !== b.severity,
    };
  });
}

function captureDeltas(
  before: RunRecord,
  after: RunRecord,
  durationsComparable: boolean,
): MetricDelta[] {
  const a = before.capture;
  const b = after.capture;
  const concurrency = (record: RunRecord): number =>
    Number(record.concurrency?.["maxInFlight"] ?? 0);

  return [
    structural("entries", a.entryCount, b.entryCount),
    structural("pages", a.pageCount, b.pageCount),
    structural("transferred", a.totalTransferBytes, b.totalTransferBytes),
    structural("uncompressed", a.totalContentBytes, b.totalContentBytes),
    structural("unpaged entries", a.unpagedEntryCount, b.unpagedEntryCount),
    // A concurrency ceiling is a property of the code and the pool it uses, not
    // of how fast anything ran, so it compares like a count.
    structural("max in flight", concurrency(before), concurrency(after)),
    duration("capture window", a.windowMs, b.windowMs, 1, durationsComparable),
  ];
}

function labelOf(record: RunRecord): string {
  const meta = record.metadata;
  return [meta.client, meta.environment, meta.build].filter(Boolean).join(" · ");
}

/**
 * Compare two run records.
 *
 * Pure, like everything else here: no clock, no IO. The same pair always
 * produces the same comparison.
 */
export function compareRuns(before: RunRecord, after: RunRecord): ComparisonResult {
  const guards = guardsFor(before, after);

  // Refused outright. Two different record shapes cannot be diffed field by
  // field, and a partial diff across a shape change is how a missing field
  // becomes an apparent improvement.
  if (guards.schemaVersionBefore !== guards.schemaVersionAfter) {
    return {
      outcome: "refused",
      reason:
        "These records have different shapes (schemaVersion " +
        String(guards.schemaVersionBefore) +
        " and " +
        String(guards.schemaVersionAfter) +
        "). A field present in one and absent from the other would read as a" +
        " change in the system rather than a change in the tool, so the" +
        " comparison is refused rather than shown with caveats.",
      guards,
    };
  }

  const confounders = confoundersFor(before, after);
  const durationsComparable = !confounders.some(
    (one) => one.field === "environment" || one.field === "client",
  );

  const endpoints = compareEndpoints(before, after, durationsComparable);

  const byCalls = [...endpoints].sort(
    (a, b) =>
      b.absoluteCallChange - a.absoluteCallChange ||
      b.absoluteDurationChange - a.absoluteDurationChange ||
      (a.path < b.path ? -1 : 1),
  );
  const byDuration = [...endpoints].sort(
    (a, b) =>
      b.absoluteDurationChange - a.absoluteDurationChange ||
      b.absoluteCallChange - a.absoluteCallChange ||
      (a.path < b.path ? -1 : 1),
  );

  return {
    outcome: "compared",
    guards,
    confounders,
    durationsComparable,
    capture: captureDeltas(before, after, durationsComparable),
    endpoints: byCalls,
    endpointsByDuration: byDuration,
    pages: comparePages(before, after, durationsComparable),
    findings: compareFindings(before, after, guards),
    labels: { before: labelOf(before), after: labelOf(after) },
  };
}

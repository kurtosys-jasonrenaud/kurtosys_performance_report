import type { DetectorContext, DetectorResult, DetectorSpec } from "./types.js";

const ID = "endpoint-rollup";
const VERSION = 1;

interface RollupRow {
  path: string;
  calls: number;
  /** Summed durationMs over calls that reported one. See unknownDurationCalls. */
  totalDurationMs: number;
  /** Calls with no reported duration, excluded from totalDurationMs. */
  unknownDurationCalls: number;
  transferBytes: number;
  contentBytes: number;
  failures: number;
  /** Status code to count. Keys are stringified codes; 0 means no response. */
  statusDistribution: Record<string, number>;
  /** Method to count, so a single path used by GET and POST stays legible. */
  methods: Record<string, number>;
}

/**
 * Calls, duration, status spread and bytes, per endpoint path.
 *
 * Metrics only — this produces no findings, and that understates how much it
 * matters. It is the view that makes a regression visible when per-call timings
 * show nothing at all: thirty calls becoming three hundred and twenty-seven is
 * obvious here and invisible in a waterfall, because no individual call got
 * slower. Every later comparison between captures is built on this table.
 */
function run(context: DetectorContext): DetectorResult {
  const rows = new Map<string, RollupRow>();

  // Single sweep over the entries. Everything below is accumulated in the same
  // pass rather than by filtering the entry set once per statistic.
  for (const entry of context.entries) {
    // Grouped by PATH, with the query already stripped during normalisation.
    // Grouping by url instead would give every distinct query string its own
    // row, and a page that calls one endpoint with fifty different parameters
    // would look like fifty endpoints called once each.
    let row = rows.get(entry.path);
    if (row === undefined) {
      row = {
        path: entry.path,
        calls: 0,
        totalDurationMs: 0,
        unknownDurationCalls: 0,
        transferBytes: 0,
        contentBytes: 0,
        failures: 0,
        statusDistribution: {},
        methods: {},
      };
      rows.set(entry.path, row);
    }

    row.calls++;
    if (entry.durationMs === null) row.unknownDurationCalls++;
    else row.totalDurationMs += entry.durationMs;

    row.transferBytes += entry.transferBytes;
    row.contentBytes += entry.contentBytes;
    if (entry.isFailure) row.failures++;

    const status = String(entry.status);
    row.statusDistribution[status] = (row.statusDistribution[status] ?? 0) + 1;
    row.methods[entry.method] = (row.methods[entry.method] ?? 0) + 1;
  }

  const ordered = [...rows.values()]
    .map((row) => ({
      ...row,
      statusDistribution: sortKeys(row.statusDistribution),
      methods: sortKeys(row.methods),
    }))
    // Slowest first, which is the order a person reads this in. Ties break on
    // path so the table is byte identical between runs rather than depending on
    // insertion order.
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs || (a.path < b.path ? -1 : 1));

  return {
    findings: [],
    metrics: {
      endpoints: ordered,
      endpointCount: ordered.length,
      totalCalls: context.capture.entryCount,
    },
  };
}

/**
 * Rebuild an object with its keys in sorted order.
 *
 * JSON.stringify preserves insertion order, so two runs that met the same
 * status codes in a different sequence would serialise differently and a
 * comparison would report a change that did not happen.
 */
function sortKeys(counts: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) {
    const value = counts[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

export const endpointRollup: DetectorSpec = {
  id: ID,
  version: VERSION,
  title: "Endpoint rollup",
  category: "payload",
  run,
};

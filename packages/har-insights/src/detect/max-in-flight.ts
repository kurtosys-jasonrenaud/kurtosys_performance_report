import type { NormalisedEntry } from "../normalise/types.js";
import { buildRouteLookup } from "./page-route.js";
import { sweepInFlight } from "./sweep.js";
import type { DetectorContext, DetectorResult, DetectorSpec } from "./types.js";

const ID = "max-in-flight";
const VERSION = 1;

/**
 * The maximum number of requests observed open at the same time.
 *
 * Named for what it measures. It was called a "concurrency ceiling", which
 * asserts a policy: a ceiling is a limit something is enforcing, and all we can
 * see is how many happened to overlap. Sometimes those are the same number and
 * sometimes they are not, and the name should not decide which.
 *
 * Reported as METRICS, not findings. An observed maximum is a measurement.
 *
 * EVERY MAXIMUM IS REPORTED WITH ITS CALL COUNT, without exception. A maximum
 * of 6 drawn from 21 calls is a ceiling being pressed against; a maximum of 2
 * drawn from 3 calls is just a quiet endpoint. Without the denominator a reader
 * cannot tell those apart, and will read the first number as if it were the
 * second.
 */
function run(context: DetectorContext): DetectorResult {
  const routeOf = buildRouteLookup(context.pages);
  const captureStart = context.capture.startedAt;

  /**
   * The headline figure: requests that actually went to the network.
   *
   * Cache hits are excluded because they are not competing for a connection.
   * Thirty-one stylesheets read out of cache inside one millisecond are
   * arithmetically simultaneous and tell you nothing about transport.
   */
  const networkEntries = context.entries.filter((entry) => entry.transferBytes > 0);
  const network = sweepInFlight(networkEntries);

  /**
   * Every request, cache hits included. Kept because it is occasionally the
   * question, never led with because it usually is not.
   */
  const everything = sweepInFlight(context.entries);

  const byPath = perPath(context.entries);

  const perPage = context.pages.map((page) => {
    const entries: NormalisedEntry[] = [];
    for (const index of page.entryIndices) {
      const entry = context.entries[index];
      if (entry !== undefined) entries.push(entry);
    }
    const all = sweepInFlight(entries);
    const net = sweepInFlight(entries.filter((entry) => entry.transferBytes > 0));
    return {
      pageRef: page.pageRef,
      route: routeOf(page.pageRef),
      requests: entries.length,
      maxInFlight: all.maxInFlight,
      maxInFlightNetwork: net.maxInFlight,
      networkRequests: net.considered,
      peakAtOffsetMs: offset(all.peakAt, captureStart),
    };
  });
  perPage.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

  return {
    findings: [],
    metrics: {
      network: {
        maxInFlight: network.maxInFlight,
        requests: network.considered,
        peakAtOffsetMs: offset(network.peakAt, captureStart),
        peakEntryIndices: network.peakEntryIndices,
      },
      allRequests: {
        maxInFlight: everything.maxInFlight,
        requests: everything.considered,
        peakAtOffsetMs: offset(everything.peakAt, captureStart),
        peakEntryIndices: everything.peakEntryIndices,
      },
      excludedUnknownDuration: everything.excludedUnknownDuration,
      excludedZeroDuration: everything.excludedZeroDuration,
      byPath,
      perPage,
    },
  };
}

function offset(time: number | null, captureStart: number): number | null {
  return time === null ? null : time - captureStart;
}

export interface PathInFlight {
  path: string;
  calls: number;
  maxInFlight: number;
  networkCalls: number;
  cachedCalls: number;
  /** Where the responses came from, across the calls to this path. */
  source: "network" | "cache" | "mixed";
}

/**
 * Maximum in flight for each path separately.
 *
 * This is the generic computation that was missing. A pool limit is only
 * visible among the requests that share the pool, and requests sharing a path
 * are the closest thing to that which can be known without a client profile.
 * No endpoint is named in this code and none needs to be.
 *
 * Paths called once are omitted: their maximum is one by definition and the row
 * says nothing.
 */
function perPath(entries: readonly NormalisedEntry[]): PathInFlight[] {
  const groups = new Map<string, NormalisedEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.path);
    if (group === undefined) groups.set(entry.path, [entry]);
    else group.push(entry);
  }

  const rows: PathInFlight[] = [];
  for (const [path, group] of groups) {
    if (group.length < 2) continue;

    const networkCalls = group.filter((entry) => entry.transferBytes > 0).length;
    const cachedCalls = group.length - networkCalls;

    rows.push({
      path,
      calls: group.length,
      maxInFlight: sweepInFlight(group).maxInFlight,
      networkCalls,
      cachedCalls,
      source: cachedCalls === 0 ? "network" : networkCalls === 0 ? "cache" : "mixed",
    });
  }

  // Busiest overlap first, then most called, then by path so the order is
  // identical on every run.
  rows.sort(
    (a, b) =>
      b.maxInFlight - a.maxInFlight ||
      b.calls - a.calls ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return rows;
}

export const maxInFlight: DetectorSpec = {
  id: ID,
  version: VERSION,
  title: "Maximum observed in flight",
  category: "concurrency",
  run,
};

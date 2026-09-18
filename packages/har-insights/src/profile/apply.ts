import type { DetectorRunResult } from "../detect/registry.js";
import { sweepInFlight } from "../detect/sweep.js";
import { canonicaliseBody } from "../normalise/canonicalise.js";
import { fnv1a64 } from "../normalise/hash.js";
import type { NormalisedEntry, NormaliseResult } from "../normalise/types.js";
import { evaluateAssertions } from "./assertions.js";
import type {
  BusinessTiming,
  EndpointProfile,
  FieldSource,
  PageBusinessTiming,
  PoolInFlightRow,
  Profile,
  ProfileOverlay,
  QueryRollupRow,
} from "./types.js";

/**
 * Longest query identifier we will keep.
 *
 * A profile points queryId at a field and we cannot tell an identifier from an
 * address. A cap is not a sanitiser, but it stops a whole payload arriving in a
 * rollup because somebody aimed the path one level too high.
 */
const MAX_QUERY_ID_LENGTH = 120;

function readPath(body: string | null, source: FieldSource | undefined): string | null {
  if (body === null || source === undefined || source.from !== "requestBody") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  let current: unknown = parsed;
  for (const segment of source.path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === null || current === undefined) return null;
  if (typeof current === "object") {
    // A subtree, not a scalar. Useful for inputs; hashed rather than quoted.
    return fnv1a64(canonicaliseBody(JSON.stringify(current)));
  }
  return String(current).slice(0, MAX_QUERY_ID_LENGTH);
}

/**
 * Apply a profile to a finished analysis.
 *
 * Reads the model and the detector output. Writes neither. What comes back
 * contains only things a profile adds — labels, groupings, derived timings and
 * assertion results. There is nowhere in the return type for a changed call
 * count or duration to live, which is how the rule is kept: not by remembering
 * it, but by there being no channel for the mistake.
 */
export function applyProfile(
  model: NormaliseResult,
  detectors: DetectorRunResult,
  profile: Profile,
): ProfileOverlay {
  const endpoints = profile.endpoints ?? {};
  const hostsInCapture = [...new Set(model.entries.map((entry) => entry.origin))]
    .filter((origin) => origin !== "")
    .sort();

  const { matched, matchWarning } = checkHosts(profile, hostsInCapture);

  const queries = buildQueryRollup(model.entries, endpoints, profile.queryLabels ?? {});
  const pools = buildPools(model.entries, endpoints, model.capture.startedAt);
  const { business, businessByPage } = businessTimings(model, endpoints, profile.routes ?? {});

  const assertions = evaluateAssertions(profile, {
    model,
    detectors,
    endpoints,
    queries,
    pools,
  });

  return {
    profileId: profile.id,
    profileName: profile.name,
    profileVersion: profile.version,
    matched,
    matchWarning,
    hostsInCapture,
    endpointLabels: endpoints,
    queries,
    pools,
    business,
    businessByPage,
    assertions,
  };
}

/**
 * Self-check: does this profile look like it belongs to this capture?
 *
 * A profile silently applied to the wrong capture produces labels that are
 * confidently wrong, which is worse than no labels. Matching on host is cheap
 * and catches the common mistake.
 */
function checkHosts(
  profile: Profile,
  hostsInCapture: string[],
): { matched: boolean; matchWarning: string | null } {
  const wanted = profile.match?.hosts ?? [];
  if (wanted.length === 0) {
    return {
      matched: false,
      matchWarning:
        "This profile declares no hosts, so we cannot check that it belongs to this capture.",
    };
  }

  const hostNames = hostsInCapture.map((origin) => origin.replace(/^https?:\/\//, ""));
  const hit = wanted.some((host) =>
    hostNames.some((seen) => seen === host || seen.startsWith(host + ":")),
  );

  if (hit) return { matched: true, matchWarning: null };

  return {
    matched: false,
    matchWarning:
      "This profile is for " +
      wanted.join(", ") +
      ", and this capture is of " +
      (hostNames.slice(0, 4).join(", ") || "nothing recognisable") +
      ". Labels below may be wrong. Nothing measured has been changed.",
  };
}

interface QueryAccumulator {
  path: string;
  queryId: string;
  runs: NormalisedEntry[];
  /** (queryId, inputs) key to the pages it occurred on. */
  byInputs: Map<string, string[]>;
}

function buildQueryRollup(
  entries: readonly NormalisedEntry[],
  endpoints: Record<string, EndpointProfile>,
  labels: Record<string, string>,
): QueryRollupRow[] {
  const accumulators = new Map<string, QueryAccumulator>();

  for (const entry of entries) {
    const config = endpoints[entry.path];
    if (config?.queryId === undefined) continue;

    const queryId = readPath(entry.requestBody, config.queryId);
    if (queryId === null) continue;

    const key = entry.path + "|" + queryId;
    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = { path: entry.path, queryId, runs: [], byInputs: new Map() };
      accumulators.set(key, accumulator);
    }
    accumulator.runs.push(entry);

    // Duplicate identity at query level: the same query with the same inputs.
    // Falls back to the whole canonical body when the profile does not say
    // where the inputs live.
    const inputs =
      config.queryInputs === undefined
        ? (entry.requestBodyKey ?? "")
        : (readPath(entry.requestBody, config.queryInputs) ?? "");
    const inputsKey = queryId + "|" + inputs;
    const pages = accumulator.byInputs.get(inputsKey);
    const page = entry.pageRef ?? "(no page)";
    if (pages === undefined) accumulator.byInputs.set(inputsKey, [page]);
    else pages.push(page);
  }

  const rows: QueryRollupRow[] = [];
  for (const accumulator of accumulators.values()) {
    let totalDurationMs = 0;
    let unknownDurationRuns = 0;
    const statusDistribution: Record<string, number> = {};

    for (const run of accumulator.runs) {
      if (run.durationMs === null) unknownDurationRuns++;
      else totalDurationMs += run.durationMs;
      const status = String(run.status);
      statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
    }

    let intraPageRepeats = 0;
    let sessionWideRepeats = 0;
    for (const pages of accumulator.byInputs.values()) {
      if (pages.length > 1) sessionWideRepeats++;
      if (new Set(pages).size < pages.length) intraPageRepeats++;
    }

    rows.push({
      path: accumulator.path,
      queryId: accumulator.queryId,
      label: labels[accumulator.queryId] ?? accumulator.queryId,
      runs: accumulator.runs.length,
      durationsMs: accumulator.runs.map((run) => run.durationMs),
      totalDurationMs,
      unknownDurationRuns,
      entryIndices: accumulator.runs.map((run) => run.index),
      sourceIndexes: accumulator.runs.map((run) => run.sourceIndex),
      statusDistribution: sortKeys(statusDistribution),
      distinctInputs: accumulator.byInputs.size,
      intraPageRepeats,
      sessionWideRepeats,
    });
  }

  // Slowest first, then by id so the order is identical on every run.
  rows.sort(
    (a, b) =>
      b.totalDurationMs - a.totalDurationMs ||
      (a.queryId < b.queryId ? -1 : a.queryId > b.queryId ? 1 : 0),
  );
  return rows;
}

/**
 * Maximum in flight per declared pool.
 *
 * This is scoping, not changing. The unscoped figure and the network-only
 * figure are still reported by the detector exactly as before; this adds a
 * third view that needed knowledge the capture does not carry — which endpoints
 * share a dispatcher.
 */
function buildPools(
  entries: readonly NormalisedEntry[],
  endpoints: Record<string, EndpointProfile>,
  captureStartedAt: number,
): PoolInFlightRow[] {
  const pools = new Map<string, { paths: Set<string>; entries: NormalisedEntry[] }>();

  for (const entry of entries) {
    const pool = endpoints[entry.path]?.pool;
    if (pool === undefined) continue;
    let bucket = pools.get(pool);
    if (bucket === undefined) {
      bucket = { paths: new Set(), entries: [] };
      pools.set(pool, bucket);
    }
    bucket.paths.add(entry.path);
    bucket.entries.push(entry);
  }

  const rows: PoolInFlightRow[] = [];
  for (const [pool, bucket] of pools) {
    const swept = sweepInFlight(bucket.entries);
    rows.push({
      pool,
      paths: [...bucket.paths].sort(),
      calls: bucket.entries.length,
      maxInFlight: swept.maxInFlight,
      peakAtOffsetMs: swept.peakAt === null ? null : swept.peakAt - captureStartedAt,
      peakEntryIndices: swept.peakEntryIndices,
    });
  }

  rows.sort((a, b) => b.maxInFlight - a.maxInFlight || (a.pool < b.pool ? -1 : 1));
  return rows;
}

/**
 * When business work started and finished, per page and for the capture.
 *
 * NEW FIELDS. firstJsonResponseMs and lastJsonResponseMs are untouched and keep
 * their meaning: they are the generic proxy, computed with no profile, and any
 * record ever written with them stays readable. These sit beside them and are
 * better, because a profile can say which endpoint actually carries the data.
 */
function businessTimings(
  model: NormaliseResult,
  endpoints: Record<string, EndpointProfile>,
  routes: Record<string, string>,
): { business: BusinessTiming; businessByPage: PageBusinessTiming[] } {
  const isBusiness = (entry: NormalisedEntry): boolean =>
    endpoints[entry.path]?.class === "business";

  const captureStart = model.capture.startedAt;
  let captureFirst: number | null = null;
  let captureLast: number | null = null;

  for (const entry of model.entries) {
    if (!isBusiness(entry)) continue;
    if (captureFirst === null || entry.startedAt < captureFirst) captureFirst = entry.startedAt;
    const end = entry.endedAt ?? entry.startedAt;
    if (captureLast === null || end > captureLast) captureLast = end;
  }

  const pages: PageBusinessTiming[] = model.pages.map((page) => {
    const origin = page.startedAt ?? page.firstEntryAt;
    let first: number | null = null;
    let last: number | null = null;

    for (const index of page.entryIndices) {
      const entry = model.entries[index];
      if (entry === undefined || !isBusiness(entry)) continue;
      if (first === null || entry.startedAt < first) first = entry.startedAt;
      const end = entry.endedAt ?? entry.startedAt;
      if (last === null || end > last) last = end;
    }

    // Route label comes from the page's route, which normalisation derived from
    // the title's path. The profile only renames it.
    const route = routeOfPage(page.title, page.pageRef);
    return {
      pageRef: page.pageRef,
      route,
      routeLabel: routes[route] ?? route,
      firstBusinessRequestMs: first === null ? null : first - origin,
      lastBusinessResponseMs: last === null ? null : last - origin,
    };
  });

  return {
    business: {
      firstBusinessRequestMs: captureFirst === null ? null : captureFirst - captureStart,
      lastBusinessResponseMs: captureLast === null ? null : captureLast - captureStart,
    },
    businessByPage: pages,
  };
}

/** Same rule normalisation uses: the title's path, never the title itself. */
function routeOfPage(title: string, pageRef: string): string {
  if (title === "" || !title.includes("://")) return pageRef;
  const afterScheme = title.indexOf("://") + 3;
  let end = title.length;
  for (let i = afterScheme; i < title.length; i++) {
    const c = title.charCodeAt(i);
    if (c === 0x2f || c === 0x3f || c === 0x23) {
      end = i;
      break;
    }
  }
  let pathEnd = title.length;
  for (let i = end; i < title.length; i++) {
    const c = title.charCodeAt(i);
    if (c === 0x3f || c === 0x23) {
      pathEnd = i;
      break;
    }
  }
  const path = title.slice(end, pathEnd);
  return path === "" ? pageRef : path;
}

function sortKeys(counts: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) {
    const value = counts[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

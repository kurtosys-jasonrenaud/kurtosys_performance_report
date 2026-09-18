/**
 * Client profiles.
 *
 * THE ONE RULE: a profile may LABEL and SCOPE a measurement. It may never
 * CHANGE one.
 *
 * It can give an endpoint a name, group endpoints into a dispatch pool, pull a
 * query identifier out of a request body, and add derived fields. It cannot
 * alter a call count, a duration, a rollup, or any field that already exists.
 * A profile that can change a number is a profile that can lie, and the only
 * reason anyone trusts this tool is that its numbers are not negotiable.
 *
 * That rule is enforced by shape rather than by discipline. applyProfile takes
 * the finished, frozen analysis and returns a ProfileOverlay — a type with no
 * rollup, no findings and no capture totals on it. There is no field on the
 * return value through which a changed measurement could travel, so the mistake
 * cannot be made by accident, only by rewriting this module on purpose.
 *
 * Profiles are user-supplied files loaded at run time. None ships in this
 * repository: endpoint paths, dataset codes and route names are commercially
 * sensitive, and this repository is public.
 */

/** Where a value is pulled from, and by what path. */
export interface FieldSource {
  from: "requestBody";
  /** Dotted path into the parsed JSON body, e.g. "code" or "query.id". */
  path: string;
}

export interface EndpointProfile {
  /** Human name for this endpoint. Labelling only. */
  label?: string;
  /**
   * What the endpoint is for. "business" is the only value with behaviour
   * attached — it drives firstBusinessRequestMs and lastBusinessResponseMs.
   */
  class?: string;
  /**
   * Endpoints sharing a pool name are swept together for maximum in flight.
   * This is scoping, not changing: the unscoped and network-only figures are
   * still reported exactly as they were.
   */
  pool?: string;
  /**
   * Where to find the query identifier in the request body.
   *
   * The highest-value field in a profile. It turns twenty-one anonymous POSTs
   * to one path into named queries with individual durations, which is most of
   * what made the manual analysis worth doing.
   *
   * The profile author chooses which field this points at, and is responsible
   * for pointing it at an identifier rather than at payload. Extracted values
   * are length-capped, but nothing here can tell an id from an email address.
   */
  queryId?: FieldSource;
  /**
   * Where to find the query's inputs, so duplicate detection can key on
   * (queryId, inputs) rather than the whole body. Falls back to the whole
   * canonicalised body when absent.
   */
  queryInputs?: FieldSource;
}

export type AssertionExpectation = "none" | "any";

/** Asserts something about what a detector found. */
export interface DetectorAssertion {
  id: string;
  description?: string;
  detector: string;
  /**
   * Narrows which findings count. One of:
   *   "json" / "data"     — findings whose responseClass is data
   *   "pool:<name>"       — findings on a path belonging to that pool
   *   "path:<prefix>"     — findings whose path starts with the prefix
   *   "class:<name>"      — findings on a path with that class
   * Omitted means every finding from that detector.
   */
  scope?: string;
  expect: AssertionExpectation;
}

export type MetricName =
  | "maxInFlight"
  | "maxContentBytes"
  | "maxTransferBytes"
  | "queryRuns"
  | "distinctQueries"
  | "calls";

/** Asserts something about a measured number. */
export interface MetricAssertion {
  id: string;
  description?: string;
  metric: MetricName;
  pool?: string;
  path?: string;
  class?: string;
  queryId?: string;
  /** A comparison: "> 3", "<= 262144", "== 5". */
  expect: string;
}

export type Assertion = DetectorAssertion | MetricAssertion;

export function isMetricAssertion(assertion: Assertion): assertion is MetricAssertion {
  return typeof (assertion as MetricAssertion).metric === "string";
}

export interface Profile {
  id: string;
  name: string;
  /** Bumped by the profile's author. Recorded, and compared across runs. */
  version: number;
  match: { hosts: string[] };
  endpoints?: Record<string, EndpointProfile>;
  /** Friendly names for query identifiers. Labelling only. */
  queryLabels?: Record<string, string>;
  /** Friendly names for routes. Labelling only. */
  routes?: Record<string, string>;
  assertions?: Assertion[];
}

export interface QueryRollupRow {
  path: string;
  queryId: string;
  /** From queryLabels, or the id itself when unlabelled. */
  label: string;
  runs: number;
  durationsMs: (number | null)[];
  totalDurationMs: number;
  /** Runs whose duration was not reported, excluded from the total. */
  unknownDurationRuns: number;
  entryIndices: number[];
  sourceIndexes: number[];
  statusDistribution: Record<string, number>;
  /** Distinct (queryId, inputs) combinations seen. */
  distinctInputs: number;
  /** How often one (queryId, inputs) recurred within a single page. */
  intraPageRepeats: number;
  /** How often one (queryId, inputs) recurred anywhere in the capture. */
  sessionWideRepeats: number;
}

export interface PoolInFlightRow {
  pool: string;
  paths: string[];
  calls: number;
  maxInFlight: number;
  peakAtOffsetMs: number | null;
  peakEntryIndices: number[];
}

export interface BusinessTiming {
  /** Page start to the first request to a business endpoint. */
  firstBusinessRequestMs: number | null;
  /** Page start to the last business response completing. */
  lastBusinessResponseMs: number | null;
}

export interface PageBusinessTiming extends BusinessTiming {
  pageRef: string;
  route: string;
  /** From the profile's routes map, or the route itself. */
  routeLabel: string;
}

export interface AssertionResult {
  id: string;
  description: string;
  kind: "detector" | "metric";
  /** What was asked for, in words. */
  expectation: string;
  /** What was measured, in words. */
  observed: string;
  passed: boolean;
  /**
   * false when the assertion could not be evaluated at all — a pool nobody
   * declared, a query never run. Neither a pass nor a failure, and reported as
   * such rather than quietly counted as one.
   */
  evaluated: boolean;
  note: string | null;
}

/**
 * Everything a profile adds. Note what is NOT here: no endpoints rollup, no
 * findings, no capture totals. Those come from detection and a profile cannot
 * reach them.
 */
export interface ProfileOverlay {
  profileId: string;
  profileName: string;
  profileVersion: number;
  /** true when a host in the capture matched the profile's host list. */
  matched: boolean;
  /** Set when the profile does not appear to apply to this capture. */
  matchWarning: string | null;
  hostsInCapture: string[];
  /** Per path: whatever the profile chose to say about it. */
  endpointLabels: Record<string, EndpointProfile>;
  queries: QueryRollupRow[];
  pools: PoolInFlightRow[];
  /**
   * Named for what it is. It was briefly called "capture", which read like
   * capture totals — exactly the thing a profile is not allowed to produce.
   */
  business: BusinessTiming;
  businessByPage: PageBusinessTiming[];
  assertions: AssertionResult[];
}

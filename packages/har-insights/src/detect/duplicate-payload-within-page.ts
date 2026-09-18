import { fnv1a64 } from "../normalise/hash.js";
import { buildRouteLookup } from "./page-route.js";
import type {
  DetectorContext,
  DetectorResult,
  DetectorSpec,
  Finding,
  FindingSeverity,
} from "./types.js";

const ID = "duplicate-payload-within-page";
const VERSION = 2;

/**
 * Separator for composite map keys. A vertical bar cannot appear in an HTTP
 * method or in a hex hash, and any bar inside a url is percent-encoded, so no
 * two different tuples can collide on it.
 */
const SEP = "|";

/**
 * What kind of response the repeated request produced.
 *
 * An asset fetched twice on a page is usually harmless — a bundler quirk, a
 * preload that did not take. An API call issued six times is work the system
 * did not need to do. Presenting both in one list buries the second under the
 * first, so the class travels with the finding and the two are reported apart.
 *
 * Taken from the response mime type, which is in every capture and needs no
 * client profile to interpret.
 */
export type ResponseClass = "data" | "asset" | "other";

function classifyResponse(mimeType: string): ResponseClass {
  const type = mimeType.toLowerCase();
  if (type.includes("json")) return "data";
  if (
    type.includes("javascript") ||
    type.includes("ecmascript") ||
    type.includes("css") ||
    type.startsWith("image/") ||
    type.startsWith("font/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type.includes("woff") ||
    type.includes("font")
  ) {
    return "asset";
  }
  return "other";
}

interface PayloadGroup {
  /** Hash of url plus body key. Identifies the group without quoting either. */
  requestHash: string;
  requestBodyKey: string | null;
  entryIndices: number[];
  sourceIndexes: number[];
  durationsMs: (number | null)[];
  mimeTypes: string[];
}

interface EndpointGroup {
  pageRef: string | null;
  route: string;
  method: string;
  path: string;
  payloads: Map<string, PayloadGroup>;
}

/**
 * Identical requests repeated within a single page.
 *
 * GETs are included: for a GET the URL is the payload, so two identical GETs to
 * the same URL within a page are as duplicated as two identical POST bodies.
 *
 * Entries that declared no page are grouped together under "(no page)" rather
 * than skipped. A real capture had 18 unpaged entries spanning nearly five
 * minutes, and duplicates among them are still duplicates.
 */
function run(context: DetectorContext): DetectorResult {
  const routeOf = buildRouteLookup(context.pages);
  const endpoints = new Map<string, EndpointGroup>();

  // One sweep. Entries are grouped by the endpoint they hit within a page, and
  // within that by the exact request, so both levels are built together rather
  // than by filtering the entry set twice.
  for (const entry of context.entries) {
    const endpointKey = (entry.pageRef ?? "") + SEP + entry.method + SEP + entry.path;

    let endpoint = endpoints.get(endpointKey);
    if (endpoint === undefined) {
      endpoint = {
        pageRef: entry.pageRef,
        route: routeOf(entry.pageRef),
        method: entry.method,
        path: entry.path,
        payloads: new Map<string, PayloadGroup>(),
      };
      endpoints.set(endpointKey, endpoint);
    }

    // The full url participates in identity — a different query string is a
    // different request — but only ever as a hash. The url itself carries the
    // session token and never reaches a finding.
    const requestHash = fnv1a64(entry.url + SEP + (entry.requestBodyKey ?? ""));

    const payload = endpoint.payloads.get(requestHash);
    if (payload === undefined) {
      endpoint.payloads.set(requestHash, {
        requestHash,
        requestBodyKey: entry.requestBodyKey,
        entryIndices: [entry.index],
        sourceIndexes: [entry.sourceIndex],
        durationsMs: [entry.durationMs],
        mimeTypes: [entry.mimeType],
      });
    } else {
      payload.entryIndices.push(entry.index);
      payload.sourceIndexes.push(entry.sourceIndex);
      payload.durationsMs.push(entry.durationMs);
      payload.mimeTypes.push(entry.mimeType);
    }
  }

  const findings: Finding[] = [];

  for (const endpoint of endpoints.values()) {
    const repeated = [...endpoint.payloads.values()]
      .filter((payload) => payload.entryIndices.length > 1)
      // Sorted by hash so evidence order is identical on every run.
      .sort((a, b) => (a.requestHash < b.requestHash ? -1 : 1));

    if (repeated.length === 0) continue;

    let totalCalls = 0;
    let largestGroup = 0;
    for (const payload of repeated) {
      totalCalls += payload.entryIndices.length;
      if (payload.entryIndices.length > largestGroup) {
        largestGroup = payload.entryIndices.length;
      }
    }

    const responseClass = dominantClass(repeated);

    findings.push({
      detectorId: ID,
      detectorVersion: VERSION,
      key: buildKey(endpoint),
      severity: severityFor(largestGroup, responseClass),
      summary: summarise(endpoint, repeated, largestGroup),
      evidence: {
        method: endpoint.method,
        path: endpoint.path,
        responseClass,
        pageRoute: endpoint.route,
        pageRef: endpoint.pageRef,
        duplicatedPayloads: repeated.length,
        totalCalls,
        // Calls beyond the first of each distinct payload.
        redundantCalls: totalCalls - repeated.length,
        largestGroupCalls: largestGroup,
        groups: repeated.map((payload) => ({
          requestHash: payload.requestHash,
          requestBodyKey: payload.requestBodyKey,
          callCount: payload.entryIndices.length,
          entryIndices: payload.entryIndices,
          sourceIndexes: payload.sourceIndexes,
          durationsMs: payload.durationsMs,
        })),
      },
    });
  }

  // Byte-identical output requires a defined order, not whatever order the Map
  // happened to iterate in.
  findings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { findings };
}

/**
 * The key identifies the endpoint on the page, not the payloads found there.
 *
 * Payload hashes are deliberately absent. A body containing an as-at date
 * changes hash on every capture, and a key built from one would report the same
 * standing problem as newly appeared on every run.
 */
function buildKey(endpoint: EndpointGroup): string {
  return ID + ":" + endpoint.method + ":" + endpoint.path + ":" + endpoint.route;
}

/**
 * The class of the responses this endpoint returned, across every repeated
 * payload on it. Data wins a tie: an endpoint that answers in JSON some of the
 * time is an API call some of the time.
 */
function dominantClass(repeated: PayloadGroup[]): ResponseClass {
  const counts: Record<ResponseClass, number> = { data: 0, asset: 0, other: 0 };
  for (const payload of repeated) {
    for (const mimeType of payload.mimeTypes) counts[classifyResponse(mimeType)]++;
  }
  if (counts.data > 0 && counts.data >= counts.asset && counts.data >= counts.other) {
    return "data";
  }
  return counts.asset >= counts.other ? "asset" : "other";
}

/**
 * Severity from the repeat count for data, held at low for everything else.
 *
 * A stylesheet fetched six times is odd; six identical API calls is work that
 * did not need doing. The count is still in the evidence either way, so nothing
 * is hidden — only ranked.
 */
function severityFor(calls: number, responseClass: ResponseClass): FindingSeverity {
  if (responseClass !== "data") return "low";
  if (calls >= 6) return "high";
  if (calls >= 3) return "medium";
  return "low";
}

/** States what was counted. No cause, no remedy. */
function summarise(
  endpoint: EndpointGroup,
  repeated: PayloadGroup[],
  largestGroup: number,
): string {
  const where = endpoint.method + " " + endpoint.path + " within " + endpoint.route;

  if (repeated.length === 1) {
    return "Identical request payload issued " + String(largestGroup) + " times to " + where;
  }

  const counts = repeated
    .map((payload) => payload.entryIndices.length)
    .sort((a, b) => b - a)
    .join(", ");

  return (
    String(repeated.length) +
    " distinct request payloads each issued more than once to " +
    where +
    " (" +
    counts +
    " calls)"
  );
}

export const duplicatePayloadWithinPage: DetectorSpec = {
  id: ID,
  version: VERSION,
  title: "Duplicate request payload within a page",
  category: "redundancy",
  run,
};

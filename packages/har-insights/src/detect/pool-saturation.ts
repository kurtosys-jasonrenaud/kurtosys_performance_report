import type { NormalisedEntry } from "../normalise/types.js";
import { findSaturationEvents } from "./sweep.js";
import type {
  DetectorContext,
  DetectorResult,
  DetectorSpec,
  Finding,
  FindingSeverity,
} from "./types.js";

const ID = "pool-saturation";
const VERSION = 1;

/**
 * How close a start must follow a completion to count as taking the freed slot.
 *
 * Two milliseconds. HAR records sub-millisecond precision, and the real case we
 * know of — one request starting as another returned — had a gap of 0.155ms,
 * which reads as the same millisecond in any waterfall. A window this tight
 * cannot be met by coincidence at these volumes; widen it and ordinary traffic
 * starts qualifying.
 */
const WITHIN_MS = 2;

/**
 * Requests that began the instant another on the same path completed, while
 * that path was already at its observed maximum.
 *
 * Why this exists: a maximum on its own is a statistic. Six requests happened to
 * overlap, and that may be all there is to it. But a maximum that is reached
 * again and again, each time as soon as a slot frees, is a different kind of
 * fact — something is handing work out in batches of that size. This detector
 * turns "the maximum was 6" into "the maximum was 6 and it was pressed against
 * N times", which is the difference between a number and evidence.
 *
 * It reports the pattern. It does not say what is enforcing the limit — a
 * connection pool, a dispatcher, a semaphore in the application, or the browser
 * itself — because the capture cannot tell us that.
 */
function run(context: DetectorContext): DetectorResult {
  const byPath = new Map<string, NormalisedEntry[]>();
  for (const entry of context.entries) {
    const group = byPath.get(entry.path);
    if (group === undefined) byPath.set(entry.path, [entry]);
    else group.push(entry);
  }

  const findings: Finding[] = [];
  let totalEvents = 0;
  let pathsSaturated = 0;

  for (const [path, entries] of byPath) {
    if (entries.length < 2) continue;

    const { events, maxInFlight } = findSaturationEvents(
      entries,
      context.capture.startedAt,
      WITHIN_MS,
    );
    if (events.length === 0) continue;

    totalEvents += events.length;
    pathsSaturated++;

    findings.push({
      detectorId: ID,
      detectorVersion: VERSION,
      // The subject is the path. No counts or durations in the key: those move
      // every capture and would make a standing pattern look newly discovered
      // on every run.
      key: ID + ":" + path,
      severity: severityFor(events.length),
      summary: summarise(path, events.length, maxInFlight, entries.length),
      evidence: {
        path,
        calls: entries.length,
        maxInFlight,
        saturationEvents: events.length,
        withinMs: WITHIN_MS,
        events: events.map((event) => ({
          entryIndex: event.startedIndex,
          sourceIndex: event.startedSourceIndex,
          gapMs: event.gapMs,
          inFlight: event.inFlight,
          atOffsetMs: event.atMs,
        })),
      },
    });
  }

  findings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    findings,
    metrics: { totalEvents, pathsSaturated, withinMs: WITHIN_MS },
  };
}

/**
 * Severity tracks how repeatedly the limit was met, not how bad it is.
 *
 * One event can be coincidence. A dozen is a pattern.
 */
function severityFor(events: number): FindingSeverity {
  if (events >= 10) return "high";
  if (events >= 3) return "medium";
  return "low";
}

/** States what was counted. No cause, no remedy. */
function summarise(
  path: string,
  events: number,
  maxInFlight: number,
  calls: number,
): string {
  return (
    "On " +
    path +
    ", a request began within " +
    String(WITHIN_MS) +
    "ms of another completing " +
    String(events) +
    (events === 1 ? " time" : " times") +
    " while " +
    String(maxInFlight) +
    " were in flight, across " +
    String(calls) +
    " calls"
  );
}

export const poolSaturation: DetectorSpec = {
  id: ID,
  version: VERSION,
  title: "Requests starting as slots free",
  category: "concurrency",
  run,
};

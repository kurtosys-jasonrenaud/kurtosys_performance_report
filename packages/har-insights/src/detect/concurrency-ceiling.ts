import type { NormalisedEntry } from "../normalise/types.js";
import { buildRouteLookup } from "./page-route.js";
import type { DetectorContext, DetectorResult, DetectorSpec } from "./types.js";

const ID = "concurrency-ceiling";
const VERSION = 2;

/**
 * Event kinds, ordered so that the numeric comparison in the sort IS the
 * tie-break rule: an end at time T is processed before a start at time T.
 */
const END = 0;
const START = 1;

interface SweepEvent {
  time: number;
  kind: typeof END | typeof START;
  index: number;
}

interface Sweep {
  maxInFlight: number;
  peakAt: number | null;
  peakEntryIndices: number[];
  considered: number;
  excluded: number;
  zeroDuration: number;
}

/**
 * The observed maximum number of requests in flight at once.
 *
 * Reported as METRICS, not findings. An observed ceiling is a measurement, not
 * a problem: six in flight is a browser doing exactly what it should. It only
 * becomes a finding when compared against an expectation, and expectations are
 * client-specific and live in profiles.
 */
function run(context: DetectorContext): DetectorResult {
  const routeOf = buildRouteLookup(context.pages);

  const global = sweep(context.entries);

  const perPage = context.pages.map((page) => {
    const pageEntries: NormalisedEntry[] = [];
    for (const index of page.entryIndices) {
      const entry = context.entries[index];
      if (entry !== undefined) pageEntries.push(entry);
    }
    const result = sweep(pageEntries);
    return {
      pageRef: page.pageRef,
      route: routeOf(page.pageRef),
      maxInFlight: result.maxInFlight,
      peakAtOffsetMs: offsetOf(result.peakAt, context.capture.startedAt),
      peakEntryIndices: result.peakEntryIndices,
      consideredEntries: result.considered,
      excludedUnknownDuration: result.excluded,
      excludedZeroDuration: result.zeroDuration,
    };
  });

  // Pages arrive in capture order; sorting by route keeps the metric byte
  // identical between runs even if a future change reorders pages.
  perPage.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

  return {
    findings: [],
    metrics: {
      maxInFlight: global.maxInFlight,
      peakAtOffsetMs: offsetOf(global.peakAt, context.capture.startedAt),
      peakEntryIndices: global.peakEntryIndices,
      consideredEntries: global.considered,
      /**
       * Entries with an unknown duration have no real end time. Including them
       * would mean inventing one, so they sit out of the sweep entirely and the
       * count is reported so the ceiling can be read as "observed across N of M
       * requests" rather than as the whole picture.
       */
      excludedUnknownDuration: global.excluded,
      /**
       * Requests that started and finished within the same millisecond, almost
       * always cache hits. They occupy no interval and are counted here rather
       * than swept, so the ceiling describes requests that were actually
       * outstanding.
       */
      excludedZeroDuration: global.zeroDuration,
      perPage,
    },
  };
}

function offsetOf(time: number | null, captureStart: number): number | null {
  return time === null ? null : time - captureStart;
}

/**
 * Sweep start and end events to find the observed maximum in flight.
 *
 * THE TIE-BREAK IS THE WHOLE TRICK. When one request ends at the exact
 * millisecond another starts, the end must be processed first. This is not a
 * theoretical nicety: in a real capture a request started on the exact
 * millisecond another returned, because the connection pool was full at six and
 * a slot had just freed. Processing the start first reads that as seven
 * concurrent, and the real ceiling — the number the pool is actually enforcing
 * — becomes invisible, which is the one number the sweep exists to find.
 */
function sweep(entries: readonly NormalisedEntry[]): Sweep {
  const events: SweepEvent[] = [];
  let excluded = 0;
  let considered = 0;
  let zeroDuration = 0;

  for (const entry of entries) {
    if (entry.endedAt === null) {
      excluded++;
      continue;
    }

    // A request that starts and ends on the same millisecond occupies no
    // interval, and must not be given events at all.
    //
    // This is not tidiness, it is a leak. Ends are processed before starts at
    // the same instant — see the note above, it is what makes the pool-slot
    // case come out right — so a zero-duration entry would have its end
    // processed BEFORE its own start, removing an index that was not yet
    // present and then adding one that is never removed. It would sit in the
    // in-flight set for the rest of the capture, inflating every later peak by
    // one. Ten cached responses in one millisecond would add ten to the
    // ceiling, permanently, and the number would look plausible.
    if (entry.endedAt === entry.startedAt) {
      zeroDuration++;
      continue;
    }

    considered++;
    events.push({ time: entry.startedAt, kind: START, index: entry.index });
    events.push({ time: entry.endedAt, kind: END, index: entry.index });
  }

  // Ends sort before starts at the same instant because END is 0 and START is
  // 1. The final comparison on index only exists to make the order total, so
  // the sort is deterministic rather than merely correct.
  events.sort((a, b) => a.time - b.time || a.kind - b.kind || a.index - b.index);

  const inFlight = new Set<number>();
  let maxInFlight = 0;
  let peakAt: number | null = null;
  let peakEntryIndices: number[] = [];

  for (const event of events) {
    if (event.kind === START) {
      inFlight.add(event.index);
      if (inFlight.size > maxInFlight) {
        maxInFlight = inFlight.size;
        peakAt = event.time;
        // Snapshot at the first moment the peak is reached. Sorted so the
        // evidence does not depend on Set insertion order.
        peakEntryIndices = [...inFlight].sort((a, b) => a - b);
      }
    } else {
      inFlight.delete(event.index);
    }
  }

  return { maxInFlight, peakAt, peakEntryIndices, considered, excluded, zeroDuration };
}

export const concurrencyCeiling: DetectorSpec = {
  id: ID,
  version: VERSION,
  title: "Observed concurrency ceiling",
  category: "concurrency",
  run,
};

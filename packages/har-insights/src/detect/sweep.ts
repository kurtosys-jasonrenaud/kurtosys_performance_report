import type { NormalisedEntry } from "../normalise/types.js";

/**
 * Sweeping start and end events to see how many requests were open at once.
 *
 * Shared by the detectors that measure in-flight behaviour, so the tie-break
 * rule lives in exactly one place.
 */

/**
 * Event kinds, ordered so the numeric comparison in the sort IS the tie-break:
 * an end at time T is processed before a start at time T.
 *
 * THIS IS THE WHOLE TRICK. When one request ends on the exact millisecond
 * another starts, the end goes first. Otherwise a freed slot being immediately
 * reused reads as one more request in flight than there ever was, and the limit
 * the pool is enforcing becomes invisible — which is the one thing the sweep
 * exists to find.
 */
const END = 0;
const START = 1;

interface SweepEvent {
  time: number;
  kind: typeof END | typeof START;
  index: number;
}

export interface SweepResult {
  /** The largest number observed open at the same moment. */
  maxInFlight: number;
  /** Epoch ms at which that peak was first reached, or null if nothing swept. */
  peakAt: number | null;
  peakEntryIndices: number[];
  /** How many requests the figure is drawn from. A max without this is a rumour. */
  considered: number;
  /** Excluded for having no reported duration. */
  excludedUnknownDuration: number;
  /** Excluded for starting and finishing inside the same millisecond. */
  excludedZeroDuration: number;
}

/**
 * A moment at which a request started just as another on the same path
 * finished, with the path already at its observed maximum.
 */
export interface SaturationEvent {
  /** The request that started. */
  startedIndex: number;
  startedSourceIndex: number;
  /** Milliseconds between the previous completion and this start. */
  gapMs: number;
  /** How many were in flight once this one started. */
  inFlight: number;
  /** Offset of the start from the beginning of the capture. */
  atMs: number;
}

export function sweepInFlight(entries: readonly NormalisedEntry[]): SweepResult {
  const { events, considered, excludedUnknownDuration, excludedZeroDuration } =
    eventsFor(entries);

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
        peakEntryIndices = [...inFlight].sort((a, b) => a - b);
      }
    } else {
      inFlight.delete(event.index);
    }
  }

  return {
    maxInFlight,
    peakAt,
    peakEntryIndices,
    considered,
    excludedUnknownDuration,
    excludedZeroDuration,
  };
}

/**
 * Find the moments a slot freed and was taken again immediately, while the path
 * was already at its observed maximum.
 *
 * A maximum on its own is a statistic: six requests happened to overlap. A
 * maximum that keeps being reached the instant a slot frees is evidence of
 * something enforcing a limit — a pool, a queue, a dispatcher — because that
 * pattern does not arise by coincidence.
 *
 * @param withinMs how close a start must follow a completion to count.
 */
export function findSaturationEvents(
  entries: readonly NormalisedEntry[],
  captureStartedAt: number,
  withinMs: number,
): { events: SaturationEvent[]; maxInFlight: number } {
  const { events: timeline } = eventsFor(entries);

  // First pass for the maximum, because saturation is defined relative to it.
  const maxInFlight = sweepInFlight(entries).maxInFlight;
  const found: SaturationEvent[] = [];
  if (maxInFlight < 2) return { events: found, maxInFlight };

  let inFlight = 0;
  let lastEndAt: number | null = null;
  const byIndex = new Map<number, NormalisedEntry>();
  for (const entry of entries) byIndex.set(entry.index, entry);

  for (const event of timeline) {
    if (event.kind === END) {
      inFlight--;
      // Ends are processed before starts at the same instant, so a start at
      // exactly this time sees a gap of zero, which is the case we care most
      // about.
      lastEndAt = event.time;
      continue;
    }

    inFlight++;
    if (inFlight !== maxInFlight || lastEndAt === null) continue;

    const gapMs = event.time - lastEndAt;
    if (gapMs < 0 || gapMs > withinMs) continue;

    const entry = byIndex.get(event.index);
    found.push({
      startedIndex: event.index,
      startedSourceIndex: entry?.sourceIndex ?? -1,
      gapMs,
      inFlight,
      atMs: event.time - captureStartedAt,
    });
  }

  return { events: found, maxInFlight };
}

function eventsFor(entries: readonly NormalisedEntry[]): {
  events: SweepEvent[];
  considered: number;
  excludedUnknownDuration: number;
  excludedZeroDuration: number;
} {
  const events: SweepEvent[] = [];
  let considered = 0;
  let excludedUnknownDuration = 0;
  let excludedZeroDuration = 0;

  for (const entry of entries) {
    if (entry.endedAt === null) {
      excludedUnknownDuration++;
      continue;
    }
    // A request that starts and ends on the same millisecond occupies no
    // interval. Giving it events would also leak it permanently into the
    // in-flight set, because its end would be processed before its own start.
    if (entry.endedAt === entry.startedAt) {
      excludedZeroDuration++;
      continue;
    }
    considered++;
    events.push({ time: entry.startedAt, kind: START, index: entry.index });
    events.push({ time: entry.endedAt, kind: END, index: entry.index });
  }

  events.sort((a, b) => a.time - b.time || a.kind - b.kind || a.index - b.index);
  return { events, considered, excludedUnknownDuration, excludedZeroDuration };
}

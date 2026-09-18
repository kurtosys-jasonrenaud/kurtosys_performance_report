import type { Diagnostic } from "../diagnostics.js";
import { diagnostic } from "../diagnostics.js";
import type { RawHarEntry, RawHarHeader, RawHarPage } from "../parse/har-types.js";
import type { HarParseResult } from "../parse/parse-har.js";
import { keyRequestBody } from "./canonicalise.js";
import { fnv1a64 } from "./hash.js";
import type {
  NormalisedCapture,
  NormalisedEntry,
  NormalisedPage,
  NormaliseResult,
} from "./types.js";
import { splitUrl } from "./url.js";

/**
 * Entries are built mutable and frozen on the way out. Nothing outside this
 * module ever sees the mutable form.
 */
type Draft<T> = { -readonly [K in keyof T]: T[K] };

/** Above this share of dropped entries, capture totals stop being trustworthy. */
const UNRELIABLE_DROP_RATIO = 0.01;

/**
 * Components (wait, blocked) floor to 0 when unreported. See the JSDoc on
 * NormalisedEntry.waitMs for why this differs from durationMs.
 */
function componentMs(value: number | undefined): { value: number; reported: boolean } {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { value: 0, reported: false };
  }
  return { value, reported: true };
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Durations and page timings keep null for "unknown" rather than collapsing to
 * zero, because zero is a claim about what happened.
 */
function optionalTiming(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function text(value: string | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Parse startedDateTime to epoch milliseconds.
 *
 * Date.parse handles the ISO 8601 offset, which is why the string is never
 * sliced: a capture taken in New York and one taken in London are comparable
 * only if the offset is honoured.
 */
function epochMs(value: string | undefined): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One pass over the response headers, pulling out both values we need. */
function readResponseHeaders(headers: RawHarHeader[] | undefined): {
  cacheControl: string | null;
  etag: string | null;
} {
  let cacheControl: string | null = null;
  let etag: string | null = null;
  if (!Array.isArray(headers)) return { cacheControl, etag };

  for (const header of headers) {
    const name = header?.name;
    if (typeof name !== "string") continue;
    const lower = name.toLowerCase();
    if (cacheControl === null && lower === "cache-control") {
      cacheControl = typeof header.value === "string" ? header.value : null;
    } else if (etag === null && lower === "etag") {
      etag = typeof header.value === "string" ? header.value : null;
    }
  }
  return { cacheControl, etag };
}

/** Counters accumulated while reading entries, used to raise diagnostics. */
interface Tally {
  undated: number;
  unknownDuration: number;
  unreportedTimings: number;
  nonJsonBody: number;
}

function normaliseEntry(
  raw: RawHarEntry,
  startedAt: number,
  sourceIndex: number,
  tally: Tally,
): Draft<NormalisedEntry> {
  const request = raw.request;
  const response = raw.response;
  const timings = raw.timings;

  const url = text(request?.url, "");
  const { origin, path } = splitUrl(url);

  const durationMs = optionalTiming(raw.time);
  if (durationMs === null) tally.unknownDuration++;

  const wait = componentMs(timings?.wait);
  const blocked = componentMs(timings?.blocked);
  if (!wait.reported || !blocked.reported) tally.unreportedTimings++;

  const body = typeof request?.postData?.text === "string" ? request.postData.text : null;
  const bodyKey = keyRequestBody(body);
  if (body !== null && !bodyKey.fromJson) tally.nonJsonBody++;

  const responseText = response?.content?.text;
  const { cacheControl, etag } = readResponseHeaders(response?.headers);

  const status = typeof response?.status === "number" ? response.status : 0;
  const error = typeof response?._error === "string" ? response._error : null;

  // The specification spells it pageref; some tools emit pageRef. Accept both,
  // and treat an empty string as no page rather than a page named "".
  const rawPageRef = raw.pageref ?? raw.pageRef;
  const pageRef = typeof rawPageRef === "string" && rawPageRef !== "" ? rawPageRef : null;

  return {
    index: -1,
    sourceIndex,
    pageRef,
    startedAt,
    offsetMs: 0,
    endedAt: durationMs === null ? null : startedAt + durationMs,
    durationMs,
    waitMs: wait.value,
    blockedMs: blocked.value,
    method: text(request?.method, ""),
    url,
    origin,
    path,
    status,
    requestBody: body,
    requestBodyKey: bodyKey.key,
    responseBodyHash: typeof responseText === "string" ? fnv1a64(responseText) : null,
    transferBytes: nonNegative(response?._transferSize),
    contentBytes: nonNegative(response?.content?.size),
    mimeType: text(response?.content?.mimeType, ""),
    cacheControl,
    etag,
    protocol: text(response?.httpVersion, text(request?.httpVersion, "")),
    error,
    isFailure: status === 0 || error !== null,
  };
}

/**
 * Turn a parse result into the normalised model every detector reads.
 *
 * Pure: no IO, no clock, no randomness. The same parse result always produces
 * the same model, which is what lets a run record be trusted months later.
 *
 * The returned structure is frozen. Entry indices are positions in the sorted
 * array and are referenced by every finding, so a consumer re-sorting the array
 * in place would invalidate stored evidence without anything failing.
 */
export function normaliseHar(parsed: HarParseResult): NormaliseResult {
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const tally: Tally = {
    undated: 0,
    unknownDuration: 0,
    unreportedTimings: 0,
    nonJsonBody: 0,
  };

  // Pass one: build entries, dropping any we cannot place in time. sourceIndex
  // is the position in the file's array, so it keeps counting past the drops.
  const entries: Draft<NormalisedEntry>[] = [];
  for (let sourceIndex = 0; sourceIndex < parsed.entries.length; sourceIndex++) {
    const raw = parsed.entries[sourceIndex];
    if (raw === undefined) continue;
    const startedAt = epochMs(raw.startedDateTime);
    if (startedAt === null) {
      tally.undated++;
      continue;
    }
    entries.push(normaliseEntry(raw, startedAt, sourceIndex, tally));
  }

  // Order by start time. Exporters do not guarantee file order, and offsetMs,
  // concurrency sweeps and every index in every piece of evidence depend on
  // this ordering being the real one. Array.prototype.sort is stable, so
  // entries sharing a start time keep the order the file gave them.
  entries.sort((a, b) => a.startedAt - b.startedAt);

  // Pass two: assign positions and accumulate every capture-wide total at once,
  // rather than filtering the entry set repeatedly per statistic.
  const first = entries[0];
  const captureStart = first === undefined ? 0 : first.startedAt;
  let captureEnd = captureStart;
  let totalTransferBytes = 0;
  let totalContentBytes = 0;
  const entriesByPage = new Map<string, number[]>();
  const unpagedEntryIndices: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;

    entry.index = i;
    entry.offsetMs = entry.startedAt - captureStart;

    // An entry whose duration is unknown contributes only its start, so the
    // window stays a lower bound rather than being padded with a guess.
    const end = entry.endedAt ?? entry.startedAt;
    if (end > captureEnd) captureEnd = end;

    totalTransferBytes += entry.transferBytes;
    totalContentBytes += entry.contentBytes;

    if (entry.pageRef === null) {
      unpagedEntryIndices.push(i);
    } else {
      const group = entriesByPage.get(entry.pageRef);
      if (group === undefined) entriesByPage.set(entry.pageRef, [i]);
      else group.push(i);
    }
  }

  const frozenEntries = entries.map((entry) => Object.freeze(entry as NormalisedEntry));
  const pages = buildPages(parsed.pages, frozenEntries, entriesByPage, diagnostics);

  addTallyDiagnostics(diagnostics, tally, parsed.entries.length, entries.length);

  const attempted = parsed.entries.length;
  const reliable =
    attempted === 0 || tally.undated / attempted <= UNRELIABLE_DROP_RATIO;

  const capture: NormalisedCapture = Object.freeze({
    entryCount: entries.length,
    pageCount: pages.length,
    startedAt: entries.length === 0 ? 0 : captureStart,
    endedAt: entries.length === 0 ? 0 : captureEnd,
    windowMs: entries.length === 0 ? 0 : captureEnd - captureStart,
    totalTransferBytes,
    totalContentBytes,
    unpagedEntryIndices: Object.freeze(unpagedEntryIndices),
    complete: parsed.complete,
    recoveredEntries: parsed.recoveredEntries,
    truncatedAtCharOffset: parsed.truncatedAtCharOffset,
    droppedEntries: tally.undated,
    reliable,
  });

  return Object.freeze({
    entries: Object.freeze(frozenEntries),
    pages: Object.freeze(pages),
    capture,
    diagnostics: Object.freeze(diagnostics),
  });
}

function addTallyDiagnostics(
  diagnostics: Diagnostic[],
  tally: Tally,
  attempted: number,
  kept: number,
): void {
  if (tally.undated > 0) {
    const ratio = attempted === 0 ? 0 : tally.undated / attempted;
    const unreliable = ratio > UNRELIABLE_DROP_RATIO;
    diagnostics.push(
      diagnostic(
        "entry-missing-timestamp",
        unreliable ? "error" : "warning",
        "Dropped " +
          String(tally.undated) +
          (tally.undated === 1 ? " entry that had" : " entries that had") +
          " no usable startedDateTime. An entry with no start time cannot be" +
          " ordered, offset or swept for concurrency, so it is excluded rather" +
          " than given a false timestamp." +
          (unreliable
            ? " That is more than 1% of the capture, so capture-wide totals are" +
              " incomplete and must not be presented as whole."
            : ""),
        tally.undated,
        { dropped: tally.undated, attempted, kept, ratio },
      ),
    );
  }

  if (tally.unknownDuration > 0) {
    diagnostics.push(
      diagnostic(
        "entry-missing-duration",
        "warning",
        String(tally.unknownDuration) +
          (tally.unknownDuration === 1 ? " entry reports" : " entries report") +
          " no duration. They are excluded from duration sums and from the" +
          " concurrency sweep rather than treated as instantaneous, so both are" +
          " computed over fewer entries than the capture contains.",
        tally.unknownDuration,
        { entries: tally.unknownDuration },
      ),
    );
  }

  if (tally.unreportedTimings > 0) {
    diagnostics.push(
      diagnostic(
        "unreported-timings",
        "warning",
        String(tally.unreportedTimings) +
          (tally.unreportedTimings === 1 ? " entry has" : " entries have") +
          " an unreported wait or blocked timing, recorded as 0. Any sum of" +
          " those timings is therefore a LOWER BOUND, not a total, and should" +
          " be presented as such.",
        tally.unreportedTimings,
        { entries: tally.unreportedTimings },
      ),
    );
  }

  if (tally.nonJsonBody > 0) {
    diagnostics.push(
      diagnostic(
        "non-json-request-body",
        "warning",
        String(tally.nonJsonBody) +
          (tally.nonJsonBody === 1 ? " request body is" : " request bodies are") +
          " not JSON (form-encoded, multipart or plain text). Those bodies" +
          " cannot be canonicalised by key order, so their keys match only" +
          " byte-identical bodies and duplicate detection may UNDER-REPORT for" +
          " them. A quiet 'no duplicates' over such entries is not evidence" +
          " that there were none.",
        tally.nonJsonBody,
        { entries: tally.nonJsonBody },
      ),
    );
  }
}

function buildPages(
  rawPages: RawHarPage[],
  entries: readonly NormalisedEntry[],
  entriesByPage: Map<string, number[]>,
  diagnostics: Diagnostic[],
): NormalisedPage[] {
  const pages: NormalisedPage[] = [];
  const seen = new Set<string>();
  let duplicateIds = 0;

  for (const rawPage of rawPages) {
    const pageRef = rawPage?.id;
    if (typeof pageRef !== "string" || pageRef === "") continue;
    if (seen.has(pageRef)) {
      duplicateIds++;
      continue;
    }
    seen.add(pageRef);

    const startedAt = epochMs(rawPage.startedDateTime);
    const indices = entriesByPage.get(pageRef) ?? [];

    // Indices are already in time order, so the window starts at the first
    // entry. The end is the latest end among them, which is not necessarily the
    // last entry's: a long request started early can outlast everything after
    // it.
    let firstEntryAt = startedAt ?? 0;
    let lastEntryEndAt = firstEntryAt;
    let transferBytes = 0;
    let firstJsonAt: number | null = null;
    let lastJsonEndAt: number | null = null;

    if (indices.length > 0) {
      const firstIndex = indices[0];
      const firstEntry = firstIndex === undefined ? undefined : entries[firstIndex];
      firstEntryAt = firstEntry === undefined ? firstEntryAt : firstEntry.startedAt;
      lastEntryEndAt = firstEntryAt;
      for (const index of indices) {
        const entry = entries[index];
        if (entry === undefined) continue;
        const end = entry.endedAt ?? entry.startedAt;
        if (end > lastEntryEndAt) lastEntryEndAt = end;
        transferBytes += entry.transferBytes;

        // A JSON response is a proxy for a data call. It is only a proxy —
        // config and auth answer in JSON too — which is why the fields are
        // named after the measurement rather than after what we hope it means.
        if (entry.mimeType.toLowerCase().includes("json")) {
          if (firstJsonAt === null || entry.startedAt < firstJsonAt) {
            firstJsonAt = entry.startedAt;
          }
          if (lastJsonEndAt === null || end > lastJsonEndAt) lastJsonEndAt = end;
        }
      }
    }

    // Measured from the page's own start where the browser reported one, so
    // these sit on the same baseline as onLoadMs. A page record with no usable
    // startedDateTime falls back to its first entry.
    const pageOrigin = startedAt ?? firstEntryAt;

    pages.push(
      Object.freeze({
        pageRef,
        title: text(rawPage.title, ""),
        startedAt,
        onContentLoadMs: optionalTiming(rawPage.pageTimings?.onContentLoad),
        onLoadMs: optionalTiming(rawPage.pageTimings?.onLoad),
        entryCount: indices.length,
        entryIndices: Object.freeze(indices),
        firstEntryAt,
        lastEntryEndAt,
        durationMs: lastEntryEndAt - firstEntryAt,
        transferBytes,
        firstJsonResponseMs: firstJsonAt === null ? null : firstJsonAt - pageOrigin,
        lastJsonResponseMs: lastJsonEndAt === null ? null : lastJsonEndAt - pageOrigin,
      }),
    );
  }

  if (duplicateIds > 0) {
    diagnostics.push(
      diagnostic(
        "duplicate-page-id",
        "warning",
        "Ignored " +
          String(duplicateIds) +
          " page " +
          (duplicateIds === 1 ? "record" : "records") +
          " that reused an id already seen. The first record for an id wins.",
        duplicateIds,
        { duplicates: duplicateIds },
      ),
    );
  }

  // An entry can name a page that is not in the pages array — it happens in
  // truncated captures and in exports that drop pages entirely. The entry keeps
  // its pageRef, because it still groups that entry with its siblings, but the
  // mismatch is reported so nobody reads a missing page as no traffic.
  let unresolvedRefs = 0;
  let unresolvedEntries = 0;
  for (const [pageRef, indices] of entriesByPage) {
    if (seen.has(pageRef)) continue;
    unresolvedRefs++;
    unresolvedEntries += indices.length;
  }
  if (unresolvedRefs > 0) {
    diagnostics.push(
      diagnostic(
        "unresolved-page-ref",
        "warning",
        String(unresolvedEntries) +
          (unresolvedEntries === 1 ? " entry names" : " entries name") +
          " a page that the capture does not describe (" +
          String(unresolvedRefs) +
          (unresolvedRefs === 1 ? " reference" : " references") +
          "). They are still grouped by that reference.",
        unresolvedEntries,
        { entries: unresolvedEntries, references: unresolvedRefs },
      ),
    );
  }

  return pages;
}

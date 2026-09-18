import type { Diagnostic } from "../diagnostics.js";
import { diagnostic } from "../diagnostics.js";
import type {
  RawHarEntry,
  RawHarHeader,
  RawHarPage,
} from "../parse/har-types.js";
import type { HarParseResult } from "../parse/parse-har.js";
import { requestBodyKey } from "./canonicalise.js";
import { fnv1a64 } from "./hash.js";
import type {
  NormalisedCapture,
  NormalisedEntry,
  NormalisedPage,
  NormaliseResult,
} from "./types.js";
import { splitUrl } from "./url.js";

/** HAR uses -1 for "not measured". Durations are summed, so -1 becomes 0. */
function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Page timings keep their -1 as null instead of collapsing to 0. Unlike
 * durations these are never summed, and "the browser did not report onLoad" is
 * a different statement from "onLoad happened at zero milliseconds".
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
 * sliced: a capture taken in New York and one taken in London are directly
 * comparable only if the offset is honoured.
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

/**
 * Turn one raw entry into a normalised one, leaving index and offsetMs unset —
 * both depend on the capture's ordering, which is not known until every entry
 * has been read.
 */
function normaliseEntry(raw: RawHarEntry, startedAt: number): NormalisedEntry {
  const request = raw.request;
  const response = raw.response;
  const timings = raw.timings;

  const url = text(request?.url, "");
  const { origin, path } = splitUrl(url);

  const durationMs = nonNegative(raw.time);
  const body = typeof request?.postData?.text === "string" ? request.postData.text : null;
  const responseText = response?.content?.text;
  const { cacheControl, etag } = readResponseHeaders(response?.headers);

  const status = typeof response?.status === "number" ? response.status : 0;
  const error = typeof response?._error === "string" ? response._error : null;

  // The specification spells it pageref; some tools emit pageRef. Accept both,
  // and treat an empty string as no page rather than as a page named "".
  const rawPageRef = raw.pageref ?? raw.pageRef;
  const pageRef =
    typeof rawPageRef === "string" && rawPageRef !== "" ? rawPageRef : null;

  return {
    index: -1,
    pageRef,
    startedAt,
    offsetMs: 0,
    endedAt: startedAt + durationMs,
    durationMs,
    waitMs: nonNegative(timings?.wait),
    blockedMs: nonNegative(timings?.blocked),
    method: text(request?.method, ""),
    url,
    origin,
    path,
    status,
    requestBody: body,
    requestBodyKey: requestBodyKey(body),
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
 */
export function normaliseHar(parsed: HarParseResult): NormaliseResult {
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];

  // Pass one: build entries, dropping any we cannot place in time.
  const entries: NormalisedEntry[] = [];
  let undated = 0;
  for (const raw of parsed.entries) {
    const startedAt = epochMs(raw.startedDateTime);
    if (startedAt === null) {
      undated++;
      continue;
    }
    entries.push(normaliseEntry(raw, startedAt));
  }
  if (undated > 0) {
    diagnostics.push(
      diagnostic(
        "entry-missing-timestamp",
        "Dropped " +
          String(undated) +
          (undated === 1 ? " entry that had" : " entries that had") +
          " no usable startedDateTime. An entry with no start time cannot be" +
          " ordered, offset or swept for concurrency, so it is excluded rather" +
          " than given a false timestamp.",
        undated,
      ),
    );
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

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;

    entry.index = i;
    entry.offsetMs = entry.startedAt - captureStart;

    if (entry.endedAt > captureEnd) captureEnd = entry.endedAt;
    totalTransferBytes += entry.transferBytes;
    totalContentBytes += entry.contentBytes;

    if (entry.pageRef !== null) {
      const group = entriesByPage.get(entry.pageRef);
      if (group === undefined) entriesByPage.set(entry.pageRef, [i]);
      else group.push(i);
    }
  }

  const pages = buildPages(parsed.pages, entries, entriesByPage, diagnostics);

  const capture: NormalisedCapture = {
    entryCount: entries.length,
    pageCount: pages.length,
    startedAt: entries.length === 0 ? 0 : captureStart,
    endedAt: entries.length === 0 ? 0 : captureEnd,
    windowMs: entries.length === 0 ? 0 : captureEnd - captureStart,
    totalTransferBytes,
    totalContentBytes,
    complete: parsed.complete,
    recoveredEntries: parsed.recoveredEntries,
    truncatedAt: parsed.truncatedAt,
  };

  return { entries, pages, capture, diagnostics };
}

function buildPages(
  rawPages: RawHarPage[],
  entries: NormalisedEntry[],
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

    // Indices are already in time order, so the window is the first entry's
    // start and the latest end among them. The latest end is not necessarily
    // the last entry's end: a long request started early can outlast everything
    // after it.
    let firstEntryAt = startedAt ?? 0;
    let lastEntryEndAt = firstEntryAt;
    let transferBytes = 0;

    if (indices.length > 0) {
      const firstIndex = indices[0];
      const firstEntry = firstIndex === undefined ? undefined : entries[firstIndex];
      firstEntryAt = firstEntry === undefined ? firstEntryAt : firstEntry.startedAt;
      lastEntryEndAt = firstEntryAt;
      for (const index of indices) {
        const entry = entries[index];
        if (entry === undefined) continue;
        if (entry.endedAt > lastEntryEndAt) lastEntryEndAt = entry.endedAt;
        transferBytes += entry.transferBytes;
      }
    }

    pages.push({
      pageRef,
      title: text(rawPage.title, ""),
      startedAt,
      onContentLoadMs: optionalTiming(rawPage.pageTimings?.onContentLoad),
      onLoadMs: optionalTiming(rawPage.pageTimings?.onLoad),
      entryCount: indices.length,
      entryIndices: indices,
      firstEntryAt,
      lastEntryEndAt,
      durationMs: lastEntryEndAt - firstEntryAt,
      transferBytes,
    });
  }

  if (duplicateIds > 0) {
    diagnostics.push(
      diagnostic(
        "duplicate-page-id",
        "Ignored " +
          String(duplicateIds) +
          " page " +
          (duplicateIds === 1 ? "record" : "records") +
          " that reused an id already seen. The first record for an id wins.",
        duplicateIds,
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
        String(unresolvedEntries) +
          (unresolvedEntries === 1 ? " entry names" : " entries name") +
          " a page that the capture does not describe (" +
          String(unresolvedRefs) +
          (unresolvedRefs === 1 ? " reference" : " references") +
          "). They are still grouped by that reference.",
        unresolvedEntries,
      ),
    );
  }

  return pages;
}

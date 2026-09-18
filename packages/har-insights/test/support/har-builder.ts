/**
 * Synthetic HAR fixtures, built in code.
 *
 * Deliberately NOT in test/fixtures/, which is gitignored and reserved for real
 * captures handed over for local validation. Everything a committed test reads
 * must be constructed here, so that no capture is ever needed to run the suite
 * and none can drift into the repository alongside it.
 *
 * These builders emit HAR TEXT rather than objects, because the parser's whole
 * job is reading text — including text that has been cut in half.
 */

export interface EntryOptions {
  startedDateTime?: string;
  time?: number;
  pageref?: string | null;
  method?: string;
  url?: string;
  requestBody?: string | null;
  requestMimeType?: string;
  status?: number;
  transferSize?: number;
  contentSize?: number;
  mimeType?: string;
  httpVersion?: string;
  wait?: number;
  blocked?: number;
  etag?: string | null;
  cacheControl?: string | null;
  responseText?: string | null;
  error?: string | null;
}

/** An epoch-ms instant expressed the way a HAR writes it, offset included. */
export function at(secondsFromNoon: number, offset = "+00:00"): string {
  const base = Date.UTC(2026, 8, 18, 12, 0, 0);
  const iso = new Date(base + secondsFromNoon * 1000).toISOString();
  // Swap the trailing Z for the requested offset WITHOUT shifting the clock
  // reading, so tests can prove the offset is honoured rather than ignored.
  return offset === "+00:00" ? iso : iso.replace("Z", offset);
}

export function entry(options: EntryOptions = {}): Record<string, unknown> {
  const {
    startedDateTime = at(0),
    time = 100,
    pageref = "page_1",
    method = "GET",
    url = "https://example.test/api/thing",
    requestBody = null,
    requestMimeType = "application/json",
    status = 200,
    transferSize = 1000,
    contentSize = 2000,
    mimeType = "application/json",
    httpVersion = "h2",
    wait = 50,
    blocked = 5,
    etag = null,
    cacheControl = null,
    responseText = null,
    error = null,
  } = options;

  const headers: Record<string, string>[] = [];
  if (etag !== null) headers.push({ name: "ETag", value: etag });
  if (cacheControl !== null) headers.push({ name: "Cache-Control", value: cacheControl });

  const request: Record<string, unknown> = { method, url, httpVersion, headers: [] };
  if (requestBody !== null) {
    request["postData"] = { mimeType: requestMimeType, text: requestBody };
  }

  const content: Record<string, unknown> = { size: contentSize, mimeType };
  if (responseText !== null) content["text"] = responseText;

  const response: Record<string, unknown> = {
    status,
    httpVersion,
    headers,
    content,
    _transferSize: transferSize,
  };
  if (error !== null) response["_error"] = error;

  const result: Record<string, unknown> = {
    startedDateTime,
    time,
    request,
    response,
    timings: { blocked, wait },
  };
  if (pageref !== null) result["pageref"] = pageref;
  return result;
}

export interface PageOptions {
  id?: string;
  title?: string;
  startedDateTime?: string;
  onContentLoad?: number;
  onLoad?: number;
}

export function page(options: PageOptions = {}): Record<string, unknown> {
  const {
    id = "page_1",
    title = "https://example.test/",
    startedDateTime = at(0),
    onContentLoad = 400,
    onLoad = 900,
  } = options;
  return { id, title, startedDateTime, pageTimings: { onContentLoad, onLoad } };
}

/** A complete HAR document as text. Pass `pages: null` to omit the array. */
export function har(
  entries: Record<string, unknown>[],
  pages: Record<string, unknown>[] | null = [page()],
): string {
  const log: Record<string, unknown> = { version: "1.2", creator: { name: "test", version: "1" } };
  if (pages !== null) log["pages"] = pages;
  log["entries"] = entries;
  return JSON.stringify({ log });
}

/**
 * Cut a HAR the way DevTools does when a save races the writer: keep the first
 * `keepEntries` entries whole, then stop partway through the next one.
 *
 * `cutInsideCharacters` is how far into the doomed entry to stop. Small values
 * land in its opening braces; larger ones land inside a string literal, which
 * is the case that breaks a naive scanner.
 */
export function truncatedHar(
  entries: Record<string, unknown>[],
  keepEntries: number,
  cutInsideCharacters: number,
  pages: Record<string, unknown>[] | null = [page()],
): string {
  const whole = har(entries, pages);
  const marker = JSON.stringify(entries[keepEntries]);
  const doomedStart = whole.indexOf(marker);
  if (doomedStart === -1) {
    throw new Error("fixture builder could not locate the entry to cut through");
  }
  return whole.slice(0, doomedStart + cutInsideCharacters);
}

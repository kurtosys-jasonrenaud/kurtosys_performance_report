/**
 * Raw HAR shapes, exactly as they appear in a file.
 *
 * Every field is optional, deliberately. A HAR is written by a browser we do
 * not control, and captures that are truncated, hand-edited, produced by a
 * proxy or exported from a non-Chrome tool routinely omit fields the
 * specification calls required. These interfaces therefore promise only what
 * the parser *looks for*, never that any of it is present.
 *
 * Nothing in parse/ interprets these values. Meaning is normalise/'s job.
 */

export interface RawHarHeader {
  name?: string;
  value?: string;
}

export interface RawHarPostData {
  mimeType?: string;
  text?: string;
}

export interface RawHarRequest {
  method?: string;
  url?: string;
  httpVersion?: string;
  headers?: RawHarHeader[];
  postData?: RawHarPostData;
  bodySize?: number;
}

export interface RawHarContent {
  size?: number;
  mimeType?: string;
  text?: string;
}

export interface RawHarResponse {
  status?: number;
  httpVersion?: string;
  headers?: RawHarHeader[];
  content?: RawHarContent;
  bodySize?: number;
  /** Chrome extension. -1 on a cache hit, absent on other tools. */
  _transferSize?: number;
  /** Chrome extension, e.g. "net::ERR_ABORTED". */
  _error?: string | null;
}

export interface RawHarTimings {
  blocked?: number;
  dns?: number;
  connect?: number;
  send?: number;
  wait?: number;
  receive?: number;
  ssl?: number;
}

export interface RawHarEntry {
  /** The specification spells it lowercase; most tools follow. */
  pageref?: string;
  /** Some tools emit camelCase instead. normalise/ accepts either. */
  pageRef?: string;
  startedDateTime?: string;
  time?: number;
  request?: RawHarRequest;
  response?: RawHarResponse;
  timings?: RawHarTimings;
}

export interface RawHarPageTimings {
  onContentLoad?: number;
  onLoad?: number;
}

export interface RawHarPage {
  id?: string;
  title?: string;
  startedDateTime?: string;
  pageTimings?: RawHarPageTimings;
}

export interface RawHarLog {
  version?: string;
  pages?: RawHarPage[];
  entries?: RawHarEntry[];
}

/**
 * Recovering entries from a HAR that was cut off mid-write.
 *
 * Why this exists: DevTools writes a HAR incrementally, and a file saved while
 * it is still writing ends mid-string. JSON.parse has no incremental mode and
 * the core package has no runtime dependencies, so a truncated capture is
 * either recovered by hand or thrown away. We lost an 8.1MB capture that way
 * and got 102 entries back by hand; this module does that job instead.
 *
 * The approach: locate the entries array, then walk forward one character at a
 * time tracking bracket depth, cutting out each complete top-level object and
 * handing it to JSON.parse individually. Everything before the cut is intact
 * JSON, so every slice up to the truncation point parses cleanly.
 *
 * The scanner has to track string state, and that is where this goes wrong if
 * you are careless. A brace inside a string literal is not structure. A quote
 * preceded by a backslash does not end a string. And — the case that actually
 * bites — a backslash preceded by a backslash is a literal backslash and does
 * NOT escape the character after it, so the quote following \\ really does
 * close the string. Get that wrong and depth tracking drifts, slices land on
 * arbitrary boundaries, and recovery returns confident garbage. Returning
 * garbage is worse than throwing, so the state machine below is written out
 * longhand rather than compressed.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const COLON = 0x3a;

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Find the `[` that opens the array stored under `key`.
 *
 * Matching the bare key text is not enough: a URL or a page title could contain
 * the word. We require the key to be followed by `:` and `[` (whitespace
 * allowed), and we reject a match whose opening quote is backslash-escaped,
 * which is how the word would appear if it were inside another string literal.
 *
 * @returns the offset of the opening bracket, or null if no array was found.
 */
export function findArrayStart(source: string, key: string): number | null {
  const needle = '"' + key + '"';
  let from = 0;

  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return null;
    from = at + needle.length;

    // An escaped opening quote means we are inside somebody else's string.
    if (at > 0 && source.charCodeAt(at - 1) === BACKSLASH) continue;

    let i = from;
    while (i < source.length && isWhitespace(source.charCodeAt(i))) i++;
    if (source.charCodeAt(i) !== COLON) continue;
    i++;
    while (i < source.length && isWhitespace(source.charCodeAt(i))) i++;
    if (source.charCodeAt(i) !== LBRACKET) continue;

    return i;
  }
}

/** One complete top-level object, with where it started in the source. */
export interface ObjectSlice {
  start: number;
  text: string;
}

export interface ScanResult {
  slices: ObjectSlice[];
  /** true when the scanner reached the bracket closing the array. */
  complete: boolean;
  /** Offset where scanning stopped; null when the array closed cleanly. */
  stoppedAt: number | null;
}

/**
 * Walk an array of objects from its opening bracket, returning one slice per
 * complete top-level object. A trailing object that the file cuts through is
 * not returned — only whole ones.
 */
export function scanTopLevelObjects(
  source: string,
  arrayStart: number,
): ScanResult {
  const slices: ObjectSlice[] = [];
  let depth = 0;
  let sliceStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < source.length; i++) {
    const c = source.charCodeAt(i);

    if (inString) {
      if (escaped) {
        // The previous character was a backslash, so this character is escaped
        // whatever it happens to be. Note what does NOT happen here: if this
        // character is itself a backslash we clear the flag rather than setting
        // it again, because \\ is one literal backslash and the next quote is
        // a real closing quote.
        escaped = false;
      } else if (c === BACKSLASH) {
        escaped = true;
      } else if (c === QUOTE) {
        inString = false;
      }
      continue;
    }

    if (c === QUOTE) {
      inString = true;
      continue;
    }

    if (c === LBRACE || c === LBRACKET) {
      // Only remember the start of objects sitting directly in the array. A
      // nested array element (not valid for HAR entries, but tolerated) simply
      // raises the depth and is skipped.
      if (depth === 0 && c === LBRACE) sliceStart = i;
      depth++;
      continue;
    }

    if (c === RBRACE || c === RBRACKET) {
      if (depth === 0) {
        // The bracket closing the array itself. The array was written in full.
        return { slices, complete: true, stoppedAt: null };
      }
      depth--;
      if (depth === 0 && sliceStart !== -1) {
        slices.push({ start: sliceStart, text: source.slice(sliceStart, i + 1) });
        sliceStart = -1;
      }
      continue;
    }
  }

  // Ran off the end of the source. Whatever object was open when the file
  // stopped is where the truncation is; if none was open the file was cut
  // between entries and the end of the source is the honest answer.
  return {
    slices,
    complete: false,
    stoppedAt: sliceStart !== -1 ? sliceStart : source.length,
  };
}

export interface RecoveredArray {
  items: Record<string, unknown>[];
  /** true when the array closed cleanly AND every slice parsed. */
  complete: boolean;
  /** Offset of the first character that could not be recovered. */
  stoppedAt: number | null;
  /** false when no array under that key could be located at all. */
  found: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Locate the array under `key` and parse as many complete objects out of it as
 * the file allows. Never throws.
 */
export function recoverObjectArray(source: string, key: string): RecoveredArray {
  const arrayStart = findArrayStart(source, key);
  if (arrayStart === null) {
    return { items: [], complete: false, stoppedAt: null, found: false };
  }

  const scan = scanTopLevelObjects(source, arrayStart);
  const items: Record<string, unknown>[] = [];

  for (const slice of scan.slices) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice.text);
    } catch {
      // Braces balanced but the contents are malformed. Stop rather than skip:
      // once one slice is corrupt we can no longer trust that the boundaries
      // after it line up with real entries, and a wrongly-aligned entry is a
      // fabricated measurement.
      return { items, complete: false, stoppedAt: slice.start, found: true };
    }
    if (!isPlainObject(parsed)) {
      return { items, complete: false, stoppedAt: slice.start, found: true };
    }
    items.push(parsed);
  }

  return {
    items,
    complete: scan.complete,
    stoppedAt: scan.stoppedAt,
    found: true,
  };
}

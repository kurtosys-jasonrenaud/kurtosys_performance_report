import type { Diagnostic } from "../diagnostics.js";
import { diagnostic } from "../diagnostics.js";
import type { RawHarEntry, RawHarLog, RawHarPage } from "./har-types.js";
import { recoverObjectArray } from "./recover.js";

/**
 * The result of reading a HAR file. Raw shapes only — parse/ deliberately knows
 * nothing about what an entry means.
 *
 * Everything here is plain JSON data, which is the point: a Web Worker can own
 * parsing and hand this object across a postMessage boundary unchanged, with
 * normalisation running wherever it likes.
 */
export interface HarParseResult {
  entries: RawHarEntry[];
  pages: RawHarPage[];
  /** true when the whole file parsed in one go. */
  complete: boolean;
  /**
   * How many entries came back. Equal to entries.length; named explicitly
   * because "we recovered 102 of an unknown total" is the sentence a person
   * needs to read when a capture was truncated.
   */
  recoveredEntries: number;
  /**
   * Where recovery stopped, as an offset into the source string, or null if
   * the file was complete.
   *
   * This is a character offset (UTF-16 code units), not a byte offset. For HAR
   * files the two are the same in practice — the JSON is overwhelmingly ASCII
   * — and reporting the string offset avoids a second pass over 67MB purely to
   * convert units.
   */
  truncatedAt: number | null;
  diagnostics: Diagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the log object. The specification wraps everything in `log`, but trimmed
 * or hand-assembled files sometimes drop the wrapper, and tolerating that costs
 * three lines.
 */
function readLog(whole: unknown): RawHarLog | null {
  if (!isPlainObject(whole)) return null;
  if (isPlainObject(whole["log"])) return whole["log"] as RawHarLog;
  if (Array.isArray(whole["entries"])) return whole as RawHarLog;
  return null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Read a HAR file. Never throws, whatever the input.
 *
 * A well-formed file takes the fast path: one JSON.parse over the whole string.
 * Only when that fails do we fall back to scanning, which is materially slower
 * and is why it is not the default path.
 */
export function parseHar(source: string): HarParseResult {
  let whole: unknown;
  try {
    whole = JSON.parse(source);
  } catch {
    return recoverTruncated(source);
  }

  const log = readLog(whole);
  if (log === null) {
    return {
      entries: [],
      pages: [],
      complete: false,
      recoveredEntries: 0,
      truncatedAt: null,
      diagnostics: [
        diagnostic(
          "unrecognised-shape",
          "The file is valid JSON but does not look like a HAR log: no entries array was found.",
        ),
      ],
    };
  }

  const entries = asArray<RawHarEntry>(log.entries);
  const pages = asArray<RawHarPage>(log.pages);
  const diagnostics: Diagnostic[] = [];
  if (entries.length === 0) {
    diagnostics.push(
      diagnostic("empty-capture", "The capture parsed cleanly but contains no entries."),
    );
  }

  return {
    entries,
    pages,
    complete: true,
    recoveredEntries: entries.length,
    truncatedAt: null,
    diagnostics,
  };
}

/**
 * Salvage path. Reached when JSON.parse rejects the whole file — usually
 * truncation, occasionally corruption. Either way we recover what we can and
 * say plainly that the capture is incomplete.
 */
function recoverTruncated(source: string): HarParseResult {
  // Pages are written before entries in every exporter we have seen, so in a
  // truncated file they are usually intact and worth recovering first.
  const pages = recoverObjectArray(source, "pages");
  const entries = recoverObjectArray(source, "entries");

  const diagnostics: Diagnostic[] = [];

  if (!entries.found) {
    diagnostics.push(
      diagnostic(
        "entries-not-found",
        "The file could not be parsed and no entries array could be located in it. Nothing was recovered.",
      ),
    );
    return {
      entries: [],
      pages: pages.items as RawHarPage[],
      complete: false,
      recoveredEntries: 0,
      truncatedAt: null,
      diagnostics,
    };
  }

  const recovered = entries.items.length;
  const at = entries.stoppedAt;
  diagnostics.push(
    diagnostic(
      "truncated-capture",
      "The capture is incomplete: the file does not parse as a whole. " +
        "Recovered " +
        String(recovered) +
        " complete " +
        (recovered === 1 ? "entry" : "entries") +
        (at === null ? "." : ", stopping at offset " + String(at) + ".") +
        " Counts and totals describe only what was recovered, and must not be" +
        " compared against a complete capture as though they were whole.",
    ),
  );

  return {
    entries: entries.items as RawHarEntry[],
    pages: pages.items as RawHarPage[],
    complete: false,
    recoveredEntries: recovered,
    truncatedAt: at,
    diagnostics,
  };
}

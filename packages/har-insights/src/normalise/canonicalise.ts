import { fnv1a64 } from "./hash.js";

/**
 * Canonicalising a request body so that two requests which are the same request
 * hash the same.
 *
 * The reason this matters: duplicate detection is the headline finding, and it
 * is a comparison between request bodies. Serialisers do not agree on key
 * order. The same application code, called twice, can emit
 * {"fundId":"x","asOf":"2024-01-01"} and {"asOf":"2024-01-01","fundId":"x"} —
 * one request repeated, two different strings. Hashing the raw text reports no
 * duplicates and we conclude, wrongly and in writing, that the page is fine.
 * A false negative here is invisible, which is what makes it dangerous.
 *
 * So: parse the body, sort object keys recursively, re-serialise, hash that.
 *
 * Array order is deliberately preserved. An array is ordered data — a list of
 * fund identifiers in a different order is a different request, and sorting it
 * would merge requests that genuinely differ.
 *
 * Non-JSON bodies fall back to the raw string. Form-encoded bodies therefore do
 * not canonicalise by key order; a=1&b=2 and b=2&a=1 hash differently. That is
 * a known gap, left open until we see it in a real capture rather than guessed
 * at now.
 */

/**
 * Serialise a JSON value with object keys sorted, recursively.
 *
 * Keys are sorted with the default comparator, which orders by UTF-16 code
 * unit. That is deliberate: it is fully deterministic across engines and
 * locales. localeCompare is NOT, and would make the hash depend on where the
 * browser happened to be running.
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    // JSON.parse cannot produce NaN or Infinity, but being total here costs
    // nothing and keeps the function safe for any caller.
    return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  }

  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += stableStringify(value[i]);
    }
    return out + "]";
  }

  if (type === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    let out = "{";
    let first = true;
    for (const key of keys) {
      const entry = object[key];
      if (entry === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += JSON.stringify(key) + ":" + stableStringify(entry);
    }
    return out + "}";
  }

  // undefined, functions and symbols cannot come out of JSON.parse.
  return "null";
}

/**
 * The canonical form of a request body: key-sorted JSON where the body is JSON,
 * the untouched original where it is not.
 *
 * Exported mainly so tests and debugging can see the canonical form directly
 * rather than inferring it from a hash.
 */
export function canonicaliseBody(body: string): string {
  try {
    return stableStringify(JSON.parse(body) as unknown);
  } catch {
    return body;
  }
}

/**
 * The stable key for a request body, or null when the request had no body.
 *
 * Absence and emptiness are kept distinct. A request with no body at all gets
 * null and never compares equal to anything; a request whose body is the
 * literal text "null", or the empty string, has a body and gets a hash. A GET
 * with no payload must not look like a duplicate of another GET with no
 * payload, because they are not duplicated work in the sense the detector
 * reports — that is what the URL and path are for.
 */
export function requestBodyKey(body: string | null): string | null {
  if (body === null) return null;
  return fnv1a64(canonicaliseBody(body));
}

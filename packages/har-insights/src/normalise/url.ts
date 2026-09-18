/**
 * Splitting a URL into origin and path, by hand.
 *
 * Why by hand rather than the URL constructor: the core package compiles with
 * no ambient globals, so that reaching for something runtime-specific is a
 * compile error rather than a surprise in one environment. URL is also more
 * generous than we want — it will happily hand back a data: URI's entire
 * payload as the pathname.
 *
 * Two things are stripped here for reasons that are about safety, not tidiness,
 * and they should not be "simplified away" later:
 *
 *   - userinfo. A URL of the form https://user:secret@host/path puts
 *     credentials in the authority. Those must never reach a path, a rollup,
 *     an evidence block or a run record.
 *   - the body of a non-hierarchical URL. A data: URI *is* the payload, often
 *     base64 of a document or image. Only its scheme survives.
 *
 * The query string is dropped as the contract requires. That also happens to
 * keep identifiers that live in query parameters out of the model.
 */

const SLASH = 0x2f;
const QUESTION = 0x3f;
const HASH = 0x23;

export interface SplitUrl {
  /** scheme://host[:port], lowercased. "data:" and the like for opaque URLs. */
  origin: string;
  /** Pathname only, query and fragment removed. "" for opaque URLs. */
  path: string;
}

export function splitUrl(raw: string): SplitUrl {
  const schemeEnd = raw.indexOf("://");

  if (schemeEnd === -1) {
    // Opaque: data:, blob:, javascript:, about:. Keep the scheme and nothing
    // else — see the note above about payloads.
    const colon = raw.indexOf(":");
    if (colon === -1) return { origin: "", path: "" };
    return { origin: raw.slice(0, colon).toLowerCase() + ":", path: "" };
  }

  const scheme = raw.slice(0, schemeEnd).toLowerCase();
  const authorityStart = schemeEnd + 3;

  let authorityEnd = raw.length;
  for (let i = authorityStart; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === SLASH || c === QUESTION || c === HASH) {
      authorityEnd = i;
      break;
    }
  }

  let authority = raw.slice(authorityStart, authorityEnd);
  // Everything up to the last @ is userinfo, and is discarded.
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);

  let pathEnd = raw.length;
  for (let i = authorityEnd; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === QUESTION || c === HASH) {
      pathEnd = i;
      break;
    }
  }

  // Percent-encoding is left exactly as captured. Decoding would change the
  // grouping key and could surface an identifier that the encoding was hiding.
  const path = raw.slice(authorityEnd, pathEnd);

  return {
    origin: scheme + "://" + authority.toLowerCase(),
    path: path === "" ? "/" : path,
  };
}

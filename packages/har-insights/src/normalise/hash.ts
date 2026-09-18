/**
 * FNV-1a, 64 bit, computed in 16-bit limbs.
 *
 * Three decisions worth recording, because none is recoverable from the code.
 *
 * Why a hash at all, rather than keeping the canonical body: request bodies are
 * payload. Keeping them lets payload leak into findings, evidence and run
 * records, which are meant to be free of it by construction. A hash compares
 * equal-for-equal without carrying the content.
 *
 * Why not BigInt: the same function hashes response bodies, and a 67MB capture
 * is mostly response bodies. A BigInt multiply per byte is roughly an order of
 * magnitude slower than plain number arithmetic and would put seconds onto a
 * large capture, in the browser, on the main thread.
 *
 * Why 64 bit and not 32: at ~2000 entries a 32-bit space carries roughly a
 * 1-in-2000 chance of a birthday collision. A collision here means reporting a
 * duplicate request that never happened — a fabricated finding in front of a
 * client. 64 bits puts that at around one in ten trillion.
 *
 * Why FNV-1a specifically: it needs no dependency and no Web Crypto (which is
 * async, and undeclared in this package's globals-free compilation), and it is
 * byte-exact reproducible in any language. That last point matters because
 * these values are persisted in run records and compared across captures made
 * months apart, possibly by different tooling.
 *
 * It is NOT a cryptographic hash. It must never be used to protect anything.
 */

// The prime is 0x00000100_000001B3. In 16-bit limbs, least significant first,
// that is [0x01b3, 0x0000, 0x0100, 0x0000] — two of the four limbs are zero,
// which is why most partial products below vanish.
const PRIME_L0 = 0x01b3;
const PRIME_L2 = 0x0100;

function hex4(value: number): string {
  return value.toString(16).padStart(4, "0");
}

/**
 * Hash a string as UTF-8 bytes, returning 16 lowercase hex characters.
 *
 * Folding to UTF-8 rather than hashing UTF-16 code units costs a few lines and
 * buys reproducibility outside JavaScript, so a stored key can be recomputed
 * and checked from anywhere. Unpaired surrogates are encoded in their three
 * byte form; they cannot occur in text that came from JSON.parse, and the
 * handling is defined only so the function is total.
 */
export function fnv1a64(input: string): string {
  // Offset basis 0xcbf29ce484222325, in limbs, least significant first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;

  const step = (byte: number): void => {
    h0 ^= byte;

    // h * prime, truncated to 64 bits. Each term is at most
    // 0xffff * 0x1b3 + 0xffff * 0x100, comfortably inside a double's exact
    // integer range and inside 2^32, so the shifts below are safe.
    const t0 = h0 * PRIME_L0;
    const t1 = h1 * PRIME_L0;
    const t2 = h2 * PRIME_L0 + h0 * PRIME_L2;
    const t3 = h3 * PRIME_L0 + h1 * PRIME_L2;

    let carry = t0 >>> 16;
    h0 = t0 & 0xffff;
    const s1 = t1 + carry;
    h1 = s1 & 0xffff;
    carry = s1 >>> 16;
    const s2 = t2 + carry;
    h2 = s2 & 0xffff;
    carry = s2 >>> 16;
    // Anything carried past bit 63 is discarded, which is the modulo 2^64 the
    // algorithm calls for.
    h3 = (t3 + carry) & 0xffff;
  };

  for (let i = 0; i < input.length; i++) {
    let cp = input.charCodeAt(i);

    // Combine a surrogate pair into one code point before encoding.
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }

    if (cp < 0x80) {
      step(cp);
    } else if (cp < 0x800) {
      step(0xc0 | (cp >>> 6));
      step(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      step(0xe0 | (cp >>> 12));
      step(0x80 | ((cp >>> 6) & 0x3f));
      step(0x80 | (cp & 0x3f));
    } else {
      step(0xf0 | (cp >>> 18));
      step(0x80 | ((cp >>> 12) & 0x3f));
      step(0x80 | ((cp >>> 6) & 0x3f));
      step(0x80 | (cp & 0x3f));
    }
  }

  return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
}

import { describe, expect, it } from "vitest";
import { fnv1a64 } from "../src/normalise/hash.js";

/**
 * The hash is implemented in 16-bit limbs rather than BigInt for speed, and
 * limb arithmetic is exactly the kind of code that looks right and is not. The
 * published FNV-1a 64 test vectors are the only real proof it is correct, so
 * they are the first thing in the suite.
 */
describe("fnv1a64", () => {
  it("matches the published FNV-1a 64-bit test vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });

  it("always returns 16 lowercase hex characters", () => {
    for (const input of ["", "a", "foobar", "{}", "x".repeat(5000)]) {
      expect(fnv1a64(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("folds to UTF-8 bytes, including surrogate pairs", () => {
    // Computed independently (reference FNV-1a 64 over the UTF-8 encoding), not
    // captured from this implementation — a self-captured value would only
    // prove the code agrees with itself. Hashing UTF-16 code units instead
    // would give different answers and break reproducibility outside
    // JavaScript, which matters because these keys are persisted.
    expect(fnv1a64("\u00e9")).toBe("0ac21707b7181e01"); // 2 bytes
    expect(fnv1a64("\u65e5\u672c")).toBe("121d7e35a6d3ce91"); // 3 bytes each
    expect(fnv1a64("\u{1f642}")).toBe("ff026b387504e24b"); // surrogate pair, 4 bytes
    expect(fnv1a64('{"a":1}')).toBe("9c3e82dd6fcae8b1");
  });

  it("distinguishes inputs that differ only in length", () => {
    expect(fnv1a64("a")).not.toBe(fnv1a64("aa"));
    expect(fnv1a64("{}")).not.toBe(fnv1a64("{} "));
  });
});

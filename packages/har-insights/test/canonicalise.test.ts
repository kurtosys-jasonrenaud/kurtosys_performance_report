import { describe, expect, it } from "vitest";
import {
  canonicaliseBody,
  keyRequestBody,
  requestBodyKey,
} from "../src/normalise/canonicalise.js";

describe("request body canonicalisation", () => {
  /**
   * The single most important test in the package. Two requests differing only
   * in key ordering are one request repeated; if this fails, duplicate
   * detection reports nothing and we tell a client their page is fine.
   */
  it("gives bodies differing ONLY in key order the same key", () => {
    const a = '{"fundId":"abc","asOf":"2024-01-01","currency":"GBP"}';
    const b = '{"currency":"GBP","fundId":"abc","asOf":"2024-01-01"}';

    expect(requestBodyKey(a)).toBe(requestBodyKey(b));
    expect(requestBodyKey(a)).not.toBeNull();
  });

  it("canonicalises nested objects and objects inside arrays by key order", () => {
    const a = '{"outer":{"z":1,"a":{"n":2,"m":3}},"list":[{"q":1,"p":2},{"s":3,"r":4}]}';
    const b = '{"list":[{"p":2,"q":1},{"r":4,"s":3}],"outer":{"a":{"m":3,"n":2},"z":1}}';

    expect(canonicaliseBody(a)).toBe(canonicaliseBody(b));
    expect(requestBodyKey(a)).toBe(requestBodyKey(b));
  });

  it("preserves array order, because a reordered list is a different request", () => {
    // Sorting arrays too would merge genuinely different requests — a different
    // set of fund identifiers in a different order is not the same call.
    expect(requestBodyKey('{"ids":[1,2,3]}')).not.toBe(requestBodyKey('{"ids":[3,2,1]}'));
  });

  it("falls back to the raw string for a non-JSON body", () => {
    expect(canonicaliseBody("a=1&b=2")).toBe("a=1&b=2");
    expect(canonicaliseBody("not json at all")).toBe("not json at all");

    const form = keyRequestBody("a=1&b=2");
    expect(form.fromJson).toBe(false);
    expect(form.key).not.toBeNull();

    // And the known blind spot, asserted so nobody mistakes it for a bug later:
    // form-encoded bodies do NOT canonicalise by key order.
    expect(requestBodyKey("a=1&b=2")).not.toBe(requestBodyKey("b=2&a=1"));
  });

  it("keeps an absent body distinct from a body that is literally null", () => {
    // A request with no payload must not look like a duplicate of another
    // request with no payload.
    expect(requestBodyKey(null)).toBeNull();
    expect(requestBodyKey("null")).not.toBeNull();
    expect(requestBodyKey("")).not.toBeNull();
    expect(requestBodyKey("")).not.toBe(requestBodyKey("null"));
  });

  it("reports whether the key came from JSON, so blind spots can be diagnosed", () => {
    expect(keyRequestBody('{"a":1}').fromJson).toBe(true);
    expect(keyRequestBody("a=1").fromJson).toBe(false);
    expect(keyRequestBody(null)).toEqual({ key: null, fromJson: false });
  });

  it("sorts keys deterministically rather than by locale", () => {
    // Default sort is UTF-16 code unit order. localeCompare would make the hash
    // depend on where the browser happened to be running.
    expect(canonicaliseBody('{"b":1,"A":2,"a":3}')).toBe('{"A":2,"a":3,"b":1}');
  });
});

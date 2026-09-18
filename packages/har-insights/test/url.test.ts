import { describe, expect, it } from "vitest";
import { splitUrl } from "../src/normalise/url.js";
import { har, entry } from "./support/har-builder.js";
import { parseHar } from "../src/parse/parse-har.js";
import { normaliseHar } from "../src/normalise/normalise.js";

/**
 * These are safety invariants, not formatting preferences. They are tested
 * rather than commented because a test survives a refactor and a comment does
 * not.
 */
describe("URL normalisation safety invariants", () => {
  it("userinfo never survives normalisation", () => {
    const { origin, path } = splitUrl("https://user:s3cret@example.test/api/thing?x=1");

    expect(origin).toBe("https://example.test");
    expect(path).toBe("/api/thing");
    expect(origin).not.toContain("s3cret");
    expect(origin).not.toContain("user");
    expect(origin).not.toContain("@");
  });

  it("userinfo never survives normalisation, end to end through a capture", () => {
    const result = normaliseHar(
      parseHar(har([entry({ url: "https://user:s3cret@example.test/a/b?token=abc" })])),
    );
    const only = result.entries[0];

    expect(only?.origin).not.toContain("s3cret");
    expect(only?.path).toBe("/a/b");
    expect(only?.origin).toBe("https://example.test");
  });

  it("a data: URI body is never retained", () => {
    // The body of a data: URI IS the payload. Letting it through would put
    // captured content into paths, rollups and evidence.
    const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { origin, path } = splitUrl("data:image/png;base64," + payload);

    expect(origin).toBe("data:");
    expect(path).toBe("");
    expect(origin + path).not.toContain(payload);
    expect(origin + path).not.toContain("base64");
  });

  it("strips the query string, which is where tokens live", () => {
    const { path } = splitUrl("https://example.test/api/q?access_token=SECRET&x=1");

    expect(path).toBe("/api/q");
    expect(path).not.toContain("SECRET");
  });

  it("lowercases scheme and host but leaves the path case alone", () => {
    const { origin, path } = splitUrl("HTTPS://Example.TEST/Api/Thing");

    expect(origin).toBe("https://example.test");
    expect(path).toBe("/Api/Thing");
  });

  it("keeps the port, which distinguishes origins", () => {
    expect(splitUrl("https://example.test:8443/a").origin).toBe("https://example.test:8443");
  });

  it("gives a bare origin the root path", () => {
    expect(splitUrl("https://example.test").path).toBe("/");
    expect(splitUrl("https://example.test?x=1").path).toBe("/");
  });

  it("leaves percent-encoding exactly as captured", () => {
    // Decoding could change the grouping key and surface an identifier the
    // encoding was hiding.
    expect(splitUrl("https://example.test/a%2Fb/c").path).toBe("/a%2Fb/c");
  });
});

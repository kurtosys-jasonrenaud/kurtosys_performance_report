import { describe, expect, it } from "vitest";
import { parseHar } from "../src/parse/parse-har.js";
import { findArrayStart, scanTopLevelObjects } from "../src/parse/recover.js";
import { at, entry, har, page, truncatedHar } from "./support/har-builder.js";

describe("parseHar, well-formed capture", () => {
  it("parses and reports the capture as complete", () => {
    const source = har([entry({ startedDateTime: at(0) }), entry({ startedDateTime: at(1) })]);
    const result = parseHar(source);

    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.recoveredEntries).toBe(2);
    expect(result.truncatedAtCharOffset).toBeNull();
    expect(result.diagnostics).toHaveLength(0);
  });

  it("reads pages when present", () => {
    const result = parseHar(har([entry()], [page({ id: "page_1" }), page({ id: "page_2" })]));
    expect(result.pages).toHaveLength(2);
  });

  it("returns an empty capture rather than failing when there are no entries", () => {
    const result = parseHar(har([]));

    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toContain("empty-capture");
  });

  it("tolerates a capture with no pages array", () => {
    const result = parseHar(har([entry()], null));

    expect(result.complete).toBe(true);
    expect(result.pages).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it("does not throw on input that is not a HAR at all", () => {
    const result = parseHar('{"something":"else"}');

    expect(result.entries).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain("unrecognised-shape");
  });

  it("does not throw on input that is not JSON at all", () => {
    expect(() => parseHar("this is not json")).not.toThrow();
    expect(parseHar("this is not json").recoveredEntries).toBe(0);
  });
});

describe("parseHar, truncated capture", () => {
  const entries = [
    entry({ startedDateTime: at(0), url: "https://example.test/one" }),
    entry({ startedDateTime: at(1), url: "https://example.test/two" }),
    entry({ startedDateTime: at(2), url: "https://example.test/three" }),
  ];

  it("recovers the complete entries and does not throw", () => {
    // Cut a little way into the third entry: two are whole.
    const source = truncatedHar(entries, 2, 40);
    const result = parseHar(source);

    expect(result.complete).toBe(false);
    expect(result.recoveredEntries).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.request?.url).toBe("https://example.test/one");
    expect(result.entries[1]?.request?.url).toBe("https://example.test/two");
  });

  it("recovers prior entries when the cut lands inside a string literal", () => {
    // The dangerous case: the file stops midway through a URL, so the scanner
    // is inside an unterminated string when the source runs out.
    const withBody = [
      entry({ startedDateTime: at(0), requestBody: '{"a":1}' }),
      entry({
        startedDateTime: at(1),
        requestBody: '{"queryText":"a very long string that the file stops inside of"}',
      }),
    ];
    const whole = har(withBody);
    const cutInsideBody = whole.indexOf("the file stops inside") + 8;
    const result = parseHar(whole.slice(0, cutInsideBody));

    expect(result.complete).toBe(false);
    expect(result.recoveredEntries).toBe(1);
    expect(result.entries[0]?.request?.postData?.text).toBe('{"a":1}');
  });

  it("reports where it stopped and says so in a diagnostic", () => {
    const source = truncatedHar(entries, 2, 40);
    const result = parseHar(source);

    expect(result.truncatedAtCharOffset).toBeGreaterThan(0);
    expect(result.truncatedAtCharOffset).toBeLessThanOrEqual(source.length);

    const truncation = result.diagnostics.find((d) => d.code === "truncated-capture");
    expect(truncation?.severity).toBe("error");
    expect(truncation?.data?.["recoveredEntries"]).toBe(2);
    expect(truncation?.data?.["truncatedAtCharOffset"]).toBe(result.truncatedAtCharOffset);
  });

  it("still recovers the pages array, which is written before the entries", () => {
    const source = truncatedHar(entries, 1, 30, [page({ id: "page_1", onLoad: 1234 })]);
    const result = parseHar(source);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.pageTimings?.onLoad).toBe(1234);
  });

  it("recovers nothing, without throwing, when the cut precedes the entries", () => {
    const whole = har(entries);
    const result = parseHar(whole.slice(0, whole.indexOf('"entries"') - 5));

    expect(result.recoveredEntries).toBe(0);
    expect(result.diagnostics.map((d) => d.code)).toContain("entries-not-found");
  });

  it("recovers zero entries when the cut lands inside the very first one", () => {
    const source = truncatedHar(entries, 0, 20);
    const result = parseHar(source);

    expect(result.complete).toBe(false);
    expect(result.entries).toEqual([]);
  });
});

/**
 * The scanner's string state is the part that returns confident garbage when it
 * is wrong, so it is tested directly as well as through parseHar.
 */
describe("scanTopLevelObjects string state", () => {
  const scan = (source: string) => {
    const start = findArrayStart(source, "entries");
    expect(start).not.toBeNull();
    return scanTopLevelObjects(source, start as number);
  };

  it("ignores braces and brackets inside string literals", () => {
    const source = har([
      entry({ url: 'https://example.test/api/{tenant}/q?f={"a":[1,2]}' }),
      entry({ url: "https://example.test/b" }),
    ]);
    const result = scan(source);

    expect(result.complete).toBe(true);
    expect(result.slices).toHaveLength(2);
    expect(parseHar(source).entries[0]?.request?.url).toBe(
      'https://example.test/api/{tenant}/q?f={"a":[1,2]}',
    );
  });

  it("does not end a string on an escaped quote", () => {
    const body = '{"note":"he said \\"go now\\" and left {not a brace}"}';
    const source = har([entry({ requestBody: body }), entry()]);
    const result = scan(source);

    expect(result.complete).toBe(true);
    expect(result.slices).toHaveLength(2);
    expect(parseHar(source).entries[0]?.request?.postData?.text).toBe(body);
  });

  it("DOES end a string on a quote following an escaped backslash", () => {
    // The trap. In "a path C:\\" the two backslashes are one literal
    // backslash, so the quote after them really does close the string. Treat
    // that quote as escaped and every brace afterwards is counted in the wrong
    // state, slices land on arbitrary boundaries, and recovery returns
    // fabricated entries instead of failing.
    const body = '{"winPath":"C:\\\\share\\\\","next":{"deep":1}}';
    const source = har([entry({ requestBody: body }), entry({ url: "https://example.test/after" })]);
    const result = scan(source);

    expect(result.complete).toBe(true);
    expect(result.slices).toHaveLength(2);

    const parsed = parseHar(source);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.request?.postData?.text).toBe(body);
    expect(parsed.entries[1]?.request?.url).toBe("https://example.test/after");
  });

  it("does not mistake the word entries inside a string for the entries array", () => {
    const source = har([entry({ url: 'https://example.test/x?q=%22entries%22:[' })]);
    const result = scan(source);

    expect(result.complete).toBe(true);
    expect(result.slices).toHaveLength(1);
  });
});

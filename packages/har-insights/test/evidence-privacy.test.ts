import { describe, expect, it } from "vitest";
import { runDetectors, allDetectors } from "../src/detect/registry.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import { at, entry, har, page } from "./support/har-builder.js";

/**
 * DO NOT DELETE THESE TESTS.
 *
 * This is the point where the privacy design fails if anyone is careless.
 * "Evidence sufficient to reconstruct the claim" tempts a well-meaning person
 * towards the obvious implementation — put the duplicated payload in the
 * duplicate-payload finding — and that payload is investor data. The same
 * temptation applies to urls, whose query strings carry session tokens.
 *
 * Evidence carries HASHES, never bodies, and PATHS, never urls. Entry indices
 * are what make a hash sufficient: a person can open the capture and look at
 * the real thing, which never leaves their browser.
 *
 * If one of these tests fails, the fix is in the detector, never here.
 */

/** Fake, and shaped like the real things they stand in for. */
const FAKE_EMAIL = "investor.mcinvestorface@example.invalid";
const FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.FAKESESSIONTOKEN.c2lnbmF0dXJl";
const FAKE_ACCOUNT = "ACCT-00099812";

/**
 * A capture in which every dangerous string appears somewhere a careless
 * detector might pick it up: in a request body, in a query string, repeated so
 * that the duplicate detector definitely fires on it.
 */
function capturingSecrets(): string {
  const body = JSON.stringify({
    email: FAKE_EMAIL,
    accountId: FAKE_ACCOUNT,
    asOf: "2024-01-01",
  });
  const url =
    "https://example.test/services/dataset/execute?access_token=" +
    FAKE_TOKEN +
    "&account=" +
    FAKE_ACCOUNT;

  const duplicated = (seconds: number) =>
    entry({
      startedDateTime: at(seconds),
      method: "POST",
      url,
      requestBody: body,
      responseText: JSON.stringify({ holder: FAKE_EMAIL }),
      pageref: "page_1",
    });

  return har(
    [
      duplicated(0),
      duplicated(1),
      duplicated(2),
      entry({
        startedDateTime: at(3),
        method: "GET",
        url: "https://example.test/api/profile?token=" + FAKE_TOKEN,
        pageref: "page_1",
      }),
      entry({
        startedDateTime: at(4),
        method: "GET",
        url: "https://example.test/api/profile?token=" + FAKE_TOKEN,
        pageref: "page_1",
      }),
    ],
    [page({ id: "page_1", title: "https://example.test/dashboards/?token=" + FAKE_TOKEN })],
  );
}

describe("evidence never carries payloads or urls", () => {
  const result = runDetectors(normaliseHar(parseHar(capturingSecrets())));
  const serialised = JSON.stringify(result);

  it("produced findings at all, so the assertions below are not vacuous", () => {
    // A test that passes because nothing ran is not a test.
    expect(result.findings.length).toBeGreaterThan(0);
    expect(Object.keys(result.metrics).length).toBeGreaterThan(0);
  });

  it("never leaks a request body into a finding or a metric", () => {
    expect(serialised).not.toContain(FAKE_EMAIL);
    expect(serialised).not.toContain(FAKE_ACCOUNT);
    // Not even the field names of the payload.
    expect(serialised).not.toContain("accountId");
  });

  it("never leaks a query string token into a finding or a metric", () => {
    expect(serialised).not.toContain(FAKE_TOKEN);
    expect(serialised).not.toContain("access_token");
    expect(serialised).not.toContain("?token=");
  });

  it("never leaks a response body into a finding or a metric", () => {
    expect(serialised).not.toContain("holder");
  });

  it("carries the path but never the url", () => {
    // Two endpoints duplicate here: the POST and the repeated GET. Select the
    // POST explicitly rather than taking whichever sorts first.
    const duplicate = result.findings.find(
      (finding) => finding.evidence["method"] === "POST",
    );

    expect(duplicate?.detectorId).toBe("duplicate-payload-within-page");
    expect(duplicate?.evidence["path"]).toBe("/services/dataset/execute");
    expect(JSON.stringify(duplicate?.evidence)).not.toContain("https://");
  });

  it("identifies the repeated request by hash, not by content", () => {
    const duplicate = result.findings.find(
      (finding) => finding.evidence["method"] === "POST",
    );
    const groups = duplicate?.evidence["groups"] as { requestHash: string }[];

    expect(groups[0]?.requestHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps entry indices, which are what make a hash sufficient", () => {
    // The hash proves two requests were identical. The indices let a person
    // open the capture and see which ones, without the tool ever holding them.
    const duplicate = result.findings.find(
      (finding) => finding.evidence["method"] === "POST",
    );
    const groups = duplicate?.evidence["groups"] as {
      entryIndices: number[];
      sourceIndexes: number[];
    }[];

    expect(groups[0]?.entryIndices.length).toBeGreaterThan(1);
    expect(groups[0]?.sourceIndexes.length).toBe(groups[0]?.entryIndices.length);
  });

  it("never leaks a token through the page route taken from a page title", () => {
    // Page titles are urls in Chrome exports, so the route derivation is
    // another door into the same problem.
    for (const finding of result.findings) {
      expect(finding.key).not.toContain(FAKE_TOKEN);
      expect(finding.summary).not.toContain(FAKE_TOKEN);
    }
    expect(serialised).not.toContain("dashboards/?");
  });

  it("holds for every registered detector, including ones added later", () => {
    // Iterating the registry rather than naming three detectors means a new
    // detector is covered by this test the day it is registered.
    for (const spec of allDetectors) {
      const output = JSON.stringify(spec.run(normaliseHar(parseHar(capturingSecrets()))));
      expect(output).not.toContain(FAKE_EMAIL);
      expect(output).not.toContain(FAKE_TOKEN);
      expect(output).not.toContain(FAKE_ACCOUNT);
    }
  });
});

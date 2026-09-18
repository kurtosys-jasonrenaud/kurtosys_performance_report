import { describe, expect, it } from "vitest";
import { runDetectors } from "../src/detect/registry.js";
import { normaliseHar } from "../src/normalise/normalise.js";
import { parseHar } from "../src/parse/parse-har.js";
import {
  MissingMetadataError,
  buildRunRecord,
  buildRunRecordCore,
  finaliseRunRecord,
} from "../src/record/emit.js";
import type { RunMetadata } from "../src/record/types.js";
import { ANALYZER_VERSION, SCHEMA_VERSION } from "../src/record/types.js";
import { at, entry, har, page } from "./support/har-builder.js";

/**
 * DO NOT DELETE THE LEAKAGE TESTS BELOW.
 *
 * The run record is the artefact designed to be stored, transmitted and shared.
 * A capture stays in the browser; a record does not. If a token or an investor
 * address ever reaches a record, it reaches wherever records go.
 *
 * The emitter copies by allowlist for exactly this reason: a field added later
 * is absent from records until somebody adds it deliberately. These tests are
 * what make that claim checkable rather than aspirational.
 */

const FAKE_EMAIL = "investor.mcinvestorface@example.invalid";
const FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.FAKESESSIONTOKEN.c2lnbmF0dXJl";
const FAKE_ACCOUNT = "ACCT-00099812";

const METADATA: RunMetadata = {
  client: "Example Client",
  environment: "production",
  build: "2026.09.17-1",
  ticket: "HV-1512",
  journey: "log in, open dashboard, filter documents",
  recordedAt: "2026-09-18T12:00:00.000Z",
};

function captureWithSecrets(): string {
  const body = JSON.stringify({ email: FAKE_EMAIL, accountId: FAKE_ACCOUNT });
  const url =
    "https://user:hunter2@app.example.test/services/dataset/execute?access_token=" +
    FAKE_TOKEN;

  const repeated = (seconds: number) =>
    entry({
      startedDateTime: at(seconds),
      method: "POST",
      url,
      requestBody: body,
      responseText: JSON.stringify({ holder: FAKE_EMAIL }),
      pageref: "page_1",
    });

  return har(
    [repeated(0), repeated(1), repeated(2)],
    [
      page({
        id: "page_1",
        title: "https://app.example.test/dashboards/?access_token=" + FAKE_TOKEN,
      }),
    ],
  );
}

function record() {
  const model = normaliseHar(parseHar(captureWithSecrets()));
  return buildRunRecord(model, runDetectors(model), METADATA);
}

describe("run record never carries payloads, urls or credentials", () => {
  const serialised = JSON.stringify(record());

  it("contains findings, so the assertions below are not vacuous", () => {
    expect(record().findings.length).toBeGreaterThan(0);
    expect(serialised.length).toBeGreaterThan(200);
  });

  it("does not contain a request body or anything from one", () => {
    expect(serialised).not.toContain(FAKE_EMAIL);
    expect(serialised).not.toContain(FAKE_ACCOUNT);
    expect(serialised).not.toContain("accountId");
  });

  it("does not contain a query string token", () => {
    expect(serialised).not.toContain(FAKE_TOKEN);
    expect(serialised).not.toContain("access_token");
  });

  it("does not contain credentials from a url authority", () => {
    expect(serialised).not.toContain("hunter2");
  });

  it("does not contain a full url anywhere", () => {
    // Paths and hosts are recorded; whole urls never are, because the query
    // string travels with them.
    expect(serialised).not.toContain("https://app.example.test/services");
    expect(serialised).not.toContain("?");
  });

  it("does not contain a page title, which Chrome writes as the page url", () => {
    expect(serialised).not.toContain("/dashboards/?");
  });

  it("records the host, which is infrastructure rather than payload", () => {
    expect(record().capture.hosts).toEqual(["https://app.example.test"]);
  });

  it("records the path and the request hash, which is what makes it verifiable", () => {
    const finding = record().findings[0];
    expect(finding?.evidence["path"]).toBe("/services/dataset/execute");
    const groups = finding?.evidence["groups"] as { requestHash: string }[];
    expect(groups[0]?.requestHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the evidence allowlist fails safe", () => {
  it("omits evidence entirely for a detector it does not know", () => {
    // A detector added later contributes no evidence until somebody extends the
    // allowlist on purpose. Forgetting produces an empty block, not a leak.
    const model = normaliseHar(parseHar(captureWithSecrets()));
    const invented = {
      id: "invented-detector",
      version: 1,
      title: "Invented",
      category: "payload" as const,
      run: () => ({
        findings: [
          {
            detectorId: "invented-detector",
            detectorVersion: 1,
            key: "invented-detector:GET:/x:/",
            severity: "low" as const,
            summary: "Something was counted",
            // Exactly the mistake the allowlist exists to survive.
            evidence: { url: "https://x.test/?access_token=" + FAKE_TOKEN, body: FAKE_EMAIL },
          },
        ],
      }),
    };

    const core = buildRunRecordCore(model, runDetectors(model, [invented]));
    const serialised = JSON.stringify(core);

    expect(core.findings[0]?.evidenceOmitted).toBe(true);
    expect(core.findings[0]?.evidence).toEqual({});
    expect(serialised).not.toContain(FAKE_TOKEN);
    expect(serialised).not.toContain(FAKE_EMAIL);
  });
});

describe("run record metadata", () => {
  it("refuses to emit an unlabelled record", () => {
    const model = normaliseHar(parseHar(har([entry()])));
    const core = buildRunRecordCore(model, runDetectors(model));

    expect(() =>
      finaliseRunRecord(core, { ...METADATA, client: "   " }),
    ).toThrow(MissingMetadataError);
    expect(() => finaliseRunRecord(core, { ...METADATA, journey: "" })).toThrow(
      /journey/,
    );

    // Ticket is deliberately NOT required: investigations regularly start
    // before anyone has raised one, and refusing the record loses the capture.
    expect(() => finaliseRunRecord(core, { ...METADATA, ticket: "" })).not.toThrow();
  });

  it("carries both version stamps and every detector version", () => {
    const built = record();

    expect(built.schemaVersion).toBe(SCHEMA_VERSION);
    expect(built.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(built.detectorVersions["max-in-flight"]).toBe(1);
    expect(built.detectorVersions["pool-saturation"]).toBe(1);
    expect(built.detectorVersions["duplicate-payload-within-page"]).toBe(2);
  });
});

describe("run record round trip", () => {
  it("survives JSON serialisation with identical values", () => {
    // The download is JSON, so anything that does not survive JSON.stringify is
    // not really in the record.
    const original = record();
    const reimported = JSON.parse(JSON.stringify(original)) as typeof original;

    expect(reimported).toEqual(original);
    expect(JSON.stringify(reimported)).toBe(JSON.stringify(original));
  });

  it("is deterministic: the same capture produces a byte-identical record", () => {
    expect(JSON.stringify(record())).toBe(JSON.stringify(record()));
  });
});

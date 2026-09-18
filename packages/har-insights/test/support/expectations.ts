import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loading the golden expectations that sit beside real captures.
 *
 * Both directories are gitignored. A capture carries session tokens and, on
 * emulated sessions, cleartext email addresses; the expectations carry real
 * endpoint paths and call counts, which are client-identifying even though they
 * hold no payload. Neither is ever committed to this public repository.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, "..", "fixtures");
export const CAPTURES_DIR = join(FIXTURES_DIR, "captures");
export const EXPECTATIONS_DIR = join(FIXTURES_DIR, "expectations");

/**
 * Every expected value carries its DEFINITION, not just its number.
 *
 * This is not ceremony. The same capture produced "648 service calls and
 * 7.35 MB" under one filter and "658 and 7.01 MB" under a slightly different
 * one. Both were arrived at honestly; they measured different things. A number
 * without the rule that produced it is not a fact, and two people comparing
 * bare numbers will disagree without ever discovering why.
 */
export interface CaptureExpectations {
  captureId: string;
  /** File name inside fixtures/captures/. */
  file: string;
  /** How each expected value is computed. Prose, keyed by value name. */
  definitions: Record<string, string>;
  expect: {
    capture?: {
      entries?: number;
      windowMsToTenthSecond?: number;
      transferBytesMb?: number;
      /** Interpretation of "MB": 1024*1024 or 1000*1000. */
      transferBytesMbBase?: 1048576 | 1000000;
      pageLoads?: number;
      unpagedEntries?: number;
    };
    servicesRollup?: {
      /** The path fragment to select on. */
      pathPrefix: string;
      /**
       * How pathPrefix selects rows. "contains" catches endpoints mounted under
       * another prefix — /ksys-app-manager/services/... is a service call even
       * though the path does not begin with the fragment.
       */
      pathMatch?: "startsWith" | "contains";
      totalCalls?: number;
      totalDurationMsToTenthSecond?: number;
      endpoints?: {
        path: string;
        calls: number;
        durationSeconds?: number;
        statusDistribution?: Record<string, number>;
      }[];
    };
    concurrency?: {
      globalMaxInFlight?: number;
      /**
       * Ceilings observed within a narrower slice of the capture.
       *
       * A global ceiling mixes everything the browser did at once, including
       * simultaneous cache reads of static assets. A pool limit shows up only
       * when you look at the requests that share the pool, so the scope has to
       * be stated with the number.
       */
      scopes?: {
        label: string;
        pathEquals?: string;
        pathContains?: string;
        origin?: string;
        maxInFlight: number;
      }[];
    };
    pages?: {
      pageRef: string;
      route?: string;
      requests?: number;
      onLoadMs?: number;
      /**
       * Round both sides to this before comparing. Manual figures are often
       * read off a waterfall to the nearest tenth of a second; asserting a
       * float against a rounded reading fails on precision rather than on
       * substance.
       */
      onLoadMsToNearest?: number;
      /** Page start to the start of the first JSON response. See the contract. */
      firstJsonResponseMs?: number | null;
      /** Page start to the end of the last JSON response. */
      lastJsonResponseMs?: number | null;
    }[];
    duplicatePayload?: {
      /** Every intra-page duplicate finding the detector reports, unscoped. */
      intraPageFindings?: number;
      /** Distinct payloads repeated anywhere in the capture, across pages. */
      sessionWideRepeatedPayloads?: number;
      /** Occurrences of the single most repeated payload, session-wide. */
      largestSessionWideRepeat?: number;
      /**
       * Narrows the three counts above to request bodies that are JSON objects
       * carrying ALL of these top-level keys.
       *
       * The keys live here, in a gitignored expectations file, and never in the
       * committed harness: a payload shape is client-specific, and this
       * repository is public. The harness reads them generically.
       */
      payloadShape?: string[];
      /** Distinct payloads of that shape repeated within a single page. */
      intraPageRepeatsOfShape?: number;
    };
  };
  /**
   * Values we know exist but cannot assert yet because their definition has not
   * been agreed. Recorded here so they are visible rather than quietly absent;
   * the harness prints them and asserts nothing.
   */
  pendingDefinitions?: Record<string, string>;
}

export interface GoldenCase {
  expectations: CaptureExpectations;
  capturePath: string;
  capturePresent: boolean;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertShape(value: unknown, file: string): CaptureExpectations {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expectations file " + file + " is not an object.");
  }
  const candidate = value as Partial<CaptureExpectations>;
  for (const field of ["captureId", "file"] as const) {
    if (typeof candidate[field] !== "string") {
      throw new Error("Expectations file " + file + " is missing a string '" + field + "'.");
    }
  }
  if (typeof candidate.definitions !== "object" || candidate.definitions === null) {
    throw new Error(
      "Expectations file " +
        file +
        " has no 'definitions'. Every expected value must carry the rule that" +
        " produced it — a bare number is not a fact.",
    );
  }
  if (typeof candidate.expect !== "object" || candidate.expect === null) {
    throw new Error("Expectations file " + file + " has no 'expect' block.");
  }
  return candidate as CaptureExpectations;
}

/** Expectation files present, each paired with whether its capture is on disk. */
export function loadGoldenCases(): GoldenCase[] {
  if (!existsSync(EXPECTATIONS_DIR)) return [];

  return readdirSync(EXPECTATIONS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const expectations = assertShape(readJson(join(EXPECTATIONS_DIR, name)), name);
      const capturePath = join(CAPTURES_DIR, expectations.file);
      return { expectations, capturePath, capturePresent: existsSync(capturePath) };
    });
}

/**
 * Captures sitting in the fixtures directory with no expectations file.
 *
 * These FAIL rather than skip. A capture present but unasserted is the quiet
 * case: somebody copied a file in expecting it to be checked, and nothing
 * checked it.
 */
export function findOrphanCaptures(cases: GoldenCase[]): string[] {
  if (!existsSync(CAPTURES_DIR)) return [];
  const claimed = new Set(cases.map((one) => one.expectations.file));
  return readdirSync(CAPTURES_DIR)
    .filter((name) => name.toLowerCase().endsWith(".har"))
    .filter((name) => !claimed.has(name))
    .sort();
}

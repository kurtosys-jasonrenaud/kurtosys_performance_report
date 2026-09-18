import type { DetectorRunResult } from "../detect/registry.js";
import type { Finding } from "../detect/types.js";
import type { NormaliseResult } from "../normalise/types.js";
import type {
  Assertion,
  AssertionResult,
  DetectorAssertion,
  EndpointProfile,
  MetricAssertion,
  PoolInFlightRow,
  Profile,
  QueryRollupRow,
} from "./types.js";
import { isMetricAssertion } from "./types.js";

/**
 * Evaluating a profile's assertions against what was measured.
 *
 * This is the deliverable the tool was built for: the verification comment
 * somebody used to write by hand, generated from the capture instead.
 *
 * Assertions read the analysis. They cannot alter it — an assertion that failed
 * changes nothing except a row in a table, which is the point. A failing
 * assertion is a statement about the system, not a reason to adjust a number.
 */

export interface AssertionContext {
  model: NormaliseResult;
  detectors: DetectorRunResult;
  endpoints: Record<string, EndpointProfile>;
  queries: QueryRollupRow[];
  pools: PoolInFlightRow[];
}

export function evaluateAssertions(
  profile: Profile,
  context: AssertionContext,
): AssertionResult[] {
  return (profile.assertions ?? []).map((assertion) =>
    isMetricAssertion(assertion)
      ? evaluateMetric(assertion, context)
      : evaluateDetector(assertion, context),
  );
}

/** Which findings an assertion's scope selects. */
function inScope(
  finding: Finding,
  scope: string | undefined,
  endpoints: Record<string, EndpointProfile>,
): boolean {
  if (scope === undefined || scope === "") return true;

  const path = typeof finding.evidence["path"] === "string" ? finding.evidence["path"] : "";

  if (scope === "json" || scope === "data") {
    return finding.evidence["responseClass"] === "data";
  }
  if (scope.startsWith("pool:")) {
    return endpoints[path]?.pool === scope.slice(5);
  }
  if (scope.startsWith("class:")) {
    return endpoints[path]?.class === scope.slice(6);
  }
  if (scope.startsWith("path:")) {
    return path.startsWith(scope.slice(5));
  }
  return true;
}

function evaluateDetector(
  assertion: DetectorAssertion,
  context: AssertionContext,
): AssertionResult {
  const all = context.detectors.findings.filter(
    (finding) => finding.detectorId === assertion.detector,
  );
  const matching = all.filter((finding) =>
    inScope(finding, assertion.scope, context.endpoints),
  );

  const known = context.detectors.detectorVersions[assertion.detector] !== undefined;
  const scopeText = assertion.scope === undefined ? "" : " within " + assertion.scope;

  if (!known) {
    return {
      id: assertion.id,
      description: assertion.description ?? assertion.detector,
      kind: "detector",
      expectation: assertion.expect + scopeText,
      observed: "detector '" + assertion.detector + "' did not run",
      passed: false,
      evaluated: false,
      note: "No detector with that id is registered, so this was neither met nor missed.",
    };
  }

  const passed = assertion.expect === "none" ? matching.length === 0 : matching.length > 0;

  return {
    id: assertion.id,
    description: assertion.description ?? assertion.detector + scopeText,
    kind: "detector",
    expectation:
      assertion.expect === "none"
        ? "no findings" + scopeText
        : "at least one finding" + scopeText,
    observed:
      matching.length === 0
        ? "none"
        : matching.length +
          (matching.length === 1 ? " finding: " : " findings, first: ") +
          (matching[0]?.summary ?? ""),
    passed,
    evaluated: true,
    note:
      matching.length !== all.length
        ? all.length +
          " findings from this detector overall; " +
          matching.length +
          " inside the scope."
        : null,
  };
}

interface Comparison {
  operator: string;
  threshold: number;
}

/** Parse "> 3", "<= 262144", "== 5". */
function parseExpectation(expect: string): Comparison | null {
  const match = /^\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(expect);
  if (match === null) return null;
  return { operator: match[1] as string, threshold: Number(match[2]) };
}

function satisfies(value: number, comparison: Comparison): boolean {
  switch (comparison.operator) {
    case ">":
      return value > comparison.threshold;
    case ">=":
      return value >= comparison.threshold;
    case "<":
      return value < comparison.threshold;
    case "<=":
      return value <= comparison.threshold;
    case "==":
      return value === comparison.threshold;
    case "!=":
      return value !== comparison.threshold;
    default:
      return false;
  }
}

function describeScope(assertion: MetricAssertion): string {
  const parts: string[] = [];
  if (assertion.pool !== undefined) parts.push("pool " + assertion.pool);
  if (assertion.path !== undefined) parts.push("path " + assertion.path);
  if (assertion.class !== undefined) parts.push("class " + assertion.class);
  if (assertion.queryId !== undefined) parts.push("query " + assertion.queryId);
  return parts.length === 0 ? "the capture" : parts.join(", ");
}

/** The measured value, or null when there was nothing to measure. */
function measure(assertion: MetricAssertion, context: AssertionContext): number | null {
  const selectEntries = () =>
    context.model.entries.filter((entry) => {
      const config = context.endpoints[entry.path];
      if (assertion.pool !== undefined && config?.pool !== assertion.pool) return false;
      if (assertion.class !== undefined && config?.class !== assertion.class) return false;
      if (assertion.path !== undefined && !entry.path.startsWith(assertion.path)) return false;
      return true;
    });

  switch (assertion.metric) {
    case "maxInFlight": {
      if (assertion.pool !== undefined) {
        const pool = context.pools.find((row) => row.pool === assertion.pool);
        return pool === undefined ? null : pool.maxInFlight;
      }
      const network = context.detectors.metrics["max-in-flight"]?.["network"] as
        | { maxInFlight: number }
        | undefined;
      return network?.maxInFlight ?? null;
    }
    case "maxContentBytes": {
      const entries = selectEntries();
      return entries.length === 0 ? null : Math.max(...entries.map((e) => e.contentBytes));
    }
    case "maxTransferBytes": {
      const entries = selectEntries();
      return entries.length === 0 ? null : Math.max(...entries.map((e) => e.transferBytes));
    }
    case "calls": {
      const entries = selectEntries();
      return entries.length;
    }
    case "queryRuns": {
      const rows = context.queries.filter(
        (row) => assertion.queryId === undefined || row.queryId === assertion.queryId,
      );
      return rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.runs, 0);
    }
    case "distinctQueries": {
      const rows = context.queries.filter(
        (row) => assertion.path === undefined || row.path.startsWith(assertion.path),
      );
      return rows.length;
    }
    default:
      return null;
  }
}

function evaluateMetric(
  assertion: MetricAssertion,
  context: AssertionContext,
): AssertionResult {
  const comparison = parseExpectation(assertion.expect);
  const scope = describeScope(assertion);
  const description = assertion.description ?? assertion.metric + " for " + scope;

  if (comparison === null) {
    return {
      id: assertion.id,
      description,
      kind: "metric",
      expectation: assertion.expect,
      observed: "not evaluated",
      passed: false,
      evaluated: false,
      note:
        "Could not read the expectation '" +
        assertion.expect +
        "'. Write it as a comparison, for example '> 3'.",
    };
  }

  const value = measure(assertion, context);
  if (value === null) {
    return {
      id: assertion.id,
      description,
      kind: "metric",
      expectation: assertion.metric + " " + assertion.expect + " for " + scope,
      observed: "nothing matched " + scope,
      passed: false,
      evaluated: false,
      note: "Nothing in this capture matched, so the assertion was neither met nor missed.",
    };
  }

  return {
    id: assertion.id,
    description,
    kind: "metric",
    expectation: assertion.metric + " " + assertion.expect + " for " + scope,
    observed: assertion.metric + " = " + value,
    passed: satisfies(value, comparison),
    evaluated: true,
    note: null,
  };
}

export type { Assertion };

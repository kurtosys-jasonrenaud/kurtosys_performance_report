import { concurrencyCeiling } from "./concurrency-ceiling.js";
import { duplicatePayloadWithinPage } from "./duplicate-payload-within-page.js";
import { endpointRollup } from "./endpoint-rollup.js";
import type { DetectorContext, DetectorSpec, Finding } from "./types.js";

/**
 * Every detector, as a plain array.
 *
 * Deliberately dumb: no plugin loading, no dynamic discovery, no registration
 * side effects. A detector exists because it is imported and listed here, which
 * means the set is greppable and the build knows about all of it.
 */
export const allDetectors: readonly DetectorSpec[] = [
  duplicatePayloadWithinPage,
  concurrencyCeiling,
  endpointRollup,
];

export interface DetectorRunResult {
  readonly findings: Finding[];
  /**
   * Metrics keyed by detector id, so two detectors emitting a field of the same
   * name cannot overwrite each other.
   */
  readonly metrics: Record<string, Record<string, unknown>>;
  /** Which detector versions produced this, for comparison across runs. */
  readonly detectorVersions: Record<string, number>;
}

/**
 * Run detectors over one capture and merge their results.
 *
 * Exceptions are not caught. A detector that throws is a bug in our code, not a
 * property of the capture, and swallowing it would produce a report that looks
 * complete while silently missing a whole class of finding.
 */
export function runDetectors(
  context: DetectorContext,
  specs: readonly DetectorSpec[] = allDetectors,
): DetectorRunResult {
  const findings: Finding[] = [];
  const metrics: Record<string, Record<string, unknown>> = {};
  const detectorVersions: Record<string, number> = {};

  for (const spec of specs) {
    const result = spec.run(context);
    findings.push(...result.findings);
    if (result.metrics !== undefined) metrics[spec.id] = result.metrics;
    detectorVersions[spec.id] = spec.version;
  }

  // Detectors already sort their own findings; this makes the merged order
  // independent of the order the specs were listed in, so adding a detector
  // cannot reshuffle another's findings in a stored run record.
  findings.sort((a, b) => {
    if (a.detectorId !== b.detectorId) return a.detectorId < b.detectorId ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });

  return { findings, metrics, detectorVersions };
}

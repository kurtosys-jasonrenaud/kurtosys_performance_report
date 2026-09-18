/// <reference lib="webworker" />
import {
  buildRouteLookup,
  buildRunRecordCore,
  normaliseHar,
  parseHar,
  runDetectors,
  type HarParseResult,
  type NormaliseResult,
} from "@kurtosys/har-insights";
import type {
  AnalyseRequest,
  ConcurrencySummary,
  EndpointRow,
  PageRow,
  ReportModel,
  WorkerMessage,
} from "./protocol.js";

/**
 * Parsing and analysis, off the main thread.
 *
 * Everything expensive happens here so the page stays usable: a person can keep
 * typing the metadata for a capture while that capture is still being parsed.
 * On a 67MB file the string and the object graph it becomes are the whole
 * memory story, and both stay on this side of the boundary.
 */

const post = (message: WorkerMessage): void => {
  self.postMessage(message);
};

self.onmessage = (event: MessageEvent<AnalyseRequest>) => {
  const request = event.data;
  if (request?.kind !== "analyse") return;
  void analyse(request.file);
};

async function analyse(file: File): Promise<void> {
  try {
    const started = performance.now();

    post({ kind: "progress", phase: "reading", note: "Reading the file" });
    // Held in a let so it can be released the moment it is no longer needed.
    let text: string | null = await file.text();
    const afterRead = performance.now();

    post({ kind: "progress", phase: "parsing", note: "Parsing the capture" });
    let parsed: HarParseResult | null = parseHar(text);
    // The raw text is the single largest object in play. Drop the reference as
    // soon as it has been parsed rather than holding it alongside the object
    // graph it produced — on a large capture, holding both is the difference
    // between comfortable and out of memory.
    text = null;
    const afterParse = performance.now();

    post({ kind: "progress", phase: "normalising", note: "Normalising entries" });
    const model: NormaliseResult = normaliseHar(parsed);
    // Same again: the raw HAR shapes are no longer needed once normalisation has
    // taken copies of what it wants, and they are the second largest graph here.
    parsed = null;
    const afterNormalise = performance.now();

    post({ kind: "progress", phase: "detecting", note: "Running detectors" });
    const detectors = runDetectors(model);
    const afterDetect = performance.now();

    const recordCore = buildRunRecordCore(model, detectors);
    const afterRecord = performance.now();

    post({
      kind: "done",
      model: buildReportModel(file, model, detectors, recordCore, {
        readMs: afterRead - started,
        parseMs: afterParse - afterRead,
        normaliseMs: afterNormalise - afterParse,
        detectMs: afterDetect - afterNormalise,
        recordMs: afterRecord - afterDetect,
        totalMs: afterRecord - started,
      }),
    });
  } catch (error: unknown) {
    post({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildReportModel(
  file: File,
  model: NormaliseResult,
  detectors: ReturnType<typeof runDetectors>,
  recordCore: ReportModel["recordCore"],
  timings: ReportModel["timings"],
): ReportModel {
  const routeOf = buildRouteLookup(model.pages);
  const captureStart = model.capture.startedAt;

  const pages: PageRow[] = model.pages.map((page) => ({
    pageRef: page.pageRef,
    // The route, never page.title: Chrome writes the page URL into the title,
    // query string and session token included.
    route: routeOf(page.pageRef),
    requests: page.entryCount,
    onLoadMs: page.onLoadMs,
    onContentLoadMs: page.onContentLoadMs,
    durationMs: page.durationMs,
    transferBytes: page.transferBytes,
    startOffsetMs: page.firstEntryAt - captureStart,
    endOffsetMs: page.lastEntryEndAt - captureStart,
    firstJsonResponseMs: page.firstJsonResponseMs,
    lastJsonResponseMs: page.lastJsonResponseMs,
  }));

  const rollup = detectors.metrics["endpoint-rollup"];
  const endpoints = (rollup?.["endpoints"] as EndpointRow[] | undefined) ?? [];

  const concurrency = (detectors.metrics["concurrency-ceiling"] ??
    {}) as unknown as ConcurrencySummary;

  return {
    fileName: file.name,
    fileBytes: file.size,
    timings,
    capture: model.capture,
    diagnostics: [...model.diagnostics],
    pages,
    endpoints,
    concurrency,
    findings: [...detectors.findings],
    detectorVersions: detectors.detectorVersions,
    recordCore,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactElement } from "react";
import {
  MissingMetadataError,
  compareRuns,
  finaliseRunRecord,
  type ComparisonResult,
  type RunMetadata,
  type RunRecord,
  type RunWorkload,
} from "@kurtosys/har-insights";
import { Comparison } from "./ui/Comparison.js";
import type { Phase, ReportModel, WorkerMessage } from "./worker/protocol.js";
import { bytes, count, ms, optionalMs, statusSummary } from "./ui/format.js";

type Status =
  | { kind: "idle" }
  | { kind: "working"; phase: Phase; note: string; fileName: string }
  | { kind: "ready"; model: ReportModel }
  | { kind: "failed"; message: string };

interface MetadataForm {
  client: string;
  environment: string;
  /** Used only when environment is "other". */
  environmentOther: string;
  build: string;
  ticket: string;
  journey: string;
  accountCount: string;
  emulated: string;
  asOfDate: string;
  notes: string;
}

/** Today, as yyyy-mm-dd in local time. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}

const ENVIRONMENTS = ["development", "staging", "production", "other"] as const;

/**
 * Sensible starting points, so the common case is a glance rather than typing.
 * Build and as-at both default to today because that is what they usually are
 * when somebody is capturing right now.
 */
const EMPTY_FORM: MetadataForm = {
  client: "",
  environment: "production",
  environmentOther: "",
  build: today(),
  ticket: "",
  journey: "full site investigation",
  accountCount: "",
  emulated: "",
  asOfDate: today(),
  notes: "",
};

const PHASE_LABEL: Record<Phase, string> = {
  reading: "Reading the file",
  parsing: "Parsing the capture",
  normalising: "Normalising entries",
  detecting: "Running detectors",
  done: "Done",
};

export default function App(): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [form, setForm] = useState<MetadataForm>(EMPTY_FORM);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [verification, setVerification] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [beforeRecord, setBeforeRecord] = useState<RunRecord | null>(null);
  const [afterRecord, setAfterRecord] = useState<RunRecord | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const lastRecordRef = useRef<RunRecord | null>(null);

  /**
   * Build the worker up front, at page load, rather than when a file is chosen.
   *
   * Two reasons. It keeps the promise on the tin honest — once this page has
   * loaded it makes no network requests at all, and a worker constructed later
   * would have to fetch its own script. And it means the first capture starts
   * parsing immediately instead of waiting for a module to arrive.
   */
  const spawnWorker = useCallback((): Worker => {
    const worker = new Worker(new URL("./worker/parse.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        setStatus((current) =>
          current.kind === "working"
            ? { ...current, phase: message.phase, note: message.note }
            : current,
        );
      } else if (message.kind === "done") {
        busyRef.current = false;
        setStatus({ kind: "ready", model: message.model });
      } else {
        busyRef.current = false;
        setStatus({ kind: "failed", message: message.message });
      }
    };
    worker.onerror = (event) => {
      busyRef.current = false;
      setStatus({ kind: "failed", message: event.message || "The worker failed." });
    };

    return worker;
  }, []);

  useEffect(() => {
    workerRef.current = spawnWorker();
    return () => workerRef.current?.terminate();
  }, [spawnWorker]);

  const analyse = useCallback(
    (file: File) => {
      setRecordError(null);
      setVerification(null);
      setStatus({ kind: "working", phase: "reading", note: "Starting", fileName: file.name });

      // A worker mid-parse is holding the previous capture. Replacing it is the
      // only way to stop that work and release the memory; an idle one is
      // reused, which is the common path and costs nothing.
      if (busyRef.current || workerRef.current === null) {
        workerRef.current?.terminate();
        workerRef.current = spawnWorker();
      }
      busyRef.current = true;

      // The File itself crosses the boundary, not its text. Files are
      // structured-cloneable and the underlying data is not copied, so this page
      // never holds the capture in memory at all.
      workerRef.current.postMessage({ kind: "analyse", file });
    },
    [spawnWorker],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) analyse(file);
    },
    [analyse],
  );

  const model = status.kind === "ready" ? status.model : null;

  const metadata = useMemo<RunMetadata>(
    () => ({
      client: form.client,
      environment:
        form.environment === "other" ? form.environmentOther : form.environment,
      build: form.build,
      ticket: form.ticket,
      journey: form.journey,
      recordedAt: new Date().toISOString(),
      ...(form.notes.trim() === "" ? {} : { notes: form.notes }),
    }),
    [form],
  );

  /**
   * The confounders. Null means not recorded, which is a different statement
   * from zero or false and is carried through as such.
   */
  const workload = useMemo<RunWorkload>(
    () => ({
      accountCount: form.accountCount.trim() === "" ? null : Number(form.accountCount),
      emulated: form.emulated === "" ? null : form.emulated === "yes",
      asOfDate: form.asOfDate.trim() === "" ? null : form.asOfDate.trim(),
    }),
    [form],
  );

  const downloadRecord = useCallback(() => {
    if (!model) return;
    setRecordError(null);
    setVerification(null);
    try {
      const record = finaliseRunRecord(model.recordCore, metadata, workload);
      lastRecordRef.current = record;
      const text = JSON.stringify(record, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        [record.metadata.client, record.metadata.environment, record.metadata.ticket]
          .join("-")
          .replace(/[^a-zA-Z0-9-]+/g, "-")
          .toLowerCase() + ".run-record.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      setRecordError(
        error instanceof MissingMetadataError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }, [model, metadata, workload]);

  const loadRecord = useCallback(
    async (file: File, slot: "before" | "after") => {
      setComparisonError(null);
      try {
        const loaded = JSON.parse(await file.text()) as RunRecord;
        if (typeof loaded?.schemaVersion !== "number") {
          throw new Error("That file is not a run record.");
        }
        if (slot === "before") setBeforeRecord(loaded);
        else setAfterRecord(loaded);
      } catch (error: unknown) {
        setComparisonError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  /** Use the capture currently open as the later half of the comparison. */
  const useCurrentAsAfter = useCallback(() => {
    if (!model) return;
    setComparisonError(null);
    try {
      setAfterRecord(finaliseRunRecord(model.recordCore, metadata, workload));
    } catch (error: unknown) {
      setComparisonError(
        error instanceof MissingMetadataError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }, [model, metadata, workload]);

  const comparison = useMemo<ComparisonResult | null>(
    () =>
      beforeRecord !== null && afterRecord !== null
        ? compareRuns(beforeRecord, afterRecord)
        : null,
    [beforeRecord, afterRecord],
  );

  /** Read a downloaded record back and check it against the one we emitted. */
  const verifyRecord = useCallback(async (file: File) => {
    const emitted = lastRecordRef.current;
    if (!emitted) {
      setVerification("Download a record first, then re-import it here to check it.");
      return;
    }
    const reimported = JSON.parse(await file.text()) as RunRecord;
    const same = JSON.stringify(reimported) === JSON.stringify(emitted);
    setVerification(
      same
        ? "Round trip is clean: the re-imported record is byte-identical to the one we emitted."
        : "Mismatch: the re-imported record differs from the one we emitted.",
    );
  }, []);

  return (
    <main>
      <header className="masthead">
        <h1>HAR performance report</h1>
        <p className="lede">
          Captures are parsed entirely in your browser. Nothing is uploaded, and request
          bodies never leave the worker that read them.
        </p>
      </header>

      <section className="panel">
        <h2>Pick a capture</h2>
        <div
          className={dragging ? "dropzone dragging" : "dropzone"}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>Drop a .har file here</p>
          <p className="muted">or</p>
          {/* A visible input, not drop-only: a drop zone alone is unusable from
              the keyboard. */}
          <label className="file-input">
            <span>Choose a file</span>
            <input
              type="file"
              accept=".har,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) analyse(file);
              }}
            />
          </label>
        </div>

        {status.kind === "working" && (
          <div className="progress" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>
              {PHASE_LABEL[status.phase]} — {status.fileName}
            </span>
            <p className="muted">
              This page stays responsive while that runs. Filling in the details below now
              saves a step.
            </p>
          </div>
        )}

        {status.kind === "failed" && (
          <p className="error" role="alert">
            We could not read that file: {status.message}
          </p>
        )}
      </section>

      <MetadataPanel
        form={form}
        onChange={setForm}
        onDownload={downloadRecord}
        canDownload={model !== null}
        error={recordError}
        verification={verification}
        onVerify={verifyRecord}
      />

      <ComparePanel
        before={beforeRecord}
        after={afterRecord}
        onLoad={loadRecord}
        onUseCurrent={useCurrentAsAfter}
        canUseCurrent={model !== null}
        error={comparisonError}
      />

      {comparison && <Comparison result={comparison} />}

      {model && <Report model={model} />}
    </main>
  );
}

function MetadataPanel(props: {
  form: MetadataForm;
  onChange: (form: MetadataForm) => void;
  onDownload: () => void;
  canDownload: boolean;
  error: string | null;
  verification: string | null;
  onVerify: (file: File) => void;
}): ReactElement {
  const { form, onChange } = props;

  const field = (
    name: keyof MetadataForm,
    label: string,
    placeholder: string,
    required: boolean,
  ) => (
    <label key={name}>
      <span>
        {label}
        {required ? <em className="required"> required</em> : <em className="optional"> optional</em>}
      </span>
      <input
        value={form[name]}
        placeholder={placeholder}
        aria-required={required}
        onChange={(event) => onChange({ ...form, [name]: event.target.value })}
      />
    </label>
  );

  return (
    <section className="panel">
      <h2>Run record details</h2>
      <p className="muted">
        A capture cannot tell us any of this, and a record without it is worthless in six
        months — we would not know whose system it was or what was being done. Client,
        environment, build and journey are required; everything else helps and can wait.
      </p>
      <div className="fields">
        {field("client", "Client", "Example Client", true)}

        <label>
          <span>
            Environment<em className="required"> required</em>
          </span>
          <select
            value={form.environment}
            onChange={(event) => onChange({ ...form, environment: event.target.value })}
          >
            {ENVIRONMENTS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {form.environment === "other" &&
          field("environmentOther", "Which environment", "name it", true)}

        {field("build", "Build", today(), true)}
        {field("journey", "Journey", "full site investigation", true)}
        {field("ticket", "Ticket", "HV-1512", false)}
        {field("accountCount", "Account count", "we cannot derive this", false)}
        {field("emulated", "Emulated session", "yes or no", false)}
        {field("asOfDate", "As-at date", today(), false)}
        {field("notes", "Notes", "anything worth remembering", false)}
      </div>

      <div className="actions">
        <button type="button" onClick={props.onDownload} disabled={!props.canDownload}>
          Download run record
        </button>
        <label className="file-input subtle">
          <span>Re-import to verify</span>
          <input
            type="file"
            accept=".json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onVerify(file);
            }}
          />
        </label>
      </div>

      {props.error && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
      {props.verification && <p className="note verification">{props.verification}</p>}
    </section>
  );
}

function ComparePanel(props: {
  before: RunRecord | null;
  after: RunRecord | null;
  onLoad: (file: File, slot: "before" | "after") => void;
  onUseCurrent: () => void;
  canUseCurrent: boolean;
  error: string | null;
}): ReactElement {
  const describe = (record: RunRecord | null): string =>
    record === null
      ? "nothing loaded"
      : [record.metadata.client, record.metadata.environment, record.metadata.build]
          .filter(Boolean)
          .join(" · ");

  return (
    <section className="panel">
      <h2>Compare two runs</h2>
      <p className="muted">
        Load a run record for each side. Either can be a file you saved earlier; the later
        side can also be the capture open right now.
      </p>
      <div className="fields">
        <label>
          <span>Earlier run — {describe(props.before)}</span>
          <input
            type="file"
            accept=".json"
            data-testid="record-before"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onLoad(file, "before");
            }}
          />
        </label>
        <label>
          <span>Later run — {describe(props.after)}</span>
          <input
            type="file"
            accept=".json"
            data-testid="record-after"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onLoad(file, "after");
            }}
          />
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={props.onUseCurrent} disabled={!props.canUseCurrent}>
          Use the open capture as the later run
        </button>
      </div>
      {props.error && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
    </section>
  );
}

function Report({ model }: { model: ReportModel }): ReactElement {
  return (
    <>
      <CaptureSummary model={model} />
      <Diagnostics model={model} />
      <Endpoints model={model} />
      <Pages model={model} />
      <MaxInFlight model={model} />
      <Findings model={model} />
    </>
  );
}

function CaptureSummary({ model }: { model: ReportModel }): ReactElement {
  const c = model.capture;
  return (
    <section className="panel">
      <h2>Capture</h2>
      <p className="muted">{model.fileName} · {bytes(model.fileBytes)}</p>
      <dl className="summary" data-testid="capture-stats">
        <Stat label="Entries" value={count(c.entryCount)} />
        <Stat label="Window" value={ms(c.windowMs)} />
        <Stat label="Transferred" value={bytes(c.totalTransferBytes)} />
        <Stat label="Uncompressed" value={bytes(c.totalContentBytes)} />
        <Stat label="Pages" value={count(c.pageCount)} />
        <Stat label="Unpaged entries" value={count(c.unpagedEntryIndices.length)} />
        <Stat label="Parse wall clock" value={ms(model.timings.totalMs)} />
      </dl>
      <p className="muted small">
        Read {ms(model.timings.readMs)} · parse {ms(model.timings.parseMs)} · normalise{" "}
        {ms(model.timings.normaliseMs)} · detect {ms(model.timings.detectMs)} · record{" "}
        {ms(model.timings.recordMs)}
      </p>
      {!c.complete && (
        <p className="error">
          This capture is incomplete. We recovered {count(c.recoveredEntries)} entries; the
          file is cut at character offset {c.truncatedAtCharOffset}. Every total here counts
          only what survived, so it is not comparable with a whole capture.
        </p>
      )}
      {!c.reliable && (
        <p className="error">
          More than 1% of entries were dropped for having no usable timestamp. These totals
          should not be presented as whole.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Diagnostics({ model }: { model: ReportModel }): ReactElement {
  return (
    <section className="panel">
      <h2>Diagnostics</h2>
      <p className="muted">
        These qualify every number below them. Read them first.
      </p>
      {model.diagnostics.length === 0 ? (
        <p className="note">Nothing to flag — the capture parsed whole and complete.</p>
      ) : (
        <ul className="diagnostics">
          {model.diagnostics.map((diagnostic, index) => (
            <li key={diagnostic.code + index} className={"severity-" + diagnostic.severity}>
              <span className="badge">{diagnostic.severity}</span>
              <div>
                <p className="code">
                  {diagnostic.code}
                  {diagnostic.count > 1 && <em> × {count(diagnostic.count)}</em>}
                </p>
                <p>{diagnostic.message}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Endpoints({ model }: { model: ReportModel }): ReactElement {
  return (
    <section className="panel">
      <h2>Endpoints</h2>
      <p className="muted">
        Grouped by path with the query string stripped, slowest first by summed duration.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th className="num">Calls</th>
              <th className="num">Summed duration</th>
              <th className="num">Transferred</th>
              <th>Statuses</th>
              <th>Methods</th>
            </tr>
          </thead>
          <tbody>
            {model.endpoints.map((row) => (
              <tr key={row.path}>
                <td className="path">{row.path}</td>
                <td className="num">{count(row.calls)}</td>
                <td className="num">
                  {ms(row.totalDurationMs)}
                  {row.unknownDurationCalls > 0 && (
                    <span className="muted small"> (+{row.unknownDurationCalls} unknown)</span>
                  )}
                </td>
                <td className="num">{bytes(row.transferBytes)}</td>
                <td>{statusSummary(row.statusDistribution)}</td>
                <td>{Object.keys(row.methods).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Pages({ model }: { model: ReportModel }): ReactElement {
  return (
    <section className="panel">
      <h2>Pages</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th className="num">Requests</th>
              <th className="num">onLoad</th>
              <th className="num">First JSON</th>
              <th className="num">Last JSON</th>
              <th className="num">Window</th>
              <th className="num">Transferred</th>
            </tr>
          </thead>
          <tbody>
            {model.pages.map((page) => (
              <tr key={page.pageRef}>
                <td className="path">
                  {page.route} <span className="muted small">{page.pageRef}</span>
                </td>
                <td className="num">{count(page.requests)}</td>
                <td className="num">{optionalMs(page.onLoadMs)}</td>
                <td className="num">{optionalMs(page.firstJsonResponseMs)}</td>
                <td className="num">{optionalMs(page.lastJsonResponseMs)}</td>
                <td className="num">{ms(page.durationMs)}</td>
                <td className="num">{bytes(page.transferBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        First and last JSON are measured from the page start to the first JSON response
        beginning and the last one ending. They are a proxy for when a page stopped setting
        itself up and started fetching data — only a proxy, because configuration and
        authentication calls answer in JSON too, so both read earlier than a figure that
        knew which endpoint carried the business data. They are named for what they measure
        so that naming stays true when profiles add that figure alongside them.
      </p>
    </section>
  );
}

function MaxInFlight({ model }: { model: ReportModel }): ReactElement {
  const f = model.inFlight;
  const busiest = f.byPath.filter((row) => row.maxInFlight > 1).slice(0, 25);

  return (
    <section className="panel">
      <h2>Maximum observed in flight</h2>
      <p className="muted">
        How many requests were open at the same moment. It is what we observed, not a limit
        anyone declared — sometimes those are the same number and sometimes they are not.
        Every maximum is shown with the number of calls it came from, because a maximum of 6
        across 21 calls and a maximum of 2 across 3 calls are not the same kind of fact.
      </p>
      <dl className="summary">
        <Stat
          label="Network requests"
          value={count(f.network.maxInFlight) + " of " + count(f.network.requests)}
        />
        <Stat label="Peak at" value={optionalMs(f.network.peakAtOffsetMs)} />
        <Stat
          label="All requests, cache included"
          value={count(f.allRequests.maxInFlight) + " of " + count(f.allRequests.requests)}
        />
        <Stat label="Excluded, unknown duration" value={count(f.excludedUnknownDuration)} />
        <Stat label="Excluded, zero duration" value={count(f.excludedZeroDuration)} />
      </dl>
      <p className="muted small">
        The network figure leads because cache hits are not competing for a connection. The
        all-requests figure counts them, which is why it runs higher and answers less.
      </p>

      <h3>By path</h3>
      <p className="muted small">
        Whatever hands out slots only shows itself among requests that share one, and
        requests sharing a path are the closest thing to that we can know without a client
        profile. Paths called once are omitted.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th className="num">Calls</th>
              <th className="num">Max in flight</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {busiest.map((row) => (
              <tr key={row.path}>
                <td className="path">{row.path}</td>
                <td className="num">{count(row.calls)}</td>
                <td className="num">
                  <strong>{count(row.maxInFlight)}</strong>
                </td>
                <td>
                  {row.source}
                  {row.source === "mixed" && (
                    <span className="muted small">
                      {" "}
                      {row.networkCalls} network, {row.cachedCalls} cached
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>By page</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th className="num">Requests</th>
              <th className="num">Max, network</th>
              <th className="num">Max, all</th>
            </tr>
          </thead>
          <tbody>
            {f.perPage.map((row) => (
              <tr key={row.pageRef}>
                <td className="path">
                  {row.route} <span className="muted small">{row.pageRef}</span>
                </td>
                <td className="num">{count(row.requests)}</td>
                <td className="num">
                  {count(row.maxInFlightNetwork)}{" "}
                  <span className="muted small">of {count(row.networkRequests)}</span>
                </td>
                <td className="num">{count(row.maxInFlight)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Findings({ model }: { model: ReportModel }): ReactElement {
  const duplicates = model.findings.filter(
    (f) => f.detectorId === "duplicate-payload-within-page",
  );
  const dataDuplicates = duplicates.filter((f) => f.evidence["responseClass"] === "data");
  const assetDuplicates = duplicates.filter((f) => f.evidence["responseClass"] !== "data");
  const saturation = model.findings.filter((f) => f.detectorId === "pool-saturation");
  const rest = model.findings.filter(
    (f) =>
      f.detectorId !== "duplicate-payload-within-page" &&
      f.detectorId !== "pool-saturation",
  );

  return (
    <section className="panel">
      <h2>Findings</h2>
      {model.findings.length === 0 && (
        <p className="note">No findings. That is a measurement, not a verdict.</p>
      )}

      <FindingGroup
        title="Repeated data requests"
        findings={dataDuplicates}
        model={model}
        note="Identical API calls issued more than once within one page. An API call issued six times is work the system did not need to do."
      />
      <FindingGroup
        title="Requests starting as slots free"
        findings={saturation}
        model={model}
        note="A request beginning the instant another on the same path completed, while that path was already at its observed maximum. A maximum reached once may be coincidence; a maximum reached repeatedly as slots free is something handing work out in batches."
      />
      <FindingGroup
        title="Repeated assets"
        findings={assetDuplicates}
        model={model}
        note="Scripts, stylesheets, images and fonts requested more than once within a page. Usually harmless, listed apart so it does not bury the rest."
      />
      <FindingGroup title="Other" findings={rest} model={model} note="" />
    </section>
  );
}

function FindingGroup({
  title, findings, model, note,
}: {
  title: string;
  findings: ReportModel["findings"];
  model: ReportModel;
  note: string;
}): ReactElement | null {
  if (findings.length === 0) return null;
  const detectorId = findings[0]?.detectorId ?? "";

  return (
    <div className="detector">
      <h3>
        {title} <span className="muted small">{findings.length}</span>
        <span className="muted small"> · {detectorId} v{model.detectorVersions[detectorId]}</span>
      </h3>
      {note !== "" && <p className="muted small">{note}</p>}
      {findings.map((finding) => (
        <article key={finding.key} className={"finding severity-" + finding.severity}>
          <header>
            <span className="badge">{finding.severity}</span>
            <p className="summary">{finding.summary}</p>
          </header>
          <p className="key">{finding.key}</p>
          <Evidence evidence={finding.evidence} />
        </article>
      ))}
    </div>
  );
}

function Evidence({ evidence }: { evidence: Record<string, unknown> }): ReactElement {
  return (
    <dl className="evidence">
      {Object.entries(evidence).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            {typeof value === "object" && value !== null ? (
              <pre>{JSON.stringify(value, null, 2)}</pre>
            ) : (
              String(value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

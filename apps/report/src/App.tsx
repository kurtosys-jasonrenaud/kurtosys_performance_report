import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactElement } from "react";
import {
  MissingMetadataError,
  finaliseRunRecord,
  type RunMetadata,
  type RunRecord,
} from "@kurtosys/har-insights";
import type { Phase, ReportModel, WorkerMessage } from "./worker/protocol.js";
import { bytes, count, ms, optionalMs, statusSummary, UNKNOWN } from "./ui/format.js";

type Status =
  | { kind: "idle" }
  | { kind: "working"; phase: Phase; note: string; fileName: string }
  | { kind: "ready"; model: ReportModel }
  | { kind: "failed"; message: string };

interface MetadataForm {
  client: string;
  environment: string;
  build: string;
  ticket: string;
  journey: string;
  accountCount: string;
  notes: string;
}

const EMPTY_FORM: MetadataForm = {
  client: "",
  environment: "",
  build: "",
  ticket: "",
  journey: "",
  accountCount: "",
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
      environment: form.environment,
      build: form.build,
      ticket: form.ticket,
      journey: form.journey,
      recordedAt: new Date().toISOString(),
      ...(form.accountCount.trim() === ""
        ? {}
        : { accountCount: Number(form.accountCount) }),
      ...(form.notes.trim() === "" ? {} : { notes: form.notes }),
    }),
    [form],
  );

  const downloadRecord = useCallback(() => {
    if (!model) return;
    setRecordError(null);
    setVerification(null);
    try {
      const record = finaliseRunRecord(model.recordCore, metadata);
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
  }, [model, metadata]);

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
  const field = (name: keyof MetadataForm, label: string, placeholder: string) => (
    <label key={name}>
      <span>{label}</span>
      <input
        value={form[name]}
        placeholder={placeholder}
        onChange={(event) => onChange({ ...form, [name]: event.target.value })}
      />
    </label>
  );

  return (
    <section className="panel">
      <h2>Run record details</h2>
      <p className="muted">
        A capture cannot tell us any of this, and a record without it is worthless in six
        months — we would not know whose system it was or what was being done. All of these
        are required.
      </p>
      <div className="fields">
        {field("client", "Client", "Example Client")}
        {field("environment", "Environment", "production")}
        {field("build", "Build", "2026.09.17-1")}
        {field("ticket", "Ticket", "HV-1512")}
        {field("journey", "Journey", "log in, open dashboard, filter documents")}
        {field("accountCount", "Account count (optional)", "we cannot derive this")}
        {field("notes", "Notes (optional)", "anything worth remembering")}
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

function Report({ model }: { model: ReportModel }): ReactElement {
  return (
    <>
      <CaptureSummary model={model} />
      <Diagnostics model={model} />
      <Endpoints model={model} />
      <Pages model={model} />
      <Concurrency model={model} />
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
              <th className="num">Setup</th>
              <th className="num">Data done</th>
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
                <td className="num">{UNKNOWN}</td>
                <td className="num">{UNKNOWN}</td>
                <td className="num">{ms(page.durationMs)}</td>
                <td className="num">{bytes(page.transferBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        Setup and data done are blank on purpose. We have the figures from manual analysis
        but not an agreed rule for computing them, and a column filled by a guess is worse
        than one left empty.
      </p>
    </section>
  );
}

function Concurrency({ model }: { model: ReportModel }): ReactElement {
  const c = model.concurrency;
  return (
    <section className="panel">
      <h2>Concurrency</h2>
      <dl className="summary">
        <Stat label="Max in flight" value={count(c.maxInFlight)} />
        <Stat label="Peak at" value={optionalMs(c.peakAtOffsetMs)} />
        <Stat label="Requests swept" value={count(c.consideredEntries)} />
        <Stat label="Excluded, unknown duration" value={count(c.excludedUnknownDuration)} />
        <Stat label="Excluded, zero duration" value={count(c.excludedZeroDuration)} />
      </dl>
      <p className="muted small">
        An observed ceiling is a measurement, not a problem. Requests that started and
        finished inside the same millisecond occupy no interval and are counted separately
        rather than swept.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th className="num">Max in flight</th>
              <th className="num">Peak at</th>
              <th className="num">Swept</th>
            </tr>
          </thead>
          <tbody>
            {c.perPage.map((row) => (
              <tr key={row.pageRef}>
                <td className="path">
                  {row.route} <span className="muted small">{row.pageRef}</span>
                </td>
                <td className="num">{count(row.maxInFlight)}</td>
                <td className="num">{optionalMs(row.peakAtOffsetMs)}</td>
                <td className="num">{count(row.consideredEntries)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Findings({ model }: { model: ReportModel }): ReactElement {
  const byDetector = new Map<string, typeof model.findings>();
  for (const finding of model.findings) {
    const group = byDetector.get(finding.detectorId);
    if (group) group.push(finding);
    else byDetector.set(finding.detectorId, [finding]);
  }

  return (
    <section className="panel">
      <h2>Findings</h2>
      {model.findings.length === 0 ? (
        <p className="note">No findings. That is a measurement, not a verdict.</p>
      ) : (
        [...byDetector.entries()].map(([detectorId, findings]) => (
          <div key={detectorId} className="detector">
            <h3>
              {detectorId}{" "}
              <span className="muted small">v{model.detectorVersions[detectorId]}</span>
            </h3>
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
        ))
      )}
    </section>
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

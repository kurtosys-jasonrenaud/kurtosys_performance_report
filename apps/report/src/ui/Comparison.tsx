import type { ReactElement } from "react";
import type {
  ComparisonResult,
  EndpointDelta,
  FindingDelta,
  MetricDelta,
  PageDelta,
  RunComparison,
} from "@kurtosys/har-insights";
import { bytes, count, ms } from "./format.js";

/**
 * Rendering a comparison.
 *
 * The ordering here is not cosmetic. Confounders and version warnings render
 * before any figure, because a reader who has already seen "43% faster" has
 * formed a belief that a caveat underneath will not undo.
 */

function signed(value: number, render: (n: number) => string): string {
  if (value === 0) return "no change";
  return (value > 0 ? "+" : "−") + render(Math.abs(value));
}

function percent(value: number | null): string {
  if (value === null) return "";
  const rounded = Math.round(value);
  return " (" + (rounded > 0 ? "+" : rounded < 0 ? "−" : "") + Math.abs(rounded) + "%)";
}

function DeltaCell({
  delta,
  render,
}: {
  delta: MetricDelta;
  render: (n: number) => string;
}): ReactElement {
  const before = render(delta.before);
  const after = render(delta.after);

  if (delta.confidence === "not-comparable") {
    return (
      <span className="delta duration not-comparable">
        <span className="pair">
          {before} → {after}
        </span>
        <em>not comparable</em>
      </span>
    );
  }

  if (delta.confidence === "indicative") {
    return (
      <span className="delta duration indicative">
        <span className="pair">
          {before} → {after}
        </span>
        <em>{delta.change === 0 ? "no change" : delta.change > 0 ? "indicative, up" : "indicative, down"}</em>
      </span>
    );
  }

  const direction = delta.change > 0 ? "up" : delta.change < 0 ? "down" : "flat";
  return (
    <span className={"delta " + delta.kind + " " + direction}>
      <span className="pair">
        {before} → {after}
      </span>
      <strong>
        {signed(delta.change, render)}
        {delta.kind === "structural" ? percent(delta.percentChange) : ""}
      </strong>
    </span>
  );
}

function Confounders({ result }: { result: RunComparison }): ReactElement | null {
  if (result.confounders.length === 0) return null;

  return (
    <section className="panel confounders" role="alert">
      <h2>Read this before the numbers</h2>
      <p>
        These runs differ in ways that change what the figures below mean. They are not a
        footnote.
      </p>
      <ul>
        {result.confounders.map((one) => (
          <li key={one.field} className={one.severe ? "severe" : ""}>
            <span className="badge">{one.field}</span>
            <div>
              <p className="pair">
                {one.before} → {one.after}
              </p>
              <p>{one.message}</p>
            </div>
          </li>
        ))}
      </ul>
      {!result.durationsComparable && (
        <p className="error">
          Every duration below is marked not comparable. A query that ran somewhere else is
          not a faster or slower version of this one, and no percentage would be honest.
          Counts, sizes and concurrency still compare, because those follow from the code.
        </p>
      )}
    </section>
  );
}

function VersionWarnings({ result }: { result: RunComparison }): ReactElement | null {
  const { guards } = result;
  if (!guards.analyzerVersionMismatch && guards.detectorVersionMismatches.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Version warnings</h2>
      {guards.analyzerVersionMismatch && (
        <p className="error">
          These records were produced by different analyser versions (
          {guards.analyzerVersionBefore} and {guards.analyzerVersionAfter}). Some of the
          movement below may be us rather than the system. The comparison continues, but
          treat it as indicative throughout.
        </p>
      )}
      {guards.detectorVersionMismatches.map((one) => (
        <p className="note" key={one.detectorId}>
          <strong>{one.detectorId}</strong> changed version (
          {one.before ?? "absent"} → {one.after ?? "absent"}). Its findings are marked not
          comparable: a detector that changed may have changed what it looks for, so a
          finding appearing or vanishing says as much about us as about the system.
        </p>
      ))}
    </section>
  );
}

function EndpointTable({ rows }: { rows: readonly EndpointDelta[] }): ReactElement {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Calls</th>
            <th>Summed duration</th>
            <th>Transferred</th>
            <th>Presence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path} className={row.presence !== "both" ? "presence-changed" : ""}>
              <td className="path">{row.path}</td>
              <td>
                <DeltaCell delta={row.calls} render={count} />
              </td>
              <td>
                <DeltaCell delta={row.duration} render={ms} />
              </td>
              <td>
                <DeltaCell delta={row.transfer} render={bytes} />
              </td>
              <td className="presence">
                {row.presence === "both"
                  ? ""
                  : row.presence === "only-before"
                    ? "gone"
                    : "new"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pages({ rows }: { rows: readonly PageDelta[] }): ReactElement {
  return (
    <section className="panel">
      <h2>Journey</h2>
      <p className="muted">
        Steps are matched on route, never on position — page refs are assigned in capture
        order and mean nothing across two files. A step present in only one run is shown as
        such rather than matched to something it is not.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th>Requests</th>
              <th>Transferred</th>
              <th>onLoad</th>
              <th>First JSON</th>
              <th>Presence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.route + index}
                className={row.presence !== "both" ? "presence-changed" : ""}
              >
                <td className="path">
                  {row.route}
                  <span className="muted small">
                    {" "}
                    {row.beforeRef ?? "—"} → {row.afterRef ?? "—"}
                  </span>
                </td>
                <td>
                  <DeltaCell delta={row.requests} render={count} />
                </td>
                <td>
                  <DeltaCell delta={row.transfer} render={bytes} />
                </td>
                <td>
                  <DeltaCell delta={row.onLoad} render={ms} />
                </td>
                <td>
                  <DeltaCell delta={row.firstJsonResponse} render={ms} />
                </td>
                <td className="presence">
                  {row.presence === "both"
                    ? ""
                    : row.presence === "only-before"
                      ? "not visited"
                      : "new step"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FindingGroup({
  title, rows, note,
}: {
  title: string;
  rows: FindingDelta[];
  note: string;
}): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="detector">
      <h3>
        {title} <span className="muted small">{rows.length}</span>
      </h3>
      <p className="muted small">{note}</p>
      {rows.map((row) => {
        const finding = row.after ?? row.before;
        return (
          <article key={row.key} className={"finding severity-" + (finding?.severity ?? "low")}>
            <header>
              <span className="badge">{finding?.severity}</span>
              <p className="summary">{finding?.summary}</p>
            </header>
            <p className="key">{row.key}</p>
            {row.severityChanged && (
              <p className="note">
                Severity moved from {row.before?.severity} to {row.after?.severity}.
              </p>
            )}
            {!row.comparable && (
              <p className="error">
                The detector that produced this changed version between the two runs, so
                this row is not comparable.
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function Comparison({ result }: { result: ComparisonResult }): ReactElement {
  if (result.outcome === "refused") {
    return (
      <section className="panel">
        <h2>We will not compare these</h2>
        <p className="error">{result.reason}</p>
      </section>
    );
  }

  const appeared = result.endpoints.filter((row) => row.presence === "only-after");
  const disappeared = result.endpoints.filter((row) => row.presence === "only-before");

  return (
    <>
      <Confounders result={result} />
      <VersionWarnings result={result} />

      <section className="panel">
        <h2>Comparing</h2>
        <p className="muted">
          {result.labels.before} → {result.labels.after}
        </p>
        <dl className="summary">
          {result.capture.map((delta) => (
            <div className="stat" key={delta.label}>
              <dt>
                {delta.label}
                <span className={"kind " + delta.kind}>{delta.kind}</span>
              </dt>
              <dd>
                <DeltaCell
                  delta={delta}
                  render={
                    delta.label.includes("transferred") || delta.label.includes("uncompressed")
                      ? bytes
                      : delta.kind === "duration"
                        ? ms
                        : count
                  }
                />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel">
        <h2>Endpoints, by size of change</h2>
        <p className="muted">
          Ranked by absolute change in call count, then by change in summed duration. A
          drop counts as much as a rise.
        </p>
        <EndpointTable rows={result.endpoints.slice(0, 40)} />
        {result.endpoints.length > 40 && (
          <p className="muted small">
            Showing the 40 largest movements of {result.endpoints.length} endpoints.
          </p>
        )}
      </section>

      {(appeared.length > 0 || disappeared.length > 0) && (
        <section className="panel">
          <h2>Appeared and disappeared</h2>
          <p className="muted">
            {appeared.length} endpoint{appeared.length === 1 ? "" : "s"} called in the later
            run only, {disappeared.length} in the earlier run only.
          </p>
          <EndpointTable rows={[...appeared, ...disappeared]} />
        </section>
      )}

      <Pages rows={result.pages} />

      <section className="panel">
        <h2>Findings</h2>
        <FindingGroup
          title="New"
          rows={result.findings.filter((f) => f.status === "new")}
          note="Present in the later run and not the earlier one."
        />
        <FindingGroup
          title="Resolved"
          rows={result.findings.filter((f) => f.status === "resolved")}
          note="Present in the earlier run and not the later one. Matched on the finding key, which identifies the subject rather than its values."
        />
        <FindingGroup
          title="Still present"
          rows={result.findings.filter((f) => f.status === "persisting")}
          note="In both runs."
        />
        {result.findings.length === 0 && (
          <p className="note">Neither run produced a finding.</p>
        )}
      </section>
    </>
  );
}

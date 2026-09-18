import type { ReactElement } from "react";
import type { ReportModel } from "../worker/protocol.js";
import { bytes, count, ms, optionalMs } from "./format.js";

/**
 * Everything a profile adds, rendered apart from everything it does not.
 *
 * These panels sit above the generic report deliberately. A profile turns
 * twenty-one anonymous POSTs into fourteen named queries, and that is what
 * somebody opened the tool to see. Nothing here replaces a generic figure —
 * the endpoint rollup, the maximums and the findings below are exactly what
 * they would be with no profile loaded.
 */
export function ProfileView({ model }: { model: ReportModel }): ReactElement | null {
  const profile = model.profile;
  if (profile === null) return null;

  const passed = profile.assertions.filter((a) => a.evaluated && a.passed).length;
  const failed = profile.assertions.filter((a) => a.evaluated && !a.passed).length;
  const unevaluated = profile.assertions.filter((a) => !a.evaluated).length;

  return (
    <>
      {profile.matchWarning !== null && (
        <section className="panel" role="alert">
          <h2>This profile may not fit this capture</h2>
          <p className="error">{profile.matchWarning}</p>
        </section>
      )}

      {profile.assertions.length > 0 && (
        <section className="panel">
          <h2>Checks</h2>
          <p className="muted">
            {profile.profileName} v{profile.profileVersion} · {passed} passed, {failed}{" "}
            failed
            {unevaluated > 0 ? ", " + unevaluated + " could not be evaluated" : ""}. A failing
            check is a statement about the system, not a reason to change a number.
          </p>
          <div className="table-scroll">
            <table className="assertions">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Expected</th>
                  <th>Observed</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {profile.assertions.map((assertion) => (
                  <tr
                    key={assertion.id}
                    className={
                      !assertion.evaluated ? "unevaluated" : assertion.passed ? "pass" : "fail"
                    }
                  >
                    <td>
                      {assertion.description}
                      <span className="muted small"> {assertion.id}</span>
                      {assertion.note !== null && (
                        <p className="muted small">{assertion.note}</p>
                      )}
                    </td>
                    <td className="path">{assertion.expectation}</td>
                    <td className="path">{assertion.observed}</td>
                    <td className="verdict">
                      {!assertion.evaluated ? "not evaluated" : assertion.passed ? "pass" : "fail"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {profile.queries.length > 0 && (
        <section className="panel">
          <h2>Queries</h2>
          <p className="muted">
            {profile.queries.length} distinct{" "}
            {profile.queries.length === 1 ? "query" : "queries"} across{" "}
            {count(profile.queries.reduce((sum, q) => sum + q.runs, 0))} executions, named by
            the profile. Slowest first.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Query</th>
                  <th className="num">Runs</th>
                  <th className="num">Summed duration</th>
                  <th>Each run</th>
                  <th className="num">Repeats</th>
                </tr>
              </thead>
              <tbody>
                {profile.queries.map((query) => (
                  <tr key={query.path + query.queryId}>
                    <td className="path">
                      {query.label}
                      {query.label !== query.queryId && (
                        <span className="muted small"> {query.queryId}</span>
                      )}
                    </td>
                    <td className="num">{count(query.runs)}</td>
                    <td className="num">{ms(query.totalDurationMs)}</td>
                    <td className="path small">
                      {query.durationsMs
                        .map((d) => (d === null ? "?" : Math.round(d) + "ms"))
                        .join(", ")}
                    </td>
                    <td className="num">
                      {query.intraPageRepeats > 0 && (
                        <span className="badge">{query.intraPageRepeats} in one page</span>
                      )}
                      {query.sessionWideRepeats > 0 && (
                        <span className="muted small">
                          {" "}
                          {query.sessionWideRepeats} session-wide
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {profile.pools.length > 0 && (
        <section className="panel">
          <h2>Dispatch pools</h2>
          <p className="muted">
            Endpoints the profile says share a dispatcher, swept together. This is the
            figure the generic detector could not reach — it needs to be told which
            endpoints belong together. The unscoped and network-only maximums below are
            unchanged.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th className="num">Calls</th>
                  <th className="num">Max in flight</th>
                  <th className="num">Peak at</th>
                  <th>Paths</th>
                </tr>
              </thead>
              <tbody>
                {profile.pools.map((pool) => (
                  <tr key={pool.pool}>
                    <td>{pool.pool}</td>
                    <td className="num">{count(pool.calls)}</td>
                    <td className="num">
                      <strong>{count(pool.maxInFlight)}</strong>
                    </td>
                    <td className="num">{optionalMs(pool.peakAtOffsetMs)}</td>
                    <td className="path small">{pool.paths.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Business timings</h2>
        <p className="muted">
          Derived from the endpoints the profile marks as business. These are NEW fields
          beside the generic first and last JSON, which keep their own meaning and are
          still reported in the page table below — a field that changes meaning between
          versions invalidates every record ever written with it.
        </p>
        <dl className="summary">
          <div className="stat">
            <dt>First business request</dt>
            <dd>{optionalMs(profile.business.firstBusinessRequestMs)}</dd>
          </div>
          <div className="stat">
            <dt>Last business response</dt>
            <dd>{optionalMs(profile.business.lastBusinessResponseMs)}</dd>
          </div>
        </dl>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th className="num">First business request</th>
                <th className="num">Last business response</th>
              </tr>
            </thead>
            <tbody>
              {profile.businessByPage.map((page) => (
                <tr key={page.pageRef}>
                  <td className="path">
                    {page.routeLabel}
                    {page.routeLabel !== page.route && (
                      <span className="muted small"> {page.route}</span>
                    )}
                  </td>
                  <td className="num">{optionalMs(page.firstBusinessRequestMs)}</td>
                  <td className="num">{optionalMs(page.lastBusinessResponseMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Hosts in this capture: {profile.hostsInCapture.length}, transferred{" "}
          {bytes(model.capture.totalTransferBytes)}.
        </p>
      </section>
    </>
  );
}

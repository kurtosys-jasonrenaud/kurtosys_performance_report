# Kurtosys performance report

A browser-based HAR analyser. It reproduces, as a repeatable computation, the
performance analysis we currently do by hand, and keeps a history of runs so
captures can be compared over time. It is for all clients, not one.

## Ground rules

**This repository is public.** Nothing client-identifying and nothing captured
from a live system belongs in it.

- **HAR captures are never committed.** They carry session tokens in request
  headers and, on emulated sessions, investor and internal email addresses in
  cleartext. `*.har` and `test/fixtures/` are gitignored, and those rules were
  the first commit in the repository's history.
- **HAR files are parsed entirely in the browser.** There is no upload endpoint
  and no server-side HAR storage. Only a small derived run record — free of
  payloads and identifiers by construction — is ever persisted or transmitted.
- **Tests use synthetic fixtures built in code.** Real captures handed over for
  validation live only in the gitignored `test/fixtures/` directory.

If you ever find a HAR staged or committed, stop and raise it. Do not quietly
rewrite history.

## Layout

```
packages/har-insights/    the analysis core
  src/parse/              tolerant HAR parsing, including truncated exports
  src/normalise/          the normalised entry / page / capture contract
  src/detect/             detectors, one file each
  src/record/             run record emitter
  test/fixtures/          GITIGNORED, never committed
apps/                     browser app and Cloudflare Worker, later phases
```

`@kurtosys/har-insights` has **no runtime dependencies** and no network or
filesystem access. It is a pure function from a parsed HAR to a result, which is
what lets it run identically in a browser, in Node and in CI. Its `tsconfig.json`
sets `"types": []` so that reaching for `fs`, `fetch` or `window` is a compile
error rather than something that works on one runtime only.

## Working on it

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit across the workspace
pnpm build
```

## Two kinds of fact

Counts and durations are not interchangeable. Request counts, payload sizes and
concurrency ceilings follow from the code and compare cleanly across
environments; query durations do not. The data model keeps that distinction, not
just the UI.

Run records carry two version stamps: `schemaVersion` for the record shape and
`analyzerVersion` for the computation. Comparisons across differing
`analyzerVersion` are flagged or refused.

The tool does not write client-facing narrative. It emits measured findings with
evidence attached. Detectors report shape; they never assert intent or cause. A
person writes the story.

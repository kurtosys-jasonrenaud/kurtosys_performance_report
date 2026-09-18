# @kurtosys/har-insights

The analysis core. A pure function from HAR text to a measured result: no
network, no filesystem, no clock, no randomness. It compiles with `"types": []`
so that reaching for `fs`, `fetch`, `Buffer` or `window` is a compile error
rather than something that works in one runtime and fails in another, and it has
no runtime dependencies. That is what lets it run identically in a browser, in
Node and in CI.

```
src/parse/       tolerant HAR reading. Raw shapes only, no interpretation.
src/normalise/   the normalised entry, page and capture contract.
src/detect/      detectors, one file each.
src/record/      the run record emitter.
```

---

## STANDING RULE: run records copy fields by allowlist, never by spread

**`NormalisedEntry.url` retains the full URL including its query string, and
query strings in these captures carry session and access tokens.** The in-browser
view model may hold that field. A run record — the artefact designed to be
stored, transmitted and shared — must never receive it.

So the run record emitter **must use an explicit allowlist** of the fields it
copies. Not a denylist. Not a spread. Not `Object.assign`.

The difference is structural, and it is the entire point:

- With an **allowlist**, a field added to `NormalisedEntry` next year is absent
  from run records until somebody deliberately adds it. The safe outcome is the
  default, and forgetting is harmless.
- With a **spread**, the next person to add a field leaks it silently. Nothing
  fails, no test goes red, and the leak ships.

This rule is not about tidiness and should not be "simplified" into a spread by
anyone optimising for fewer lines. There is a test asserting that a record built
from an entry whose query string carries a token does not contain that token
anywhere in its serialised form; if you change the emitter, that test is the one
to keep passing.

The same reasoning applies to `requestBody`, `responseBodyHash` inputs, and any
future field carrying captured content. Payload and identifiers stay in the
browser.

---

---

## STANDING RULE: a summary states what was measured, never why

A finding's `summary` states the measurement and stops there. It never states
cause, intent or remedy.

```
good: "Identical request payload issued 3 times within /dashboards/"
bad:  "Redundant call caused by two components requesting independently"
bad:  "Should be deduplicated with a request cache"
```

The second is a hypothesis. The third is advice. Neither is a measurement, and
the tool does not have the context to make either — it cannot see the code, the
release, the client's configuration or what the team already knows. A person
writes the story, using findings as evidence.

This is the rule that erodes first, because a hypothesis reads as more helpful
than a number and it is genuinely tempting to add one. It erodes the same way
every time: a word like "unnecessary", "excessive" or "should" appears in a
summary, nobody objects, and within a few months the tool is asserting causes it
cannot possibly know in front of a client. Detectors report shape. They never
assert intent or cause.

The same rule applies to `title` on a detector and to anything that ends up in a
run record.

---

## Two kinds of fact

Counts and durations do not compare the same way. Request counts, payload sizes
and concurrency ceilings follow from the code and compare cleanly across
environments. Durations are a property of the machine, the network and the day.
The model keeps the distinction rather than leaving it to the UI.

## Unknown is not zero

HAR writes `-1` for "not measured", and the package treats that carefully
because the alternative is quiet, confident wrongness:

- **`durationMs` is `number | null`.** An unknown duration is never floored to
  zero: zero asserts an instantaneous request, understating duration sums and
  giving the concurrency sweep a false end time. Null forces every consumer to
  decide, and those entries are excluded from sums and sweeps.
- **`waitMs` and `blockedMs` do floor to zero**, because they are components
  rather than whole events. The consequence is that **any sum of them is a lower
  bound, not a total**, and the `unreported-timings` diagnostic says so whenever
  it applies. Do not present a lower bound as a total.
- **Page timings keep null**, because they are never summed and "the browser did
  not report onLoad" is a different statement from "onLoad happened at zero".

The asymmetry is deliberate and documented on the fields themselves so that
nobody tidies it away.

## Blind spots are announced

Non-JSON request bodies — form-encoded, multipart, plain text — cannot be
canonicalised by key order, so their keys match only byte-identical bodies and
duplicate detection may under-report. The `non-json-request-body` diagnostic
says so. A quiet "no duplicates" is not evidence that there were none, and a
false negative is invisible to a reader in a way a false positive never is.

Likewise, when more than 1% of a capture's entries are dropped for having no
usable timestamp, the diagnostic is raised to `error` and `capture.reliable`
becomes false. Losing five entries is a footnote; losing five hundred makes
every total wrong while the report still looks finished.

## Indices

`NormalisedEntry.index` is the position in the time-sorted array and is what
findings reference. `NormalisedEntry.sourceIndex` is the position in the file's
own entries array — what to count to in DevTools or `jq` to verify a claim by
hand. Entries are mostly, but not reliably, in file order, so the two are not
interchangeable and a sorted position handed over as a file pointer sends
someone to the wrong request.

The normalise result is frozen. Entry indices are referenced by evidence, so
anything that re-sorted the array in place would invalidate stored findings
without anything failing.

Entries that declared no page are unreachable through `page.entryIndices`. They
are listed in `capture.unpagedEntryIndices`, and a detector that walks only
pages will silently miss them — a real capture had 18 unpaged entries spanning
290 seconds.

## Truncated captures

DevTools writes a HAR incrementally, so a file saved while it is still writing
ends mid-string. `parseHar` never throws: it falls back to scanning the entries
array, recovering every complete top-level object and stopping at the first one
the file cuts through. It reports `complete: false`, how many entries were
recovered, and `truncatedAtCharOffset` — named for its unit, UTF-16 code units
rather than bytes, so nobody seeks to it in a file and lands mid-character.

Totals from a recovered capture describe only what survived, and comparing them
against a complete capture is not like for like.

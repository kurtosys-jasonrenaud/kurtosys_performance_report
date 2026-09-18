import type { NormalisedPage } from "../normalise/types.js";
import { splitUrl } from "../normalise/url.js";

/** Route shown for entries that declared no page at all. */
export const NO_PAGE_ROUTE = "(no page)";

/**
 * Resolve a pageRef to a route string usable in a finding key and summary.
 *
 * The route comes from the page title's PATH when the title is a URL, which is
 * what Chrome writes there. Two things it deliberately does not do:
 *
 *   - It never keeps the title's query string, which carries tokens.
 *   - It never uses a non-URL title verbatim. A title is uncontrolled text and
 *     could be anything, including a client name; finding keys persist into run
 *     records, so an arbitrary title is not something to bake into one. Those
 *     fall back to the pageRef, which is an opaque local identifier.
 */
export function buildRouteLookup(
  pages: readonly NormalisedPage[],
): (pageRef: string | null) => string {
  const routes = new Map<string, string>();

  for (const page of pages) {
    routes.set(page.pageRef, routeForTitle(page.title, page.pageRef));
  }

  return (pageRef) => {
    if (pageRef === null) return NO_PAGE_ROUTE;
    // A pageRef that resolves to no page still groups its entries, so it is
    // used as its own route rather than being discarded.
    return routes.get(pageRef) ?? pageRef;
  };
}

function routeForTitle(title: string, pageRef: string): string {
  if (title === "") return pageRef;
  if (!title.includes("://")) return pageRef;
  const { path } = splitUrl(title);
  return path === "" ? pageRef : path;
}

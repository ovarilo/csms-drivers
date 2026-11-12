// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * http.ts -- what a REST-speaking driver does with a response it already knows
 * the CSMS answered. Internal: not exported from the package.
 *
 * ONE RULE, ONE PLACE. Drivers classify their FAILURES differently -- a
 * CitrineOS message API status is proof that nothing went on the wire, its
 * data API has an endpoint that reports a refusal with one, every
 * ev-server-lite refusal is a non-dispatch -- and those differences are real,
 * so they stay at the call sites. What they must not differ about is the half
 * after the status has been accepted: from there the request WAS answered, so
 * whether it dispatched is unknown, every failure is a plain `Error`, and none
 * of them may be a {@link CsmsNotDispatchedError}. See that class for why
 * claiming one you did not observe is as wrong as missing one.
 *
 * It was two copies for one commit in CitrineOS, and they were already
 * drifting when they were written: the body read sat inside the `fetch` try on
 * one client and outside it on the other, so the same stalled stream was a
 * driver error here and a raw abort naming nothing there. The ev-server-lite
 * driver then grew a third copy, which is why this module left `citrineos/`.
 *
 * A module of `src/shared/` imports nothing from a driver; a driver may import
 * it. Tests: `tests/shared-http.ts`.
 */

/** How much of a body a failure message carries. Enough to recognise a proxy
 *  page or a stack trace, short enough to read in a run log. */
const BODY_PREVIEW = 300;

/** That bound, applied, for a failure message built from a body a caller
 *  already holds. */
export function preview(text: string): string {
  return text.slice(0, BODY_PREVIEW);
}

/** An error's message, or the thrown value as a string. */
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The body of a response whose STATUS is already the finding.
 *
 * Best-effort on purpose: an error body that will not stream must not replace
 * the status with a different failure, so a read that fails yields a name for
 * what was there rather than throwing over the finding.
 */
export async function errorBody(res: Response): Promise<string> {
  return preview(await res.text().catch(() => "<unreadable body>"));
}

/**
 * The text of a response the CSMS answered acceptably.
 *
 * `what` names the request -- a URL, an endpoint, a method and path -- and is
 * what makes the failure traceable to a call. A stalled stream is a plain
 * `Error`: it is the case a driver must not claim a non-dispatch for. An empty
 * body is returned as `""`, for the caller to decide what it means.
 */
export async function readAnsweredText(res: Response, what: string): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new Error(
      `${what} answered ${res.status} but its body could not be read: ${reason(err)}`,
    );
  }
}

/** An answered body, parsed as JSON. A body that will not parse is a plain
 *  `Error` for the same reason as {@link readAnsweredText}. */
export function parseAnsweredBody(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what} returned unparseable body: ${preview(text)}`);
  }
}

/** {@link readAnsweredText} then {@link parseAnsweredBody}, keeping the text
 *  for a caller whose own failure message quotes it. */
export async function readAnsweredBody(
  res: Response,
  what: string,
): Promise<{ text: string; parsed: unknown }> {
  const text = await readAnsweredText(res, what);
  return { text, parsed: parseAnsweredBody(text, what) };
}

/**
 * Each `Set-Cookie` header of a response as its name and value, attributes
 * dropped, in header order. Duplicate names and empty values are kept: which
 * one wins, and whether an empty value means "absent" or "cleared", is the
 * caller's rule. A header with no name is skipped. A `Headers` without
 * `getSetCookie` (an older runtime or a hand-made fake) yields nothing.
 */
export function setCookiePairs(res: Response): [name: string, value: string][] {
  const headers = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const pairs: [string, string][] = [];
  for (const header of headers) {
    const pair = header.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== "") pairs.push([name, pair.slice(eq + 1).trim()]);
  }
  return pairs;
}

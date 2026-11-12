// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The HTTP helpers every REST-speaking driver shares (`src/shared/http.ts`):
 * what a driver does with a response once it knows the CSMS answered.
 *
 * PROPERTY, in 5 parts:
 *  1. A failure message quotes at most 300 characters of a body.
 *  2. The body of a refused response is best-effort: a stream that will not
 *     read yields a name for what was there instead of throwing over the
 *     status.
 *  3. AN ANSWERED BODY THAT WILL NOT READ OR PARSE IS A PLAIN `Error`, never a
 *     `CsmsNotDispatchedError`: the request was answered, so whether it took
 *     effect is unknown. Both messages name the request; the parse failure
 *     quotes the bounded body. An empty body reads as `""`, which is the
 *     caller's case to decide (ev-server-lite answers some calls with one).
 *  4. `reason` names a thrown value, Error or not.
 *  5. `setCookiePairs` splits each `Set-Cookie` header into its name and
 *     value, attributes dropped, in header order: duplicate names and empty
 *     values are kept, so a jar (SteVe: last wins, empty stored) and a lookup
 *     (ev-server-lite: first wins, empty is absent) keep their own rules. A
 *     header with no name is skipped, and a `Headers` without `getSetCookie`
 *     yields nothing.
 *
 * Offline: builds `Response`s in memory. Opens no socket.
 */

import { CsmsNotDispatchedError } from "@ovarilo/csms-drivers";
import {
  errorBody,
  parseAnsweredBody,
  preview,
  readAnsweredText,
  reason,
  setCookiePairs,
} from "../src/shared/http.ts";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

/** A response whose body stream errors on the first read. */
function unreadable(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("stream reset"));
    },
  });
  return new Response(body, { status });
}

async function thrown(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  return undefined;
}

// 1. The bound.
{
  const long = "x".repeat(1000);
  check(preview(long).length === 300, "1: preview keeps 300 characters of a long text");
  check(preview("short") === "short", "1: preview leaves a short text whole");
}

// 2. A refused response's body.
{
  const long = await errorBody(new Response("y".repeat(1000), { status: 502 }));
  check(long === "y".repeat(300), "2: errorBody quotes the bounded body");
  const lost = await thrown(() => errorBody(unreadable(502)));
  check(lost === undefined, "2: errorBody does not throw over the status on an unreadable body");
  check(
    (await errorBody(unreadable(502))) === "<unreadable body>",
    "2: errorBody names an unreadable body",
  );
}

// 3. An answered body.
{
  const what = "csms: GET /thing";

  check(
    (await readAnsweredText(new Response("", { status: 200 }), what)) === "",
    "3: an empty answered body reads as the empty string",
  );
  check(
    (await readAnsweredText(new Response('{"a":1}', { status: 200 }), what)) === '{"a":1}',
    "3: an answered body reads as its text",
  );

  const stalled = await thrown(() => readAnsweredText(unreadable(200), what));
  check(
    stalled instanceof Error && !(stalled instanceof CsmsNotDispatchedError),
    "3: an answered body that will not read is a plain Error, not a non-dispatch",
  );
  check(
    stalled instanceof Error &&
      stalled.message === `${what} answered 200 but its body could not be read: stream reset`,
    `3: the read failure names the request, status and cause (got ${String(stalled)})`,
  );

  check(
    JSON.stringify(parseAnsweredBody('{"a":[1]}', what)) === '{"a":[1]}',
    "3: a JSON body parses",
  );
  const garbled = await thrown(() => parseAnsweredBody(`<html>${"z".repeat(1000)}`, what));
  check(
    garbled instanceof Error && !(garbled instanceof CsmsNotDispatchedError),
    "3: an unparseable answered body is a plain Error, not a non-dispatch",
  );
  check(
    garbled instanceof Error &&
      garbled.message === `${what} returned unparseable body: ${`<html>${"z".repeat(294)}`}`,
    "3: the parse failure names the request and quotes the bounded body",
  );
}

// 4. reason.
{
  check(reason(new Error("boom")) === "boom", "4: reason gives an Error's message");
  check(reason("plain") === "plain", "4: reason stringifies a non-Error");
  check(reason(42) === "42", "4: reason stringifies a number");
}

// 5. Set-Cookie.
{
  const headers = new Headers();
  headers.append("set-cookie", "XSRF-TOKEN=abc; Path=/; SameSite=Lax");
  headers.append("set-cookie", "JSESSIONID = s1 ; HttpOnly");
  headers.append("set-cookie", "XSRF-TOKEN=; Max-Age=0");
  headers.append("set-cookie", "=orphan");
  headers.append("set-cookie", "flag");
  const pairs = setCookiePairs(new Response(null, { headers }));
  check(
    JSON.stringify(pairs) ===
      JSON.stringify([
        ["XSRF-TOKEN", "abc"],
        ["JSESSIONID", "s1"],
        ["XSRF-TOKEN", ""],
      ]),
    `5: name/value pairs in order, duplicates and empty values kept (got ${JSON.stringify(pairs)})`,
  );

  const legacy = { headers: { get: () => null } } as unknown as Response;
  check(
    setCookiePairs(legacy).length === 0,
    "5: a Headers without getSetCookie yields no pair rather than throwing",
  );
}

if (failures.length > 0) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  console.error(
    `\n${failures.length} failure(s). These helpers draw the line every REST driver ` +
      "relies on: once the CSMS answered, a body that will not read or parse is a plain " +
      "Error, never a claim that nothing was dispatched.",
  );
  process.exit(1);
}
console.log("shared http helpers: OK");

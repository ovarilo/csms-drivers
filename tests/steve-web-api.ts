// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * `SteveWebApi` (`@ovarilo/csms-drivers/steve/api-client`): what a refused
 * WebAPI request says.
 *
 * PROPERTY, in 3 parts:
 *  1. A status outside `allowed` is a plain `Error` naming the method, path
 *     and status, quoting at most 300 characters of the body.
 *  2. AN UNREADABLE ERROR BODY DOES NOT REPLACE THE STATUS. The status is the
 *     finding; a body stream that fails while the message is built yields
 *     `<unreadable body>` instead of a stream error that names no request.
 *  3. 401 and 403 say the WebAPI is off, without reading the body.
 *
 * Offline: replaces `globalThis.fetch`, which the class calls directly.
 */

import { SteveWebApi } from "@ovarilo/csms-drivers/steve/api-client";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function unreadable(status: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("stream reset"));
      },
    }),
    { status },
  );
}

async function refusal(answer: () => Response): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as unknown as typeof fetch;
  try {
    await new SteveWebApi({
      baseUrl: "http://steve.test/api/v1",
      username: "u",
      password: "p",
    }).send("DELETE", "/ocppTags/7");
  } catch (err) {
    return err;
  } finally {
    globalThis.fetch = original;
  }
  return undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 1. A refused request quotes the bounded body.
{
  const err = await refusal(() => new Response("x".repeat(1000), { status: 500 }));
  check(
    message(err) === `steve api: DELETE /ocppTags/7 returned 500: ${"x".repeat(300)}`,
    `1: a 500 names the request and quotes 300 characters (got ${message(err)})`,
  );
}

// 2. An unreadable body keeps the status.
{
  const err = await refusal(() => unreadable(502));
  check(
    message(err) === "steve api: DELETE /ocppTags/7 returned 502: <unreadable body>",
    `2: an unreadable 502 body keeps the status in the message (got ${message(err)})`,
  );
}

// 3. WebAPI off.
{
  const err = await refusal(() => unreadable(401));
  check(
    message(err).startsWith("steve api: DELETE /ocppTags/7 returned 401. WebAPI access is off"),
    `3: a 401 says the WebAPI is off (got ${message(err)})`,
  );
}

if (failures.length > 0) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  console.error(
    `\n${failures.length} failure(s). A refused SteVe WebAPI request must name its ` +
      "request and status: an error that names a body stream instead tells the reader " +
      "nothing about which call SteVe refused.",
  );
  process.exit(1);
}
console.log("steve web api: refusals keep their status.");

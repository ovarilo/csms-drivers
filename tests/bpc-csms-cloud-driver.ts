// Copyright 2026 Sukrit Jaidee
// SPDX-License-Identifier: Apache-2.0
/**
 * The bpc-csms-cloud driver: when it says a request never became an OCPP CALL,
 * when its one login is spent, and what it puts on the console's routes.
 *
 * bpc-csms-cloud runs every 1.6 operation but one through `POST /api/command`,
 * and that call BLOCKS while python-ocpp calls the station, so one HTTP answer
 * carries both halves of the question: whether the console sent the CALL, and
 * what the station said. UpdateFirmware is a firmware job, `POST
 * /api/ops/fw/update`, whose state says the same. The line between them is
 * drawn from the bodies release 1.15.1 was measured answering with, against a
 * simulated station, and from `handle_api_command` and `ops_api_fw_update`.
 *
 * PROPERTY, in 13 parts:
 *  1. AN ANSWER IS AN ANSWER. A 200 `{"success":true,"result":{...}}` resolves
 *     with the console's body as the receipt -- a `"result":{"status":
 *     "Rejected"}` included. A 200 without a `result` object, one that is not
 *     JSON, and a 2xx the driver does not know are plain `Error`s.
 *  2. REFUSED BEFORE THE CALL IS A NON-DISPATCH. 404 `Charge Point not
 *     found`, a 400 that is not `Unknown command`, 403, 429, a redirect, a
 *     `fetch` that fails to connect, a request aborted by the driver's own
 *     `dispatchTimeoutMs`, and a RemoteStartTransaction the console answered
 *     with a `reason` (it did not send it) are `CsmsNotDispatchedError`s.
 *  3. A 400 `Unknown command: …` is `UnsupportedOperationError`.
 *  4. THE NEGATIVE HALF. A 500 `Waited 30s for response on [2,…` (sent,
 *     unanswered), a 500 `'NoneType' object has no attribute 'status'` (the
 *     station's CALLERROR), any other 500, and a proxy's 502 are plain
 *     `Error`s: the CALL left, or may have.
 *  5. ONE LOGIN PER PROCESS. Concurrent drivers share one form `POST /login`,
 *     and every command carries its `csms_session` cookie.
 *  6. WHICH LOGIN FAILURES ARE KEPT. A 401 and a 429 (the server's lock-out
 *     after five wrong passwords) are kept: the next call makes no request,
 *     and the message says the process will not try again soon. A `fetch`
 *     that rejects or times out, a 503, a 200 and a redirect without the
 *     cookie are forgotten, and the next call logs in again. Kept or
 *     forgotten, each is a `CsmsNotDispatchedError`: no command was sent.
 *  7. The wire: every arm's `{cp_id, command, params}` body, member order
 *     included, and the firmware job's body.
 *  8. The arms that refuse: what the console cannot send as asked is an
 *     `UnsupportedOperationError`, and a charging-profile ref the lookup does
 *     not know or a transaction or reservation ref that is not an integer is a
 *     plain `Error`; neither posts anything. Capabilities declare every OCPP
 *     1.6 action, no OCPP 2.0.1, no charge-point administration.
 *  9. A LONG-LIVED PROCESS. A command answered 401 logs in again and is sent
 *     once more only when the session is at least a minute old; a second 401
 *     is the command's answer, and a 401 on a younger session renews nothing.
 * 10. A kept login refusal expires after fifteen minutes.
 * 11. THE SESSION IS BOUND TO THE CREDENTIAL. Two drivers of one server and
 *     account with different passwords do not share a session, and no
 *     message quotes the password.
 * 12. FIRMWARE JOBS. A job `sent`, or already past it, resolves. A job still
 *     `waiting` is cancelled, so the console does not send it again later:
 *     with nothing recorded (the station is not connected) it is a
 *     non-dispatch, after "no answer from the charger" a plain `Error`. A job
 *     `cancelled` (replaced before it was sent) is a non-dispatch; `refused`,
 *     and a 200 without a job, plain `Error`s.
 * 13. `commands.submit16` reports the station's answer as a VALUE and declares
 *     { completion: "confirmed", polling: false } with no `poll`. Any answer
 *     but Rejected/NotSupported is `confirmed`, with the station's payload
 *     rebuilt where the console reshapes it; Rejected/NotSupported is
 *     `rejected`; the CALLERROR 500 is `failed`; the `Waited` 500, a firmware
 *     job left unanswered and the driver's own deadline are `unknown`
 *     (`timeout`), never `failed`; a caller's abort is `unknown`
 *     (`no-evidence`). What never became a CALL, what the console cannot
 *     express, and any other 500 still throw as `execute` does.
 *
 * Each row gets its own server URL because the session cache is module-level
 * and keyed by server and account: a shared key would let one row's cached
 * refusal decide the next row's verdict.
 *
 * Offline: answers every request from a closure. Opens no socket.
 */

import {
  BPC_CSMS_CLOUD_CAPABILITIES,
  CSMS_OPERATION_16_ACTIONS,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  createBpcCsmsCloudCsmsDriver,
  type BpcCsmsCloudChargingProfile,
  type CommandOutcome,
  type CsmsDriver,
  type CsmsOperation16,
  type FetchLike,
} from "@ovarilo/csms-drivers";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

let rowSeq = 0;

/** A server URL no other row shares -- see the header. */
function freshUrl(): string {
  rowSeq++;
  return `http://bpc-row-${rowSeq}.test`;
}

type Classification = "answered" | "not-dispatched" | "unsupported" | "plain-error";

function classify(err: unknown): Exclude<Classification, "answered"> | "not-an-error" {
  if (err instanceof CsmsNotDispatchedError) return "not-dispatched";
  if (err instanceof UnsupportedOperationError) return "unsupported";
  if (err instanceof Error) return "plain-error";
  return "not-an-error";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The fake console
// ---------------------------------------------------------------------------

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

/** The console's login answer: a redirect home with the session cookie. */
const loggedIn =
  (cookie: string): Handler =>
  () =>
    new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": `csms_session=${cookie}; HttpOnly; Path=/; SameSite=Lax`,
      },
    });

const LOGIN_OK = loggedIn("s1");
const REFUSED: Handler = () => Promise.reject(new TypeError("connect ECONNREFUSED"));
const ABORTED: Handler = () =>
  Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
/** Never answers: rejects only when the request's own signal aborts it. */
const HANGS: Handler = (init) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const UNAUTHORIZED: Handler = () => json({ error: "Unauthorized" }, 401);

/** The station's answer, in the 200 envelope `/api/command` answers with. */
const answered =
  (result: unknown): Handler =>
  () =>
    json({ success: true, result });

/** A command that raised, in the 500 envelope `/api/command` answers with. */
const raised =
  (error: string): Handler =>
  () =>
    json({ error }, 500);

const UNANSWERED_ERROR = 'Waited 30s for response on [2,"7bd90a5d","Reset",{"type":"Soft"}].';
const CALLERROR_ERROR = "'NoneType' object has no attribute 'status'";

/** A firmware job, in the 200 envelope `/api/ops/fw/update` answers with. */
const job =
  (status: string, history: string[] = ["created by admin"]): Handler =>
  () =>
    json({
      ok: true,
      jobs: [
        {
          id: "FWU-1",
          cp: "CP1",
          url: "http://fw.test/fw.bin",
          status,
          history: history.map((text) => [1_800_000_000, text]),
        },
      ],
    });

const NO_ANSWER = "no answer from the charger - sent again when it reconnects";

interface Sent {
  readonly path: string;
  readonly body: string | undefined;
  readonly cookie: string | null;
  readonly contentType: string | null;
}

interface Server {
  readonly fetch: FetchLike;
  readonly count: { login: number; command: number; firmware: number; cancel: number };
  readonly logins: Sent[];
  readonly commands: Sent[];
  readonly cancels: Sent[];
}

interface Routes {
  login?: Handler[];
  command?: Handler[];
  firmware?: Handler[];
}

/**
 * Routes by method and path. Each route is a queue of handlers; the last one
 * repeats, so `[fail, ok]` is "fails once, then answers".
 */
function server(routes: Routes): Server {
  const count = { login: 0, command: 0, firmware: 0, cancel: 0 };
  const logins: Sent[] = [];
  const commands: Sent[] = [];
  const cancels: Sent[] = [];
  const take = (queue: Handler[] | undefined, n: number, fallback: Handler): Handler => {
    if (queue === undefined || queue.length === 0) return fallback;
    return queue[Math.min(n, queue.length - 1)]!;
  };
  const record = (path: string, init: RequestInit | undefined): Sent => {
    const headers = new Headers(init?.headers);
    return {
      path,
      body: typeof init?.body === "string" ? init.body : undefined,
      cookie: headers.get("cookie"),
      contentType: headers.get("content-type"),
    };
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(input).pathname;
    if (method !== "POST") return json({ error: "Not found" }, 404);
    switch (path) {
      case "/login":
        logins.push(record(path, init));
        return take(routes.login, count.login++, LOGIN_OK)(init);
      case "/api/command":
        commands.push(record(path, init));
        return take(routes.command, count.command++, answered({ status: "Accepted" }))(init);
      case "/api/ops/fw/update":
        commands.push(record(path, init));
        return take(routes.firmware, count.firmware++, job("sent"))(init);
      case "/api/ops/fw/cancel":
        cancels.push(record(path, init));
        count.cancel++;
        return json({ ok: true });
      default:
        return json({ error: "Not found" }, 404);
    }
  };
  return { fetch: fetchImpl, count, logins, commands, cancels };
}

const PROFILES: Readonly<Record<string, BpcCsmsCloudChargingProfile>> = {
  "tx-default": {
    chargingProfileId: 11,
    stackLevel: 2,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
    },
  },
  "cp-max": {
    chargingProfileId: 1,
    stackLevel: 0,
    chargingProfilePurpose: "ChargePointMaxProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "A",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 32 }],
    },
  },
  "tx-profile": {
    chargingProfileId: 21,
    stackLevel: 0,
    chargingProfilePurpose: "TxProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "A",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 10 }],
    },
  },
  absolute: {
    chargingProfileId: 11,
    stackLevel: 0,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Absolute",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
    },
  },
  "two-periods": {
    chargingProfileId: 11,
    stackLevel: 0,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 600, limit: 7400 },
      ],
    },
  },
  "late-start": {
    chargingProfileId: 11,
    stackLevel: 0,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 60, limit: 11000 }],
    },
  },
  "own-id": {
    chargingProfileId: 56,
    stackLevel: 0,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
    },
  },
  "with-tx": {
    chargingProfileId: 21,
    transactionId: 42,
    stackLevel: 0,
    chargingProfilePurpose: "TxProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "A",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 10 }],
    },
  },
};

const PASSWORD = "admin-Pa55";

function driverFor(url: string, srv: Server, dispatchTimeoutMs?: number): CsmsDriver {
  return createBpcCsmsCloudCsmsDriver({
    config: {
      apiUrl: url,
      username: "admin",
      password: PASSWORD,
      ...(dispatchTimeoutMs === undefined ? {} : { dispatchTimeoutMs }),
    },
    refs: { chargingProfileByRef: (ref) => PROFILES[ref] },
    fetch: srv.fetch,
  });
}

async function outcomeOf(p: Promise<unknown>): Promise<{ ok: boolean; err?: unknown }> {
  try {
    await p;
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

const RESET: CsmsOperation16 = { action: "Reset", type: "Soft" };
const FIRMWARE: CsmsOperation16 = {
  action: "UpdateFirmware",
  location: "http://fw.test/fw.bin",
  retrieveDate: new Date("2030-01-01T00:00:00.200Z"),
};

/** Runs `body` with `Date.now` moved by whatever `body` sets through `move`. */
async function withClock(body: (move: (ms: number) => void) => Promise<void>): Promise<void> {
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  try {
    await body((ms) => {
      offsetMs = ms;
    });
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------------------
// Parts 1-4: one Reset, answered every way
// ---------------------------------------------------------------------------

interface DispatchCase {
  readonly what: string;
  readonly routes: Routes;
  readonly expect: Classification;
  /** Substrings the receipt (answered) or the message (error) must carry. */
  readonly carries?: readonly string[];
  readonly dispatchTimeoutMs?: number;
  readonly operation?: CsmsOperation16;
}

async function checkDispatch(part: string, kase: DispatchCase): Promise<void> {
  const what = `${part}: ${kase.what}`;
  const srv = server(kase.routes);
  const driver = driverFor(freshUrl(), srv, kase.dispatchTimeoutMs);
  let outcome: Classification | "not-an-error";
  let text: string;
  try {
    text = await driver.operations16.execute("CP1", kase.operation ?? RESET);
    outcome = "answered";
  } catch (e) {
    text = message(e);
    outcome = classify(e);
  }
  if (outcome !== kase.expect) {
    failures.push(`${what}: expected ${kase.expect}, got ${outcome} (${text})`);
    return;
  }
  for (const s of kase.carries ?? []) {
    check(
      text.includes(s),
      `${what}: ${outcome === "answered" ? "receipt" : "message"} lacks ${JSON.stringify(s)}: ${text}`,
    );
  }
}

const ANSWER_CASES: DispatchCase[] = [
  {
    what: "200, the station Accepted",
    routes: { command: [answered({ status: "Accepted" })] },
    expect: "answered",
    carries: ['"Accepted"'],
  },
  {
    what: "200, the station Rejected",
    routes: { command: [answered({ status: "Rejected" })] },
    expect: "answered",
    carries: ['"Rejected"'],
  },
  {
    what: "200 without a result object",
    routes: { command: [() => json({ success: true })] },
    expect: "plain-error",
    carries: ["without the station's result"],
  },
  {
    what: "200 whose body is not JSON",
    routes: { command: [() => new Response("<html>proxy</html>", { status: 200 })] },
    expect: "plain-error",
    carries: ["<html>proxy</html>"],
  },
  {
    what: "a 2xx the driver does not know",
    routes: { command: [() => json({ success: true }, 201)] },
    expect: "plain-error",
    carries: ["201"],
  },
];
for (const kase of ANSWER_CASES) await checkDispatch("part 1", kase);

const NOT_DISPATCHED_CASES: DispatchCase[] = [
  {
    what: "404 Charge Point not found, the station offline",
    routes: { command: [() => json({ error: "Charge Point not found" }, 404)] },
    expect: "not-dispatched",
    carries: ["returned 404", "Charge Point not found"],
  },
  {
    what: "a 400 that is not Unknown command",
    routes: { command: [() => json({ error: "bad request" }, 400)] },
    expect: "not-dispatched",
    carries: ["returned 400"],
  },
  {
    what: "403 forbidden",
    routes: { command: [() => json({ error: "forbidden" }, 403)] },
    expect: "not-dispatched",
    carries: ["returned 403"],
  },
  {
    what: "429",
    routes: { command: [() => json({ error: "Too many requests" }, 429)] },
    expect: "not-dispatched",
    carries: ["returned 429"],
  },
  {
    what: "a redirect",
    routes: {
      command: [() => new Response(null, { status: 302, headers: { location: "/login" } })],
    },
    expect: "not-dispatched",
    carries: ["returned 302"],
  },
  {
    what: "a fetch that fails to connect",
    routes: { command: [REFUSED] },
    expect: "not-dispatched",
    carries: ["/api/command", "ECONNREFUSED"],
  },
  {
    what: "a fetch rejected with a timeout",
    routes: { command: [ABORTED] },
    expect: "not-dispatched",
    carries: ["/api/command", "timed out"],
  },
  {
    what: "a command the console holds past dispatchTimeoutMs",
    routes: { command: [HANGS] },
    dispatchTimeoutMs: 50,
    expect: "not-dispatched",
    carries: ["/api/command", "timed out after 50 ms"],
  },
  {
    what: "a remote start the console did not send",
    operation: { action: "RemoteStartTransaction", idTag: "TAG-1", connectorId: 1 },
    routes: {
      command: [
        answered({
          status: "Rejected",
          reason: "connector 1 is reserved for booking BK-1 until 18:00 (BTT)",
        }),
      ],
    },
    expect: "not-dispatched",
    carries: ["did not send it", "booking BK-1"],
  },
];
for (const kase of NOT_DISPATCHED_CASES) await checkDispatch("part 2", kase);

await checkDispatch("part 3", {
  what: "400 Unknown command",
  routes: { command: [() => json({ error: "Unknown command: reset" }, 400)] },
  expect: "unsupported",
  carries: ["Unknown command: reset"],
});

const SENT_CASES: DispatchCase[] = [
  {
    what: "500 for a CALL the station left unanswered",
    routes: { command: [raised(UNANSWERED_ERROR)] },
    expect: "plain-error",
    carries: ["returned 500", "Waited 30s"],
  },
  {
    what: "500 for the station's CALLERROR",
    routes: { command: [raised(CALLERROR_ERROR)] },
    expect: "plain-error",
    carries: ["NoneType"],
  },
  {
    what: "any other 500",
    routes: { command: [raised("division by zero")] },
    expect: "plain-error",
    carries: ["division by zero"],
  },
  {
    what: "502 from a proxy in front of the console",
    routes: { command: [() => new Response("<html>bad gateway</html>", { status: 502 })] },
    expect: "plain-error",
    carries: ["returned 502", "bad gateway"],
  },
];
for (const kase of SENT_CASES) await checkDispatch("part 4", kase);

// ---------------------------------------------------------------------------
// Parts 5-6: the login
// ---------------------------------------------------------------------------

/** Two drivers of one fresh server in turn: the second sees whatever the
 *  first left in the session cache. */
async function twoCalls(routes: Routes) {
  const url = freshUrl();
  const srv = server(routes);
  const first = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  const second = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  return { first, second, srv };
}

{
  const what = "part 5: three concurrent drivers";
  const url = freshUrl();
  const srv = server({});
  const results = await Promise.all(
    [0, 1, 2].map(() => outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET))),
  );
  check(
    results.every((r) => r.ok),
    `${what}: expected all three to succeed: ${results.map((r) => message(r.err)).join("; ")}`,
  );
  check(srv.count.login === 1, `${what}: expected one login, got ${srv.count.login}`);
  check(
    srv.logins[0]?.contentType === "application/x-www-form-urlencoded" &&
      srv.logins[0]?.body === `username=admin&password=${PASSWORD}`,
    `${what}: the login must be the console's form post, got ${JSON.stringify(srv.logins[0])}`,
  );
  check(
    srv.commands.every((c) => c.cookie === "csms_session=s1"),
    `${what}: every command must carry the session cookie, got ${srv.commands.map((c) => c.cookie).join(", ")}`,
  );
}

const FORGOTTEN: { what: string; handler: Handler }[] = [
  { what: "login whose fetch rejects", handler: REFUSED },
  { what: "login aborted by its own timeout", handler: ABORTED },
  { what: "login refused 503", handler: () => new Response("down", { status: 503 }) },
  { what: "login answered 200, the form again", handler: () => new Response("<form>") },
  {
    what: "login redirected without the session cookie",
    handler: () => new Response(null, { status: 302, headers: { location: "/" } }),
  },
];
for (const { what: name, handler } of FORGOTTEN) {
  const what = `part 6: ${name} is forgotten`;
  const { first, second, srv } = await twoCalls({ login: [handler, LOGIN_OK] });
  if (first.ok) {
    failures.push(`${what}: the first call was expected to fail`);
    continue;
  }
  check(
    classify(first.err) === "not-dispatched",
    `${what}: expected a non-dispatch, got ${classify(first.err)} (${message(first.err)})`,
  );
  check(
    !message(first.err).includes("will not try again"),
    `${what}: the first failure claims it will not retry: ${message(first.err)}`,
  );
  check(second.ok, `${what}: the second call did not log in again: ${message(second.err)}`);
  check(srv.count.login === 2, `${what}: expected 2 logins, got ${srv.count.login}`);
}

const KEPT: { what: string; handler: Handler }[] = [
  {
    what: "login refused 401",
    handler: () => new Response("Invalid username or password", { status: 401 }),
  },
  {
    what: "login refused 429, the address locked out",
    handler: () => new Response("Too many failed attempts", { status: 429 }),
  },
];
for (const { what: name, handler } of KEPT) {
  const what = `part 6: ${name} is kept`;
  const { first, second, srv } = await twoCalls({ login: [handler, LOGIN_OK] });
  if (first.ok || second.ok) {
    failures.push(`${what}: both calls were expected to fail`);
    continue;
  }
  for (const [which, err] of [
    ["first", first.err],
    ["second", second.err],
  ] as const) {
    check(
      classify(err) === "not-dispatched",
      `${what}: the ${which} call: expected a non-dispatch, got ${classify(err)} (${message(err)})`,
    );
  }
  check(
    message(first.err).includes("will not try again"),
    `${what}: the message does not say the process will not retry: ${message(first.err)}`,
  );
  check(
    srv.count.login === 1 && srv.count.command === 0,
    `${what}: expected 1 login and no command, got ${srv.count.login} and ${srv.count.command}`,
  );
}

// ---------------------------------------------------------------------------
// Parts 7-8: the wire and the refusing arms
// ---------------------------------------------------------------------------

/** The one request `operation` posts, or undefined when it posted none. */
async function requestSent(operation: CsmsOperation16): Promise<Sent | undefined> {
  const srv = server({});
  await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP1", operation));
  return srv.commands[0];
}

const cmd = (command: string, params: string): string =>
  `{"cp_id":"CP1","command":"${command}","params":${params}}`;

const WIRE_CASES: readonly { operation: CsmsOperation16; body: string; path?: string }[] = [
  { operation: RESET, body: cmd("reset", '{"type":"Soft"}') },
  {
    operation: { action: "UnlockConnector", connectorId: 2 },
    body: cmd("unlock", '{"connector_id":2}'),
  },
  { operation: { action: "ClearCache" }, body: cmd("clear_cache", "{}") },
  {
    operation: { action: "ChangeAvailability", connectorId: 0, type: "Inoperative" },
    body: cmd("availability", '{"connector_id":0,"type":"Inoperative"}'),
  },
  { operation: { action: "GetConfiguration" }, body: cmd("get_config", "{}") },
  { operation: { action: "GetConfiguration", keys: [] }, body: cmd("get_config", "{}") },
  {
    operation: { action: "GetConfiguration", keys: ["HeartbeatInterval"] },
    body: cmd("get_config", '{"keys":["HeartbeatInterval"]}'),
  },
  {
    operation: { action: "ChangeConfiguration", key: "HeartbeatInterval", value: "60" },
    body: cmd("set_config", '{"key":"HeartbeatInterval","value":"60"}'),
  },
  {
    operation: { action: "RemoteStartTransaction", idTag: "TAG-1", connectorId: 2 },
    body: cmd("remote_start", '{"id_tag":"TAG-1","connector_id":2}'),
  },
  {
    operation: { action: "RemoteStopTransaction", transaction: "42" },
    body: cmd("remote_stop", '{"transaction_id":42}'),
  },
  {
    operation: { action: "TriggerMessage", requestedMessage: "Heartbeat" },
    body: cmd("trigger", '{"message":"Heartbeat"}'),
  },
  {
    operation: { action: "TriggerMessage", requestedMessage: "StatusNotification", connectorId: 1 },
    body: cmd("trigger", '{"message":"StatusNotification","connector_id":1}'),
  },
  {
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "tx-default" },
    body: cmd(
      "set_profile",
      '{"connector_id":1,"limit":11000,"purpose":"TxDefaultProfile","stack_level":2,"rate_unit":"W"}',
    ),
  },
  {
    operation: { action: "SetChargingProfile", connectorId: 0, chargingProfile: "cp-max" },
    body: cmd(
      "set_profile",
      '{"connector_id":0,"limit":32,"purpose":"ChargePointMaxProfile","stack_level":0,"rate_unit":"A"}',
    ),
  },
  {
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "tx-profile" },
    body: cmd(
      "set_profile",
      '{"connector_id":1,"limit":10,"purpose":"TxProfile","stack_level":0,"rate_unit":"A"}',
    ),
  },
  {
    // An empty transaction ref is a lookup that found none: sent unscoped.
    operation: {
      action: "SetChargingProfile",
      connectorId: 1,
      chargingProfile: "tx-profile",
      transaction: "",
    },
    body: cmd(
      "set_profile",
      '{"connector_id":1,"limit":10,"purpose":"TxProfile","stack_level":0,"rate_unit":"A"}',
    ),
  },
  {
    operation: { action: "GetCompositeSchedule", connectorId: 1, duration: 600 },
    body: cmd("get_composite", '{"connector_id":1,"duration":600}'),
  },
  {
    operation: { action: "ClearChargingProfile", chargingProfile: "tx-default" },
    body: cmd("clear_profile", '{"charging_profile_id":11}'),
  },
  {
    operation: {
      action: "ClearChargingProfile",
      connectorId: 1,
      purpose: "TxDefaultProfile",
      stackLevel: 0,
    },
    body: cmd(
      "clear_profile",
      '{"connector_id":1,"charging_profile_purpose":"TxDefaultProfile","stack_level":0}',
    ),
  },
  {
    operation: {
      action: "GetDiagnostics",
      location: "ftp://diag.test/upload",
      startTime: new Date("2030-01-01T00:00:00Z"),
      stopTime: new Date("2030-01-02T00:00:00Z"),
      retries: 2,
      retryInterval: 60,
    },
    body: cmd(
      "get_diagnostics",
      '{"location":"ftp://diag.test/upload","start_time":"2030-01-01T00:00:00.000Z",' +
        '"stop_time":"2030-01-02T00:00:00.000Z","retries":2,"retry_interval":60}',
    ),
  },
  { operation: { action: "GetLocalListVersion" }, body: cmd("get_local_list", "{}") },
  {
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Full",
      localAuthorizationList: [{ idTag: "TAG-A" }, { idTag: "TAG-B", status: "Accepted" }],
    },
    body: cmd("send_local_list", '{"version":2,"type":"Full","tags":["TAG-A","TAG-B"]}'),
  },
  {
    operation: { action: "SendLocalList", listVersion: 3, updateType: "Full" },
    body: cmd("send_local_list", '{"version":3,"type":"Full","tags":[]}'),
  },
  {
    operation: {
      action: "SendLocalList",
      listVersion: 4,
      updateType: "Differential",
      localAuthorizationList: [{ idTag: "TAG-C", status: "Accepted" }],
    },
    body: cmd("send_local_list", '{"version":4,"type":"Differential","tags":["TAG-C"]}'),
  },
  {
    operation: { action: "CancelReservation", reservation: "7" },
    body: cmd("cancel_reserve", '{"reservation_id":7}'),
  },
  {
    operation: { ...FIRMWARE, retries: 2, retryInterval: 60 } as CsmsOperation16,
    path: "/api/ops/fw/update",
    body:
      '{"cps":["CP1"],"url":"http://fw.test/fw.bin","retrieve":"2030-01-01T00:00:01.000Z",' +
      '"retries":2,"interval":60}',
  },
  {
    // No retries: the console sends its own, which the driver does not refuse.
    operation: FIRMWARE,
    path: "/api/ops/fw/update",
    body: '{"cps":["CP1"],"url":"http://fw.test/fw.bin","retrieve":"2030-01-01T00:00:01.000Z"}',
  },
];
for (const { operation, body, path = "/api/command" } of WIRE_CASES) {
  const what = `part 7: ${operation.action} ${JSON.stringify(operation)}`;
  const sent = await requestSent(operation);
  check(sent?.path === path, `${what}: posted to ${String(sent?.path)}, expected ${path}`);
  check(sent?.body === body, `${what}: posted ${String(sent?.body)}, expected ${body}`);
  check(
    sent?.cookie === "csms_session=s1" && sent.contentType === "application/json",
    `${what}: cookie ${String(sent?.cookie)}, content-type ${String(sent?.contentType)}`,
  );
}

await withClock(async (move) => {
  // The duration the console turns into expiryDate, rounded up.
  move(0);
  const now = Date.now();
  for (const [what, operation, id] of [
    [
      "ReserveNow with a reservation ref",
      {
        action: "ReserveNow",
        connectorId: 1,
        idTag: "TAG-1",
        expiryDate: new Date(now + 600_000 - 300),
        reservation: "7",
      },
      7,
    ],
    [
      "ReserveNow without a reservation ref",
      { action: "ReserveNow", connectorId: 1, idTag: "TAG-1", expiryDate: new Date(now + 600_000) },
      undefined,
    ],
  ] as [string, CsmsOperation16, number | undefined][]) {
    const sent = await requestSent(operation);
    const params = (
      sent?.body === undefined ? undefined : (JSON.parse(sent.body) as { params?: unknown })
    )?.params as Record<string, unknown> | undefined;
    check(
      params?.connector_id === 1 && params.id_tag === "TAG-1",
      `part 7: ${what}: posted ${String(sent?.body)}`,
    );
    check(
      typeof params?.reservation_id === "number" &&
        Number.isInteger(params.reservation_id) &&
        (id === undefined || params.reservation_id === id),
      `part 7: ${what}: expected ${id === undefined ? "an allocated integer" : id} reservation_id, got ${String(sent?.body)}`,
    );
    check(
      params?.expiry_seconds === 600,
      `part 7: ${what}: expected 600 expiry_seconds, got ${String(sent?.body)}`,
    );
  }
});

interface RefusalCase {
  readonly what: string;
  readonly operation: CsmsOperation16;
  readonly expect: "unsupported" | "plain-error";
  readonly carries: string;
}

const PAST = new Date(Date.now() - 60_000);

const REFUSAL_CASES: RefusalCase[] = [
  {
    what: "a RemoteStart without a connector",
    operation: { action: "RemoteStartTransaction", idTag: "TAG-1" },
    expect: "unsupported",
    carries: "always names the connector",
  },
  {
    what: "a RemoteStart on connector 0",
    operation: { action: "RemoteStartTransaction", idTag: "TAG-1", connectorId: 0 },
    expect: "unsupported",
    carries: "always names the connector",
  },
  {
    what: "a RemoteStart with a charging profile",
    operation: {
      action: "RemoteStartTransaction",
      idTag: "TAG-1",
      connectorId: 1,
      chargingProfile: "tx-profile",
    },
    expect: "unsupported",
    carries: "no charging profile",
  },
  {
    what: "a TriggerMessage on connector 0",
    operation: { action: "TriggerMessage", requestedMessage: "MeterValues", connectorId: 0 },
    expect: "unsupported",
    carries: "drops a connectorId of 0",
  },
  {
    what: "an Absolute profile",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "absolute" },
    expect: "unsupported",
    carries: "kind Relative",
  },
  {
    what: "a profile of two periods",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "two-periods" },
    expect: "unsupported",
    carries: "exactly one period",
  },
  {
    what: "a profile whose period starts late",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "late-start" },
    expect: "unsupported",
    carries: "exactly one period",
  },
  {
    what: "a profile numbered otherwise than the console numbers it",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "own-id" },
    expect: "unsupported",
    carries: "11, not 56",
  },
  {
    what: "a profile on another connector than its number says",
    operation: { action: "SetChargingProfile", connectorId: 2, chargingProfile: "tx-default" },
    expect: "unsupported",
    carries: "12, not 11",
  },
  {
    what: "a profile scoped to a transaction ref",
    operation: {
      action: "SetChargingProfile",
      connectorId: 1,
      chargingProfile: "tx-profile",
      transaction: "42",
    },
    expect: "unsupported",
    carries: "no transactionId",
  },
  {
    what: "a profile carrying a transactionId",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "with-tx" },
    expect: "unsupported",
    carries: "no transactionId",
  },
  {
    what: "a composite schedule in a rate unit",
    operation: {
      action: "GetCompositeSchedule",
      connectorId: 1,
      duration: 600,
      chargingRateUnit: "A",
    },
    expect: "unsupported",
    carries: "no chargingRateUnit",
  },
  {
    what: "a local-list idTag the console would upper-case",
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Full",
      localAuthorizationList: [{ idTag: "tag-a" }],
    },
    expect: "unsupported",
    carries: "upper-cases",
  },
  {
    what: "a local-list entry Blocked",
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Full",
      localAuthorizationList: [{ idTag: "TAG-A", status: "Blocked" }],
    },
    expect: "unsupported",
    carries: "status Accepted",
  },
  {
    what: "a local-list entry with an expiryDate",
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Full",
      localAuthorizationList: [
        { idTag: "TAG-A", status: "Accepted", expiryDate: new Date("2030-01-01T00:00:00Z") },
      ],
    },
    expect: "unsupported",
    carries: "no expiryDate or parentIdTag",
  },
  {
    what: "a local-list entry with a parentIdTag",
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Full",
      localAuthorizationList: [{ idTag: "TAG-A", status: "Accepted", parentIdTag: "GRP" }],
    },
    expect: "unsupported",
    carries: "no expiryDate or parentIdTag",
  },
  {
    what: "a local-list removal",
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Differential",
      localAuthorizationList: [{ idTag: "TAG-A" }],
    },
    expect: "unsupported",
    carries: "cannot remove a tag",
  },
  {
    what: "a reservation with a parentIdTag",
    operation: {
      action: "ReserveNow",
      connectorId: 1,
      idTag: "TAG-1",
      parentIdTag: "GRP",
      expiryDate: new Date("2030-01-01T00:00:00Z"),
    },
    expect: "unsupported",
    carries: "no parentIdTag",
  },
  {
    what: "a reservation that has expired",
    operation: { action: "ReserveNow", connectorId: 1, idTag: "TAG-1", expiryDate: PAST },
    expect: "unsupported",
    carries: "not in the future",
  },
  {
    what: "diagnostics to the console's own upload address",
    operation: { action: "GetDiagnostics", location: "http://console.test/api/diagnostics/upload" },
    expect: "unsupported",
    carries: "one-time one",
  },
  {
    what: "firmware retries above 20",
    operation: { ...FIRMWARE, retries: 21 } as CsmsOperation16,
    expect: "unsupported",
    carries: "clamps",
  },
  {
    what: "a firmware retryInterval above a day",
    operation: { ...FIRMWARE, retryInterval: 86_401 } as CsmsOperation16,
    expect: "unsupported",
    carries: "clamps",
  },
  {
    what: "firmware from a file location",
    operation: { ...FIRMWARE, location: "file:///fw.bin" } as CsmsOperation16,
    expect: "unsupported",
    carries: "http, https, ftp or ftps",
  },
  {
    what: "firmware to retrieve in the past",
    operation: { ...FIRMWARE, retrieveDate: PAST } as CsmsOperation16,
    expect: "unsupported",
    carries: "in the past",
  },
  {
    what: "a charging-profile ref the lookup does not know",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "nope" },
    expect: "plain-error",
    carries: "refs.chargingProfileByRef",
  },
  {
    what: "a ClearChargingProfile ref that is empty",
    operation: { action: "ClearChargingProfile", chargingProfile: "" },
    expect: "plain-error",
    carries: "refs.chargingProfileByRef",
  },
  {
    what: "a transaction ref that is not an integer",
    operation: { action: "RemoteStopTransaction", transaction: "tx-abc" },
    expect: "plain-error",
    carries: "an OCPP transaction id",
  },
  {
    what: "a reservation ref that is not an integer",
    operation: { action: "CancelReservation", reservation: "res-abc" },
    expect: "plain-error",
    carries: "an integer reservation id",
  },
];
for (const kase of REFUSAL_CASES) {
  const what = `part 8: ${kase.what}`;
  const srv = server({});
  const result = await outcomeOf(
    driverFor(freshUrl(), srv).operations16.execute("CP1", kase.operation),
  );
  const got = result.ok ? "answered" : classify(result.err);
  check(got === kase.expect, `${what}: expected ${kase.expect}, got ${got}`);
  check(
    result.ok || message(result.err).includes(kase.carries),
    `${what}: message lacks ${JSON.stringify(kase.carries)}: ${message(result.err)}`,
  );
  check(
    srv.count.command + srv.count.firmware === 0,
    `${what}: expected no request, got ${srv.count.command + srv.count.firmware}`,
  );
}

{
  const driver = driverFor(freshUrl(), server({}));
  check(
    driver.capabilities === BPC_CSMS_CLOUD_CAPABILITIES &&
      CSMS_OPERATION_16_ACTIONS.every((a) => BPC_CSMS_CLOUD_CAPABILITIES.operations16.has(a)) &&
      BPC_CSMS_CLOUD_CAPABILITIES.operations16.size === CSMS_OPERATION_16_ACTIONS.length,
    "part 8: capabilities must declare every OCPP 1.6 action",
  );
  check(
    BPC_CSMS_CLOUD_CAPABILITIES.operations201 === undefined && driver.operations201 === undefined,
    "part 8: the driver must not claim OCPP 2.0.1",
  );
  check(
    driver.capabilities.chargePoints === undefined && driver.chargePoints === undefined,
    "part 8: the driver must not claim charge-point administration",
  );
  check(
    driver.sessions === undefined && driver.connectors === undefined,
    "part 8: sessions and connectors must be absent unless injected",
  );
}

// ---------------------------------------------------------------------------
// Parts 9-10: a long-lived process
// ---------------------------------------------------------------------------

await withClock(async (move) => {
  const what = "part 9: a command answered 401 once the session is a minute old";
  const url = freshUrl();
  const srv = server({
    login: [loggedIn("s1"), loggedIn("s2")],
    command: [answered({ status: "Accepted" }), UNAUTHORIZED, answered({ status: "Accepted" })],
  });
  const first = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  move(60_000);
  const second = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(
    first.ok && second.ok,
    `${what}: expected a fresh login and a resent command: ${message(first.err)} / ${message(second.err)}`,
  );
  check(
    srv.count.login === 2 && srv.count.command === 3,
    `${what}: expected 2 logins and 3 commands, got ${srv.count.login} and ${srv.count.command}`,
  );
  check(
    srv.commands[2]?.cookie === "csms_session=s2",
    `${what}: the resent command must carry the new session, got ${String(srv.commands[2]?.cookie)}`,
  );
  const third = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(
    third.ok && srv.count.login === 2,
    `${what}: the next call must reuse the fresh session, got ${srv.count.login} logins`,
  );
});

await withClock(async (move) => {
  const what = "part 9: a command answered 401 twice";
  const url = freshUrl();
  const srv = server({ command: [answered({ status: "Accepted" }), UNAUTHORIZED] });
  await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  move(60_000);
  const result = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(
    !result.ok && classify(result.err) === "not-dispatched",
    `${what}: expected a non-dispatch, got ${result.ok ? "answered" : classify(result.err)}`,
  );
  check(
    srv.count.login === 2 && srv.count.command === 3,
    `${what}: expected one retry, got ${srv.count.login} logins and ${srv.count.command} commands`,
  );
});

{
  const what = "part 9: a 401 on a session younger than a minute";
  const url = freshUrl();
  const srv = server({ command: [UNAUTHORIZED] });
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET)));
  }
  check(
    results.every((r) => !r.ok && classify(r.err) === "not-dispatched"),
    `${what}: expected three non-dispatches, got ${results.map((r) => (r.ok ? "answered" : classify(r.err))).join(", ")}`,
  );
  check(
    srv.count.login === 1 && srv.count.command === 3,
    `${what}: expected 1 login over 3 commands, got ${srv.count.login} and ${srv.count.command}`,
  );
}

await withClock(async (move) => {
  const what = "part 10: a kept 401 login refusal after fifteen minutes";
  const url = freshUrl();
  const srv = server({
    login: [() => new Response("Invalid username or password", { status: 401 }), LOGIN_OK],
  });
  const first = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  move(14 * 60_000);
  const within = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(
    !first.ok && !within.ok && srv.count.login === 1,
    `${what}: the refusal must hold within the window, got ${srv.count.login} logins`,
  );
  move(15 * 60_000);
  const after = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(
    after.ok && srv.count.login === 2,
    `${what}: expected a new login after the window, got ${srv.count.login} logins` +
      (after.ok ? "" : `: ${message(after.err)}`),
  );
});

// ---------------------------------------------------------------------------
// Part 11: the session is bound to the credential
// ---------------------------------------------------------------------------

function driverWithPassword(url: string, srv: Server, password: string): CsmsDriver {
  return createBpcCsmsCloudCsmsDriver({
    config: { apiUrl: url, username: "admin", password },
    fetch: srv.fetch,
  });
}

{
  const what = "part 11: a second password does not reuse the first one's session";
  const url = freshUrl();
  const srv = server({});
  const first = await outcomeOf(
    driverWithPassword(url, srv, "right").operations16.execute("CP1", RESET),
  );
  const second = await outcomeOf(
    driverWithPassword(url, srv, "wrong").operations16.execute("CP1", RESET),
  );
  check(first.ok && second.ok, `${what}: ${message(first.err)} / ${message(second.err)}`);
  check(srv.count.login === 2, `${what}: expected 2 logins, got ${srv.count.login}`);
}

{
  const what = "part 11: a refusal kept for one password does not block another";
  const url = freshUrl();
  const srv = server({
    login: [() => new Response("Invalid username or password", { status: 401 }), LOGIN_OK],
  });
  const wrong = await outcomeOf(
    driverWithPassword(url, srv, "wrong").operations16.execute("CP1", RESET),
  );
  const right = await outcomeOf(
    driverWithPassword(url, srv, "right").operations16.execute("CP1", RESET),
  );
  check(!wrong.ok, `${what}: the refused password was expected to fail`);
  check(
    right.ok && srv.count.login === 2,
    `${what}: expected the corrected password to log in, got ${srv.count.login} logins` +
      (right.ok ? "" : `: ${message(right.err)}`),
  );
}

{
  const what = "part 11: no failure quotes the password";
  for (const handler of [
    () => new Response("down", { status: 503 }),
    () => new Response("Invalid username or password", { status: 401 }),
  ] as Handler[]) {
    const srv = server({ login: [handler] });
    const result = await outcomeOf(
      driverWithPassword(freshUrl(), srv, "s3cret-Pa55").operations16.execute("CP1", RESET),
    );
    check(
      !result.ok && !message(result.err).includes("s3cret-Pa55"),
      `${what}: ${message(result.err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Part 12: firmware jobs
// ---------------------------------------------------------------------------

const FIRMWARE_CASES: (DispatchCase & { readonly cancels: number })[] = [
  {
    what: "a job sent",
    routes: { firmware: [job("sent", ["created by admin", "UpdateFirmware accepted"])] },
    expect: "answered",
    carries: ['"status":"sent"', "FWU-1"],
    cancels: 0,
  },
  {
    what: "a job whose station already reported Downloading",
    routes: { firmware: [job("Downloading")] },
    expect: "answered",
    carries: ["Downloading"],
    cancels: 0,
  },
  {
    what: "a job waiting for a station that is not connected",
    routes: { firmware: [job("waiting")] },
    expect: "not-dispatched",
    carries: ["not connected", "FWU-1 was cancelled"],
    cancels: 1,
  },
  {
    what: "a job waiting after the station left it unanswered",
    routes: { firmware: [job("waiting", ["created by admin", NO_ANSWER])] },
    expect: "plain-error",
    carries: ["unanswered", "FWU-1 was cancelled"],
    cancels: 1,
  },
  {
    what: "a job replaced before it was sent",
    routes: { firmware: [job("cancelled", ["created by admin", "replaced by a newer update"])] },
    expect: "not-dispatched",
    carries: ["replaced"],
    cancels: 0,
  },
  {
    what: "a job refused",
    routes: { firmware: [job("refused", ["created by admin", "charger refused: Error x"])] },
    expect: "plain-error",
    carries: ["ended refused"],
    cancels: 0,
  },
  {
    what: "a 200 without a job",
    routes: { firmware: [() => json({ ok: true, jobs: [] })] },
    expect: "plain-error",
    carries: ["without a firmware job"],
    cancels: 0,
  },
  {
    what: "a 400 refusing the request",
    routes: { firmware: [() => json({ error: "Choose at least one charger" }, 400)] },
    expect: "not-dispatched",
    carries: ["returned 400"],
    cancels: 0,
  },
];
for (const kase of FIRMWARE_CASES) {
  const srv = server(kase.routes);
  const driver = driverFor(freshUrl(), srv);
  const what = `part 12: ${kase.what}`;
  let got: Classification | "not-an-error";
  let text: string;
  try {
    text = await driver.operations16.execute("CP1", FIRMWARE);
    got = "answered";
  } catch (e) {
    text = message(e);
    got = classify(e);
  }
  check(got === kase.expect, `${what}: expected ${kase.expect}, got ${got} (${text})`);
  for (const s of kase.carries ?? []) {
    check(text.includes(s), `${what}: lacks ${JSON.stringify(s)}: ${text}`);
  }
  check(
    srv.count.cancel === kase.cancels &&
      (kase.cancels === 0 || srv.cancels[0]?.body === '{"id":"FWU-1"}'),
    `${what}: expected ${kase.cancels} cancel(s) of FWU-1, got ${srv.cancels.map((c) => c.body).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Part 13: commands
// ---------------------------------------------------------------------------

{
  const driver = driverFor(freshUrl(), server({}));
  const caps = driver.capabilities.commands;
  check(
    caps?.completion === "confirmed" && caps.polling === false,
    `13: capabilities.commands expected confirmed + no polling, got ${JSON.stringify(caps)}`,
  );
  check(
    driver.commands !== undefined && driver.commands.poll === undefined,
    "13: commands has a poll",
  );
}

function submit(
  routes: Routes,
  operation: CsmsOperation16 = RESET,
  dispatchTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  const commands = driverFor(freshUrl(), server(routes), dispatchTimeoutMs).commands;
  check(commands !== undefined, "13: driver.commands is missing");
  return commands!.submit16("CP1", operation, signal ? { signal } : undefined);
}

/** An outcome, or what `submit16` threw, so a row whose verdict regressed
 *  into a throw is recorded as a failure instead of ending the run. */
async function settled(
  p: Promise<CommandOutcome>,
): Promise<CommandOutcome | { readonly state: "threw"; readonly detail: string }> {
  try {
    return await p;
  } catch (err) {
    return { state: "threw", detail: `${classify(err)}: ${message(err)}` };
  }
}

for (const [what, routes, state, cause] of [
  ["200 Accepted", { command: [answered({ status: "Accepted" })] }, "confirmed"],
  ["200 Scheduled", { command: [answered({ status: "Scheduled" })] }, "confirmed"],
  ["200 Rejected", { command: [answered({ status: "Rejected" })] }, "rejected"],
  ["200 NotSupported", { command: [answered({ status: "NotSupported" })] }, "rejected"],
  ["500 for the station's CALLERROR", { command: [raised(CALLERROR_ERROR)] }, "failed"],
  ["500 for an unanswered CALL", { command: [raised(UNANSWERED_ERROR)] }, "unknown", "timeout"],
] as [string, Routes, string, string?][]) {
  const out = await settled(submit(routes));
  check(out.state === state, `13: ${what}: expected ${state}, got ${JSON.stringify(out)}`);
  check(
    out.state === "unsupported" || out.state === "threw" || !Number.isNaN(Date.parse(out.at)),
    `13: ${what}: \`at\` is not an instant`,
  );
  if (cause !== undefined) {
    check(out.state === "unknown" && out.cause === cause, `13: ${what}: ${JSON.stringify(out)}`);
  }
}

{
  const out = await settled(
    submit(
      { command: [raised("'NoneType' object has no attribute 'list_version'")] },
      { action: "GetLocalListVersion" },
    ),
  );
  check(out.state === "failed", `13: a GetLocalListVersion CALLERROR: ${JSON.stringify(out)}`);
}

/** The station's payload a confirmed outcome must carry, per console answer. */
const PAYLOAD_CASES: readonly [string, CsmsOperation16, unknown, unknown][] = [
  ["Reset", RESET, { status: "Accepted" }, { status: "Accepted" }],
  [
    "GetConfiguration",
    { action: "GetConfiguration", keys: ["HeartbeatInterval"] },
    {
      configuration: [{ key: "HeartbeatInterval", value: "30", readonly: false }],
      mode: "standard",
    },
    { configurationKey: [{ key: "HeartbeatInterval", readonly: false, value: "30" }] },
  ],
  [
    "GetCompositeSchedule",
    { action: "GetCompositeSchedule", connectorId: 1, duration: 600 },
    {
      status: "Accepted",
      connector_id: 1,
      schedule_start: "2030-01-01T00:00:00Z",
      charging_schedule: {
        duration: 600,
        charging_rate_unit: "W",
        charging_schedule_period: [{ start_period: 0, limit: 7400.0, number_phases: 3 }],
      },
    },
    {
      status: "Accepted",
      connectorId: 1,
      scheduleStart: "2030-01-01T00:00:00Z",
      chargingSchedule: {
        duration: 600,
        chargingRateUnit: "W",
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 7400, numberPhases: 3 }],
      },
    },
  ],
  ["GetLocalListVersion", { action: "GetLocalListVersion" }, { version: 3 }, { listVersion: 3 }],
  [
    "GetDiagnostics with a file",
    { action: "GetDiagnostics", location: "ftp://diag.test/upload" },
    { fileName: "CP1_diag.zip", status: "Uploading" },
    { fileName: "CP1_diag.zip" },
  ],
  [
    "GetDiagnostics without one",
    { action: "GetDiagnostics", location: "ftp://diag.test/upload" },
    { status: "No diagnostics available" },
    {},
  ],
];
for (const [what, operation, result, payload] of PAYLOAD_CASES) {
  const out = await settled(submit({ command: [answered(result)] }, operation));
  check(
    out.state === "confirmed" && JSON.stringify(out.response) === JSON.stringify(payload),
    `13: ${what}: expected confirmed with ${JSON.stringify(payload)}, got ${JSON.stringify(out)}`,
  );
}

{
  // The driver's own deadline on a command that left: not failed, not thrown.
  const out = await settled(submit({ command: [HANGS] }, RESET, 150));
  check(
    out.state === "unknown" && out.cause === "timeout",
    `13: dispatchTimeoutMs expiry expected unknown/timeout, got ${JSON.stringify(out)}`,
  );
  const aborted = await settled(submit({ command: [ABORTED] }));
  check(
    aborted.state === "unknown" && aborted.cause === "timeout",
    `13: an aborted wait expected unknown/timeout, got ${JSON.stringify(aborted)}`,
  );
  for (const [what, reason] of [
    ["no reason", undefined],
    ["a string reason", "cancelled"],
    ["a plain Error reason", new Error("stop")],
  ] as [string, unknown][]) {
    const ac = new AbortController();
    setTimeout(() => ac.abort(reason), 80);
    const out = await settled(submit({ command: [HANGS] }, RESET, 5000, ac.signal));
    check(
      out.state === "unknown" && out.cause === "no-evidence" && /caller/.test(out.detail ?? ""),
      `13: a caller's abort with ${what} expected unknown/no-evidence, got ${JSON.stringify(out)}`,
    );
  }
}

{
  const srv = server({ firmware: [job("sent")] });
  const sent = await settled(driverFor(freshUrl(), srv).commands!.submit16("CP1", FIRMWARE));
  check(
    sent.state === "confirmed" && JSON.stringify(sent.response) === "{}",
    `13: a firmware job sent expected confirmed with {}, got ${JSON.stringify(sent)}`,
  );
  const quiet = server({ firmware: [job("waiting", ["created by admin", NO_ANSWER])] });
  const unanswered = await settled(
    driverFor(freshUrl(), quiet).commands!.submit16("CP1", FIRMWARE),
  );
  check(
    unanswered.state === "unknown" && unanswered.cause === "timeout" && quiet.count.cancel === 1,
    `13: a firmware job left unanswered expected unknown/timeout and a cancel, got ` +
      `${JSON.stringify(unanswered)} and ${quiet.count.cancel} cancel(s)`,
  );
}

for (const [what, routes, operation, expect] of [
  [
    "404",
    { command: [() => json({ error: "Charge Point not found" }, 404)] },
    RESET,
    "not-dispatched",
  ],
  [
    "a remote start the console did not send",
    { command: [answered({ status: "Rejected", reason: "no connector is free" })] },
    { action: "RemoteStartTransaction", idTag: "TAG-1", connectorId: 1 },
    "not-dispatched",
  ],
  ["a refused connect", { command: [REFUSED] }, RESET, "not-dispatched"],
  ["a refused login", { login: [REFUSED] }, RESET, "not-dispatched"],
  [
    "a firmware job for a station not connected",
    { firmware: [job("waiting")] },
    FIRMWARE,
    "not-dispatched",
  ],
  [
    "400 Unknown command",
    { command: [() => json({ error: "Unknown command: reset" }, 400)] },
    RESET,
    "unsupported",
  ],
  [
    "an operation the console cannot express",
    {},
    { action: "RemoteStartTransaction", idTag: "TAG-1" },
    "unsupported",
  ],
  ["any other 500", { command: [raised("division by zero")] }, RESET, "plain-error"],
  ["a 200 that cannot be read", { command: [() => json({ success: true })] }, RESET, "plain-error"],
] as [string, Routes, CsmsOperation16, Classification][]) {
  const r = await outcomeOf(submit(routes, operation));
  const got = r.ok ? "answered" : classify(r.err);
  check(got === expect, `13: ${what}: expected a ${expect} throw, got ${got}`);
}

{
  const text = JSON.stringify(await settled(submit({ command: [raised(CALLERROR_ERROR)] })));
  check(!text.includes(PASSWORD), `13: an outcome quotes the password: ${text}`);
}

if (failures.length > 0) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  console.error(
    `\n${failures.length} failure(s). This guard holds two lines of the bpc-csms-cloud driver: ` +
      "which console answers say the charge point was never asked -- a station's " +
      "CALLERROR or an unanswered CALL is not one, an offline station, a refusal before the " +
      "CALL or a remote start the console kept back is -- and which login failures the " +
      "process remembers. The console locks a client out after five wrong passwords; keeping " +
      "a transient failure fails every later call.",
  );
  process.exit(1);
}
console.log("bpc-csms-cloud driver: OK");

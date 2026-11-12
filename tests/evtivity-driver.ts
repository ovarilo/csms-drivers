// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The EVtivity driver: when it says a request never became an OCPP CALL, when
 * its one login is spent, and what it puts on the command routes.
 *
 * EVtivity runs every 1.6 operation through `POST /v1/ocpp/commands/v16/
 * {Action}`, and that call BLOCKS until the station answers, so one HTTP status
 * carries both halves of the question: whether the CSMS sent the CALL, and what
 * the station said. The line between them is drawn from the bodies the server
 * was measured answering with and from the route's source at v0.1.51
 * (packages/api/src/routes/ocpp-commands.ts, dispatchCommandRaw).
 *
 * PROPERTY, in 12 parts:
 *  1. AN ANSWER IS AN ANSWER. A 200 `{"status":"accepted",...,"response":{...}}`
 *     resolves with the station's payload in the receipt -- a
 *     `"response":{"status":"Rejected"}` included. A 200 without a `response`
 *     object, or one that is not JSON, is a plain `Error`: answered, and what
 *     happened is unknown. So is a 2xx the driver does not know.
 *  2. REFUSED BEFORE THE PUBLISH IS A NON-DISPATCH. 202 `COMMAND_QUEUED`, 404,
 *     a 400 `VALIDATION_ERROR`, 403 and 429 are `CsmsNotDispatchedError`. So is
 *     a `fetch` that fails to connect, every 502 whose `error` is not one of
 *     the two only the station's answer produces (part 4) -- a body that is
 *     not JSON included --, a 504 `No response within 35s`, and a request
 *     aborted by the driver's own `dispatchTimeoutMs`.
 *  3. A 400 `OCPP_VERSION_MISMATCH` is `UnsupportedOperationError`.
 *  4. THE NEGATIVE HALF. A 502 whose `error` starts `CALLERROR ` or
 *     `Invalid CALLRESULT `, a 504 whose `error` starts `Timeout waiting for
 *     response to `, and a 500 are plain `Error`s: the CALL left, or may have.
 *  5. ONE LOGIN PER PROCESS. Concurrent drivers share one
 *     `POST /v1/auth/login`, and a token near its JWT `exp` is replaced before
 *     use.
 *  6. WHICH LOGIN FAILURES ARE KEPT. A 401, a 403 and a 200
 *     `{"mustResetPassword":true}` are kept: the next call makes no request,
 *     and the message says the process will not try again soon. A 429, a 5xx,
 *     a 2xx without a token and a `fetch` that rejects or times out are
 *     forgotten, and the next call logs in again. Kept or forgotten, each is a
 *     `CsmsNotDispatchedError`, on every call it answers: no command was sent.
 *  7. The wire: the route names the action, the body is `{stationId, ...}`
 *     with the OCPP 1.6 payload (member order included), and the bearer token
 *     rides every command.
 *  8. The arms that refuse: a charging-profile ref the caller's lookup does not
 *     know, and a transaction or reservation ref that is not an integer, are
 *     plain `Error`s that post nothing, never capability gaps. Capabilities
 *     declare every OCPP 1.6 action, no OCPP 2.0.1, no charge-point
 *     administration.
 *  9. A LONG-LIVED PROCESS. A command answered 401 renews the session and is
 *     sent once more only when the session is at least a minute old; a second
 *     401 is the command's answer. A 401 on a younger session renews nothing,
 *     so a 401 the server keeps sending costs at most one login a minute.
 * 10. A kept login refusal expires after fifteen minutes, so a long-lived
 *     process recovers without a restart.
 * 11. THE SESSION IS BOUND TO THE CREDENTIAL. Two drivers of one server and
 *     account with different passwords do not share a session: the second
 *     logs in itself, so a wrong password never borrows a valid token, and a
 *     refusal kept for one password does not block a corrected one.
 * 12. `commands.submit16` reports the station's answer as a VALUE and declares
 *     { completion: "confirmed", polling: false } with no `poll`. A 200
 *     Accepted (or any answer but Rejected/NotSupported) is `confirmed` with
 *     the station's response; Rejected/NotSupported is `rejected`; a station
 *     CALLERROR (502) is `failed`; an unanswered CALL (504) and the driver's
 *     own `dispatchTimeoutMs` expiring on a command are `unknown` (`timeout`),
 *     never `failed`; a caller's abort is `unknown` (`no-evidence`). Whatever
 *     never became a CALL (202, 404, 400, a refused connect, a login that
 *     times out) and a 500 still throw as `execute` does.
 *
 * Each row gets its own server URL because the session cache is module-level
 * and keyed by server and account: a shared key would let one row's cached
 * refusal decide the next row's verdict.
 *
 * Offline: answers every request from a closure. Opens no socket.
 */

import {
  CSMS_OPERATION_16_ACTIONS,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  createEvtivityCsmsDriver,
  EVTIVITY_CAPABILITIES,
  type CsmsDriver,
  type CsmsOperation16,
  type EvtivityChargingProfile,
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
  return `http://evtivity-row-${rowSeq}.test`;
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
// The fake server
// ---------------------------------------------------------------------------

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

/** A JWT whose payload carries `exp`, seconds from now on the (possibly
 *  patched) clock. Unsigned: the driver only reads the expiry. */
function jwt(expInSecs = 3600, n = 1): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: "HS256" })}.${part({ sub: `usr_${n}`, iat: now, exp: now + expInSecs })}.sig`;
}

const LOGIN_OK: Handler = () => json({ token: jwt(), user: { id: "usr_1" } });
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
const UNAUTHORIZED: Handler = () => json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);

/** A failed command, in the envelope dispatchCommandRaw answers 502 and 504
 *  with: `error` is the OCPP process's own message, verbatim. */
const commandFailed =
  (status: 502 | 504, error: string): Handler =>
  () =>
    json(
      {
        status: status === 504 ? "timeout" : "error",
        code: status === 504 ? "COMMAND_TIMEOUT" : "COMMAND_ERROR",
        stationId: "CP1",
        action: "Reset",
        error,
      },
      status,
    );

/** The station's answer, in the 200 envelope the route answers with. */
const answered =
  (response: unknown): Handler =>
  () =>
    json({ status: "accepted", stationId: "CP1", action: "Reset", response });

interface Sent {
  readonly path: string;
  readonly body: string | undefined;
  readonly authorization: string | null;
}

interface Server {
  readonly fetch: FetchLike;
  readonly count: { login: number; command: number };
  readonly commands: Sent[];
}

interface Routes {
  login?: Handler[];
  command?: Handler[];
}

/**
 * Routes by method and path. Each route is a queue of handlers; the last one
 * repeats, so `[fail, ok]` is "fails once, then answers".
 */
function server(routes: Routes): Server {
  const count = { login: 0, command: 0 };
  const commands: Sent[] = [];
  const take = (queue: Handler[] | undefined, n: number, fallback: Handler): Handler => {
    if (queue === undefined || queue.length === 0) return fallback;
    return queue[Math.min(n, queue.length - 1)]!;
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(input).pathname;
    if (method === "POST" && path === "/v1/auth/login") {
      return take(routes.login, count.login++, LOGIN_OK)(init);
    }
    if (method === "POST" && path.startsWith("/v1/ocpp/commands/v16/")) {
      commands.push({
        path,
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return take(routes.command, count.command++, answered({ status: "Accepted" }))(init);
    }
    return json({ error: "Not found", code: "NOT_FOUND" }, 404);
  };
  return { fetch: fetchImpl, count, commands };
}

const PROFILES: Readonly<Record<string, EvtivityChargingProfile>> = {
  "tx-default": {
    chargingProfileId: 56,
    stackLevel: 0,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Relative",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
    },
  },
};

function driverFor(url: string, srv: Server, dispatchTimeoutMs?: number): CsmsDriver {
  return createEvtivityCsmsDriver({
    config: {
      apiUrl: url,
      email: "admin@evtivity.local",
      password: "admin123",
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
}

async function checkDispatch(part: string, kase: DispatchCase): Promise<void> {
  const what = `${part}: ${kase.what}`;
  const srv = server(kase.routes);
  const driver = driverFor(freshUrl(), srv, kase.dispatchTimeoutMs);
  let outcome: Classification | "not-an-error";
  let text: string;
  try {
    text = await driver.operations16.execute("CP1", RESET);
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
    what: "200 without a response object",
    routes: { command: [() => json({ status: "accepted", stationId: "CP1", action: "Reset" })] },
    expect: "plain-error",
    carries: ["without the station's response"],
  },
  {
    what: "200 whose body is not JSON",
    routes: { command: [() => new Response("<html>proxy</html>", { status: 200 })] },
    expect: "plain-error",
    carries: ["<html>proxy</html>"],
  },
  {
    what: "a 2xx the driver does not know",
    routes: { command: [() => json({ status: "created" }, 201)] },
    expect: "plain-error",
    carries: ["201"],
  },
];
for (const kase of ANSWER_CASES) await checkDispatch("part 1", kase);

const NOT_DISPATCHED_CASES: DispatchCase[] = [
  {
    what: "202 COMMAND_QUEUED, the station offline",
    routes: {
      command: [
        () =>
          json(
            {
              status: "queued",
              code: "COMMAND_QUEUED",
              stationId: "CP1",
              action: "Reset",
              message: "Station offline, command queued",
            },
            202,
          ),
      ],
    },
    expect: "not-dispatched",
    carries: ["returned 202", "COMMAND_QUEUED"],
  },
  {
    what: "404 STATION_NOT_FOUND",
    routes: {
      command: [() => json({ error: "Station not found", code: "STATION_NOT_FOUND" }, 404)],
    },
    expect: "not-dispatched",
    carries: ["returned 404", "STATION_NOT_FOUND"],
  },
  {
    what: "400 VALIDATION_ERROR",
    routes: {
      command: [
        () =>
          json(
            {
              error: "body/type must be equal to one of the allowed values",
              code: "VALIDATION_ERROR",
            },
            400,
          ),
      ],
    },
    expect: "not-dispatched",
    carries: ["returned 400", "VALIDATION_ERROR"],
  },
  {
    what: "403 INSUFFICIENT_PERMISSIONS",
    routes: {
      command: [
        () => json({ error: "Insufficient permissions", code: "INSUFFICIENT_PERMISSIONS" }, 403),
      ],
    },
    expect: "not-dispatched",
    carries: ["returned 403"],
  },
  {
    what: "429 from the global rate limit",
    routes: { command: [() => json({ error: "Too Many Requests" }, 429)] },
    expect: "not-dispatched",
    carries: ["returned 429"],
  },
  {
    what: "a fetch that fails to connect",
    routes: { command: [REFUSED] },
    expect: "not-dispatched",
    carries: ["/v1/ocpp/commands/v16/Reset", "ECONNREFUSED"],
  },
  {
    what: "502 for a CALL that waited behind an unanswered one",
    routes: {
      command: [
        commandFailed(
          502,
          "Timeout waiting to send Reset: the station did not answer the previous CALL",
        ),
      ],
    },
    expect: "not-dispatched",
    carries: ["returned 502", "Timeout waiting to send Reset"],
  },
  {
    what: "502 Connection closed",
    routes: { command: [commandFailed(502, "Connection closed")] },
    expect: "not-dispatched",
    carries: ["returned 502", "Connection closed"],
  },
  {
    what: "502 for a station offline and a command marked not to queue",
    routes: { command: [commandFailed(502, "Station offline, command not queued")] },
    expect: "not-dispatched",
    carries: ["returned 502", "command not queued"],
  },
  {
    // No JSON, so no evidence the station answered.
    what: "502 whose body is a proxy page",
    routes: { command: [() => new Response("<html>bad gateway</html>", { status: 502 })] },
    expect: "not-dispatched",
    carries: ["returned 502", "bad gateway"],
  },
  {
    what: "504 with no reply from the OCPP process",
    routes: { command: [commandFailed(504, "No response within 35s")] },
    expect: "not-dispatched",
    carries: ["returned 504", "No response within 35s"],
  },
  {
    what: "a fetch rejected with a timeout",
    routes: { command: [ABORTED] },
    expect: "not-dispatched",
    carries: ["/v1/ocpp/commands/v16/Reset", "timed out"],
  },
  {
    what: "a command the server holds past dispatchTimeoutMs",
    routes: { command: [HANGS] },
    dispatchTimeoutMs: 50,
    expect: "not-dispatched",
    carries: ["/v1/ocpp/commands/v16/Reset", "timed out after 50 ms"],
  },
];
for (const kase of NOT_DISPATCHED_CASES) await checkDispatch("part 2", kase);

await checkDispatch("part 3", {
  what: "400 OCPP_VERSION_MISMATCH",
  routes: {
    command: [
      () =>
        json(
          {
            error: "This is an ocpp1.6 command but the station uses ocpp2.0.1",
            code: "OCPP_VERSION_MISMATCH",
            action: "Reset",
          },
          400,
        ),
    ],
  },
  expect: "unsupported",
  carries: ["ocpp2.0.1"],
});

const SENT_CASES: DispatchCase[] = [
  {
    what: "502 COMMAND_ERROR carrying the station's CALLERROR",
    routes: {
      command: [commandFailed(502, "CALLERROR NotImplemented: raw station refuses Reset")],
    },
    expect: "plain-error",
    carries: ["COMMAND_ERROR", "CALLERROR NotImplemented"],
  },
  {
    what: "502 for a CALLRESULT that failed schema validation",
    routes: {
      command: [
        commandFailed(
          502,
          "Invalid CALLRESULT for Reset: response payload failed schema validation",
        ),
      ],
    },
    expect: "plain-error",
    carries: ["Invalid CALLRESULT"],
  },
  {
    what: "504 for a CALL the station left unanswered",
    routes: { command: [commandFailed(504, "Timeout waiting for response to Reset (d4b189bb)")] },
    expect: "plain-error",
    carries: ["COMMAND_TIMEOUT", "d4b189bb"],
  },
  {
    what: "500 INTERNAL_ERROR",
    routes: {
      command: [
        () =>
          json(
            {
              status: "error",
              code: "INTERNAL_ERROR",
              stationId: "CP1",
              action: "Reset",
              error: "Internal server error",
            },
            500,
          ),
      ],
    },
    expect: "plain-error",
    carries: ["INTERNAL_ERROR"],
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
}

{
  const what = "part 5: a token about to expire is replaced before use";
  const { first, second, srv } = await twoCalls({
    login: [() => json({ token: jwt(30, 1) }), () => json({ token: jwt(3600, 2) })],
  });
  check(
    first.ok && second.ok,
    `${what}: expected both to succeed: ${message(first.err)} / ${message(second.err)}`,
  );
  check(srv.count.login === 2, `${what}: expected two logins, got ${srv.count.login}`);
  check(
    srv.commands.length === 2 && srv.commands[1]!.authorization !== srv.commands[0]!.authorization,
    `${what}: the second command must carry the new token`,
  );
}

const FORGOTTEN: { what: string; handler: Handler }[] = [
  { what: "login whose fetch rejects", handler: REFUSED },
  { what: "login aborted by its own timeout", handler: ABORTED },
  { what: "login refused 429", handler: () => json({ error: "Too Many Requests" }, 429) },
  { what: "login refused 503", handler: () => new Response("down", { status: 503 }) },
  { what: "login answered 200 without a token", handler: () => json({ user: {} }) },
  {
    what: "login answered 200 with a body that is not JSON",
    handler: () => new Response("<html>"),
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
    handler: () => json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" }, 401),
  },
  {
    what: "login refused 403",
    handler: () =>
      json({ error: "Required MFA cannot be set up", code: "MFA_SETUP_UNAVAILABLE" }, 403),
  },
  { what: "login answered mustResetPassword", handler: () => json({ mustResetPassword: true }) },
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

/** The one command `operation` posts, or undefined when it posted none. */
async function commandSent(operation: CsmsOperation16): Promise<Sent | undefined> {
  const srv = server({});
  await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP1", operation));
  return srv.commands[0];
}

const WIRE_CASES: readonly { operation: CsmsOperation16; path: string; body: string }[] = [
  {
    operation: RESET,
    path: "/v1/ocpp/commands/v16/Reset",
    body: '{"stationId":"CP1","type":"Soft"}',
  },
  {
    operation: { action: "GetConfiguration" },
    path: "/v1/ocpp/commands/v16/GetConfiguration",
    body: '{"stationId":"CP1"}',
  },
  {
    operation: { action: "GetConfiguration", keys: ["HeartbeatInterval"] },
    path: "/v1/ocpp/commands/v16/GetConfiguration",
    body: '{"stationId":"CP1","key":["HeartbeatInterval"]}',
  },
  {
    operation: { action: "RemoteStopTransaction", transaction: "42" },
    path: "/v1/ocpp/commands/v16/RemoteStopTransaction",
    body: '{"stationId":"CP1","transactionId":42}',
  },
  {
    operation: {
      action: "SetChargingProfile",
      connectorId: 1,
      chargingProfile: "tx-default",
      transaction: "42",
    },
    path: "/v1/ocpp/commands/v16/SetChargingProfile",
    body:
      '{"stationId":"CP1","connectorId":1,"csChargingProfiles":{"chargingProfileId":56,' +
      '"stackLevel":0,"chargingProfilePurpose":"TxDefaultProfile","chargingProfileKind":' +
      '"Relative","chargingSchedule":{"chargingRateUnit":"W","chargingSchedulePeriod":' +
      '[{"startPeriod":0,"limit":11000}]},"transactionId":42}}',
  },
  {
    operation: { action: "ClearChargingProfile", chargingProfile: "tx-default" },
    path: "/v1/ocpp/commands/v16/ClearChargingProfile",
    body: '{"stationId":"CP1","id":56}',
  },
  {
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Differential",
      localAuthorizationList: [{ idTag: "TAG-2", status: "Accepted" }, { idTag: "TAG-3" }],
    },
    path: "/v1/ocpp/commands/v16/SendLocalList",
    body:
      '{"stationId":"CP1","listVersion":2,"localAuthorizationList":[{"idTag":"TAG-2",' +
      '"idTagInfo":{"status":"Accepted"}},{"idTag":"TAG-3"}],"updateType":"Differential"}',
  },
  {
    operation: { action: "CancelReservation", reservation: "7" },
    path: "/v1/ocpp/commands/v16/CancelReservation",
    body: '{"stationId":"CP1","reservationId":7}',
  },
];
for (const { operation, path, body } of WIRE_CASES) {
  const what = `part 7: ${operation.action} ${JSON.stringify(operation)}`;
  const sent = await commandSent(operation);
  check(sent?.path === path, `${what}: posted to ${String(sent?.path)}, expected ${path}`);
  check(sent?.body === body, `${what}: posted ${String(sent?.body)}, expected ${body}`);
  check(
    sent?.authorization?.startsWith("Bearer eyJ") === true,
    `${what}: authorization header ${String(sent?.authorization)}`,
  );
}

{
  const what = "part 7: ReserveNow without a reservation ref";
  const sent = await commandSent({
    action: "ReserveNow",
    connectorId: 1,
    expiryDate: new Date("2030-01-01T00:00:00Z"),
    idTag: "TAG-1",
  });
  const body = sent?.body === undefined ? undefined : (JSON.parse(sent.body) as unknown);
  const id = (body as { reservationId?: unknown } | undefined)?.reservationId;
  check(
    typeof id === "number" && Number.isInteger(id),
    `${what}: expected an allocated integer reservationId, got ${String(sent?.body)}`,
  );
}

interface RefusalCase {
  readonly what: string;
  readonly operation: CsmsOperation16;
  readonly carries: string;
}

const REFUSAL_CASES: RefusalCase[] = [
  {
    what: "a charging-profile ref the lookup does not know",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "nope" },
    carries: "refs.chargingProfileByRef",
  },
  {
    what: "a RemoteStart profile ref that is empty",
    operation: { action: "RemoteStartTransaction", idTag: "TAG-1", chargingProfile: "" },
    carries: "refs.chargingProfileByRef",
  },
  {
    what: "a transaction ref that is not an integer",
    operation: { action: "RemoteStopTransaction", transaction: "tx-abc" },
    carries: "an OCPP transaction id",
  },
  {
    what: "a reservation ref that is not an integer",
    operation: { action: "CancelReservation", reservation: "res-abc" },
    carries: "an integer reservation id",
  },
];
for (const kase of REFUSAL_CASES) {
  const what = `part 8: ${kase.what}`;
  const srv = server({});
  const result = await outcomeOf(
    driverFor(freshUrl(), srv).operations16.execute("CP1", kase.operation),
  );
  check(
    !result.ok && classify(result.err) === "plain-error",
    `${what}: expected a plain Error, got ${result.ok ? "answered" : classify(result.err)}`,
  );
  check(
    result.ok || message(result.err).includes(kase.carries),
    `${what}: message lacks ${JSON.stringify(kase.carries)}: ${message(result.err)}`,
  );
  check(srv.count.command === 0, `${what}: expected no command, got ${srv.count.command}`);
}

{
  const driver = driverFor(freshUrl(), server({}));
  check(
    driver.capabilities === EVTIVITY_CAPABILITIES &&
      CSMS_OPERATION_16_ACTIONS.every((a) => EVTIVITY_CAPABILITIES.operations16.has(a)) &&
      EVTIVITY_CAPABILITIES.operations16.size === CSMS_OPERATION_16_ACTIONS.length,
    "part 8: capabilities must declare every OCPP 1.6 action",
  );
  check(
    EVTIVITY_CAPABILITIES.operations201 === undefined && driver.operations201 === undefined,
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
    login: [() => json({ token: jwt(3600, 1) }), () => json({ token: jwt(3600, 2) })],
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
    srv.commands[2]?.authorization !== srv.commands[1]?.authorization,
    `${what}: the resent command must carry the new token`,
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
    login: [
      () => json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" }, 401),
      LOGIN_OK,
    ],
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
  return createEvtivityCsmsDriver({
    config: { apiUrl: url, email: "admin@evtivity.local", password },
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
    login: [
      () => json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" }, 401),
      LOGIN_OK,
    ],
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
  const what = "part 11: the session key carries no raw password";
  const url = freshUrl();
  const srv = server({ login: [() => new Response("down", { status: 503 })] });
  const result = await outcomeOf(
    driverWithPassword(url, srv, "s3cret-Pa55").operations16.execute("CP1", RESET),
  );
  check(
    !result.ok && !message(result.err).includes("s3cret-Pa55"),
    `${what}: the failure must not quote the password: ${message(result.err)}`,
  );
}
// ---------------------------------------------------------------------------
// Part 12: commands
// ---------------------------------------------------------------------------

{
  const caps = driverFor(freshUrl(), server({})).capabilities.commands;
  check(
    caps?.completion === "confirmed" && caps.polling === false,
    `12: capabilities.commands expected confirmed + no polling, got ${JSON.stringify(caps)}`,
  );
  const commands = driverFor(freshUrl(), server({})).commands;
  check(commands !== undefined && commands.poll === undefined, "12: commands has a poll");
}

function submit(routes: Routes, dispatchTimeoutMs?: number, signal?: AbortSignal) {
  const commands = driverFor(freshUrl(), server(routes), dispatchTimeoutMs).commands;
  check(commands !== undefined, "12: driver.commands is missing");
  return commands!.submit16("CP1", RESET, signal ? { signal } : undefined);
}

for (const [what, routes, state] of [
  ["200 Accepted", { command: [answered({ status: "Accepted" })] }, "confirmed"],
  ["200 Scheduled", { command: [answered({ status: "Scheduled" })] }, "confirmed"],
  ["200 Rejected", { command: [answered({ status: "Rejected" })] }, "rejected"],
  ["200 NotSupported", { command: [answered({ status: "NotSupported" })] }, "rejected"],
  [
    "502 CALLERROR",
    { command: [commandFailed(502, "CALLERROR NotImplemented: raw station refuses Reset")] },
    "failed",
  ],
  [
    "502 Invalid CALLRESULT",
    { command: [commandFailed(502, "Invalid CALLRESULT for Reset: schema")] },
    "failed",
  ],
  [
    "504 unanswered CALL",
    { command: [commandFailed(504, "Timeout waiting for response to Reset (d4b189bb)")] },
    "unknown",
  ],
] as [string, Routes, string][]) {
  const out = await submit(routes);
  check(out.state === state, `12: ${what}: expected ${state}, got ${JSON.stringify(out)}`);
  check(
    out.state === "unsupported" || !Number.isNaN(Date.parse(out.at)),
    `12: ${what}: \`at\` is not an instant`,
  );
  if (out.state === "unknown") check(out.cause === "timeout", `12: ${what}: cause ${out.cause}`);
}

{
  const out = await submit({ command: [answered({ status: "Accepted" })] });
  check(
    out.state === "confirmed" && JSON.stringify(out.response) === '{"status":"Accepted"}',
    `12: confirmed carries the station's response, got ${JSON.stringify(out)}`,
  );
}

{
  // The driver's own deadline on a command that left: not failed, not thrown.
  const out = await submit({ command: [HANGS] }, 150);
  check(
    out.state === "unknown" && out.cause === "timeout",
    `12: dispatchTimeoutMs expiry expected unknown/timeout, got ${JSON.stringify(out)}`,
  );
  const aborted = await submit({ command: [ABORTED] });
  check(
    aborted.state === "unknown" && aborted.cause === "timeout",
    `12: an aborted wait expected unknown/timeout, got ${JSON.stringify(aborted)}`,
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  const byCaller = await submit({ command: [HANGS] }, 5000, ac.signal);
  check(
    byCaller.state === "unknown" && byCaller.cause === "no-evidence",
    `12: a caller's abort expected unknown/no-evidence, got ${JSON.stringify(byCaller)}`,
  );
  // fetch rejects with the signal's REASON: a string or a plain Error, whose
  // name is not AbortError, must still be a caller abort.
  for (const [what, reason] of [
    ["a string reason", "cancelled"],
    ["a plain Error reason", new Error("stop")],
  ] as [string, unknown][]) {
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(reason), 80);
    const out = await submit({ command: [HANGS] }, 5000, ac2.signal);
    check(
      out.state === "unknown" && out.cause === "no-evidence",
      `12: a caller's abort with ${what} expected unknown/no-evidence, got ${JSON.stringify(out)}`,
    );
    check(
      out.state === "unknown" &&
        /caller/.test(out.detail ?? "") &&
        !/timed out/.test(out.detail ?? ""),
      `12: a caller's abort with ${what} must say the caller aborted, got ${JSON.stringify(out)}`,
    );
  }
}

for (const [what, routes, expect] of [
  [
    "202 COMMAND_QUEUED",
    { command: [() => json({ code: "COMMAND_QUEUED" }, 202)] },
    "not-dispatched",
  ],
  ["404", { command: [() => json({ code: "NOT_FOUND" }, 404)] }, "not-dispatched"],
  ["a refused connect", { command: [REFUSED] }, "not-dispatched"],
  [
    "502 failed send",
    { command: [commandFailed(502, "Station offline, command not queued")] },
    "not-dispatched",
  ],
  ["500", { command: [() => json({ code: "INTERNAL_ERROR" }, 500)] }, "plain-error"],
  ["a refused login", { login: [REFUSED] }, "not-dispatched"],
] as [string, Routes, Classification][]) {
  const r = await outcomeOf(submit(routes, 150));
  const got = r.ok ? "answered" : classify(r.err);
  check(got === expect, `12: ${what}: expected a ${expect} throw, got ${got}`);
}

{
  const r = await outcomeOf(
    submit({
      command: [
        () => json({ code: "OCPP_VERSION_MISMATCH", error: "station speaks ocpp2.0.1" }, 400),
      ],
    }),
  );
  check(classify(r.err) === "unsupported", "12: a version mismatch expected an unsupported throw");
}

{
  const text = JSON.stringify(
    await submit({ command: [commandFailed(502, "CALLERROR InternalError: x")] }),
  );
  check(!text.includes("admin123"), `12: an outcome quotes the password: ${text}`);
}

if (failures.length > 0) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  console.error(
    `\n${failures.length} failure(s). This guard holds two lines of the EVtivity driver: ` +
      "which command answers say the charge point was never asked -- a station's " +
      "CALLERROR or an unanswered CALL is not one, a queued command, a failed send or a " +
      "timeout nobody can place is -- and which login failures the process remembers. " +
      "Retrying a refused password feeds the account's sign-in backoff; keeping a " +
      "transient failure fails every later call.",
  );
  process.exit(1);
}
console.log("evtivity driver: OK");

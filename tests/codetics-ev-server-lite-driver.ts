// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The Codetics ev-server-lite driver: when it says a request never became an
 * OCPP CALL, when its one login is spent, and what it puts on the command
 * endpoint.
 *
 * The driver queues every operation through one endpoint and then polls the
 * command's state, so the dispatch line runs through a STATE TABLE rather than
 * through HTTP statuses alone: the POST can be refused (nothing queued),
 * accepted and then never sent, accepted and sent, or accepted and then lost
 * from view. Only the first two are `CsmsNotDispatchedError`'s claim.
 *
 * The login is the other half, because it is the one call the server rate
 * counts: ten signins per account per fifteen minutes, in its database. The
 * session is cached per process, and a cached FAILURE is the dangerous half --
 * every later caller inherits it.
 *
 * PROPERTY, in 11 parts:
 *  1. The command states, both directions. SENT, SUCCEEDED and FAILED with a
 *     result are dispatched and resolve. FAILED with no result, TIMED_OUT,
 *     CANCELLED and QUEUED past the wait are `CsmsNotDispatchedError`. A state
 *     the driver does not know is a plain `Error`.
 *  2. The POST itself. A `fetch` that rejects and a non-2xx are non-dispatches
 *     -- nothing was queued. A 2xx without a command id -- an empty body
 *     included -- is a plain `Error`: the server answered, and what it queued
 *     is unknown. So is a 2xx whose body will not read or parse.
 *  3. AFTER AN ACCEPTED POST, A READ FAILURE IS NOT A NON-DISPATCH. A poll that
 *     fails once and then sees SENT resolves; one that keeps failing (a 5xx, a
 *     rejected `fetch`, a body that is not a list) ends in a plain `Error` that
 *     names the command; a command the list never shows is a plain `Error` too.
 *  4. Concurrent drivers share one login: three drivers, one csrf read, one
 *     signin.
 *  5. Every login failure but a kept signin refusal is forgotten, and the next
 *     call logs in again.
 *  6. A signin refused 401, 403 or 429 is kept: the next call makes no request
 *     at all, and the message says the process will not retry -- a message a
 *     5xx must not carry, because the process will.
 *  7. The wire: a mutation carries the bearer token and the CSRF pair (cookie
 *     and header), and the command body is `{action, payload}` with the OCPP
 *     1.6 payload, member order included.
 *  8. The arms that refuse: a GetConfiguration key list is an
 *     `UnsupportedOperationError` and queues nothing; a charging-profile ref
 *     the caller's lookup does not know and a transaction ref that is not an
 *     integer are plain `Error`s, never capability gaps. Capabilities declare
 *     every OCPP 1.6 action, no OCPP 2.0.1 and no charge-point administration.
 *  9. A long-lived process outlives its token. An authenticated request
 *     answered 401 once the token reached its `expires_at` drops the cached
 *     session, logs in once more and is retried once; a second 401 is the
 *     request's answer, with no third signin. A 401 on a token that has not
 *     expired spends no signin, even when every poll of a wait gets one --
 *     otherwise a persistent 401 would burn the signin budget in seconds.
 *     Without `expires_at`, a session younger than five minutes is not
 *     renewed.
 * 10. A kept signin refusal expires with the server's fifteen-minute window,
 *     so a long-lived process recovers without a restart.
 * 11. The cached session belongs to one password. A driver with another
 *     password on the same server and account signs in itself rather than
 *     borrowing the session, and a refusal kept for a wrong password does not
 *     block a corrected one. The refusal never quotes the password.
 *
 * Each row gets its own server URL because the session cache is module-level
 * and keyed by server, account and password: a shared key would let one row's cached
 * refusal decide the next row's verdict.
 *
 * Offline: answers every request from a closure. Opens no socket.
 */

import {
  CSMS_OPERATION_16_ACTIONS,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  createCodeticsEvServerLiteCsmsDriver,
  type CsmsDriver,
  type CsmsOperation16,
  type EvslChargingProfile,
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
  return `http://evsl-row-${rowSeq}.test`;
}

type Classification = "dispatched" | "not-dispatched" | "unsupported" | "plain-error";

function classify(err: unknown): Exclude<Classification, "dispatched"> | "not-an-error" {
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

type Handler = () => Response | Promise<Response>;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

const CSRF_OK: Handler = () =>
  json({ token: "csrf-1", headerName: "X-XSRF-TOKEN" }, 200, {
    "set-cookie": "XSRF-TOKEN=csrf-1; Path=/",
  });
const SIGNIN_OK: Handler = () => json({ token: "bearer-1" });
const REFUSED: Handler = () => Promise.reject(new TypeError("connect ECONNREFUSED"));
const unavailable =
  (body = "busy"): Handler =>
  () =>
    new Response(body, { status: 503 });

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

interface Server {
  readonly fetch: FetchLike;
  readonly count: { csrf: number; signin: number; post: number; poll: number };
  readonly sent: Sent[];
}

interface Routes {
  csrf?: Handler[];
  signin?: Handler[];
  post?: Handler[];
  poll?: Handler[];
}

/**
 * Routes by method and path. Each route is a queue of handlers; the last one
 * repeats, so `[fail, ok]` is "fails once, then answers". The default poll
 * answers SENT, so a row about the payload resolves on the first read.
 */
function server(routes: Routes): Server {
  const count = { csrf: 0, signin: 0, post: 0, poll: 0 };
  const sent: Sent[] = [];
  const take = (queue: Handler[] | undefined, n: number, fallback: Handler): Handler => {
    if (queue === undefined || queue.length === 0) return fallback;
    return queue[Math.min(n, queue.length - 1)]!;
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(input).pathname;
    sent.push({
      method,
      path,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (method === "GET" && path === "/api/v1/auth/csrf") {
      return take(routes.csrf, count.csrf++, CSRF_OK)();
    }
    if (method === "POST" && path === "/api/v1/auth/app/signin") {
      return take(routes.signin, count.signin++, SIGNIN_OK)();
    }
    if (method === "POST" && /^\/api\/v1\/stations\/[^/]+\/commands$/.test(path)) {
      return take(routes.post, count.post++, () => json({ id: "cmd-1", state: "QUEUED" }))();
    }
    if (method === "GET" && path === "/api/v1/commands") {
      return take(routes.poll, count.poll++, row("SENT"))();
    }
    return json({ error: `unexpected ${method} ${path}` }, 404);
  };
  return { fetch: fetchImpl, count, sent };
}

function row(state: string, result: unknown = null): Handler {
  return () =>
    json([
      { id: "someone-else", station_id: "CP1", action: "Reset", state: "SENT", result: null },
      { id: "cmd-1", station_id: "CP1", action: "Reset", state, result },
    ]);
}

const PROFILES: Readonly<Record<string, EvslChargingProfile>> = {
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

function driverFor(
  url: string,
  srv: Server,
  dispatchTimeoutMs = 400,
  withProfiles = true,
): CsmsDriver {
  return createCodeticsEvServerLiteCsmsDriver({
    config: {
      apiUrl: url,
      tenant: "codetics",
      email: "admin@example.com",
      password: "a-password-of-16-chars",
      dispatchTimeoutMs,
    },
    ...(withProfiles ? { refs: { chargingProfileByRef: (ref) => PROFILES[ref] } } : {}),
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

// ---------------------------------------------------------------------------
// Parts 1-3: dispatch
// ---------------------------------------------------------------------------

interface DispatchCase {
  readonly what: string;
  readonly routes: Routes;
  readonly expect: Classification;
  /** Substrings the message must carry. */
  readonly carries?: readonly string[];
}

async function checkDispatch(part: string, kase: DispatchCase): Promise<void> {
  const what = `${part}: ${kase.what}`;
  const srv = server(kase.routes);
  const result = await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP1", RESET));
  const outcome = result.ok ? "dispatched" : classify(result.err);
  if (outcome !== kase.expect) {
    check(
      false,
      `${what}: expected ${kase.expect}, got ${outcome}${result.ok ? "" : ` (${message(result.err)})`}`,
    );
    return;
  }
  for (const s of kase.carries ?? []) {
    check(
      message(result.err).includes(s),
      `${what}: message lacks ${JSON.stringify(s)}: ${message(result.err)}`,
    );
  }
}

const STATE_CASES: DispatchCase[] = [
  { what: "SENT", routes: { poll: [row("SENT")] }, expect: "dispatched" },
  {
    what: "SUCCEEDED",
    routes: { poll: [row("SUCCEEDED", { status: "Accepted" })] },
    expect: "dispatched",
  },
  {
    what: "FAILED with the station's CALLERROR as result",
    routes: { poll: [row("FAILED", [4, "cmd-1", "NotImplemented", "", {}])] },
    expect: "dispatched",
  },
  {
    what: "QUEUED, then SENT",
    routes: { poll: [row("QUEUED"), row("SENT")] },
    expect: "dispatched",
  },
  {
    what: "FAILED with no result",
    routes: { poll: [row("FAILED", null)] },
    expect: "not-dispatched",
    carries: ["command cmd-1", "FAILED with no result"],
  },
  {
    what: "TIMED_OUT",
    routes: { poll: [row("TIMED_OUT")] },
    expect: "not-dispatched",
    carries: ["command cmd-1", "TIMED_OUT"],
  },
  {
    what: "CANCELLED",
    routes: { poll: [row("CANCELLED")] },
    expect: "not-dispatched",
    carries: ["command cmd-1", "CANCELLED"],
  },
  {
    what: "QUEUED past the wait",
    routes: { poll: [row("QUEUED")] },
    expect: "not-dispatched",
    carries: ["command cmd-1", "still QUEUED"],
  },
  {
    what: "a state the driver does not know",
    routes: { poll: [row("PAUSED")] },
    expect: "plain-error",
    carries: ["PAUSED"],
  },
];
for (const kase of STATE_CASES) await checkDispatch("part 1", kase);

const POST_CASES: DispatchCase[] = [
  {
    what: "a POST whose fetch rejects",
    routes: { post: [REFUSED] },
    expect: "not-dispatched",
    carries: ["/commands", "ECONNREFUSED"],
  },
  {
    what: "a POST refused 400",
    routes: { post: [() => json({ message: "payload invalide" }, 400)] },
    expect: "not-dispatched",
    carries: ["returned 400", "payload invalide"],
  },
  {
    what: "a POST refused 503",
    routes: { post: [unavailable("down")] },
    expect: "not-dispatched",
    carries: ["returned 503"],
  },
  {
    what: "a POST answered 200 without a command id",
    routes: { post: [() => json({ state: "QUEUED" })] },
    expect: "plain-error",
    carries: ["without a command id"],
  },
  {
    what: "a POST answered 200 with an empty body",
    routes: { post: [() => new Response("", { status: 200 })] },
    expect: "plain-error",
    carries: ["without a command id"],
  },
  {
    what: "a POST answered 200 whose body will not read",
    routes: {
      post: [
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("stream reset"));
              },
            }),
            { status: 200 },
          ),
      ],
    },
    expect: "plain-error",
    carries: ["answered 200 but its body could not be read", "stream reset"],
  },
  {
    what: "a POST answered 200 with a body that is not JSON",
    routes: { post: [() => new Response("<html>proxy</html>", { status: 200 })] },
    expect: "plain-error",
    carries: ["unparseable body", "<html>proxy"],
  },
];
for (const kase of POST_CASES) await checkDispatch("part 2", kase);

const READ_CASES: DispatchCase[] = [
  {
    what: "a poll refused 503 once, then SENT",
    routes: { poll: [unavailable(), row("SENT")] },
    expect: "dispatched",
  },
  {
    what: "a poll whose fetch rejects once, then SENT",
    routes: { poll: [REFUSED, row("SENT")] },
    expect: "dispatched",
  },
  {
    what: "a poll refused 503 for the whole wait",
    routes: { poll: [unavailable()] },
    expect: "plain-error",
    carries: ["command cmd-1", "returned 503"],
  },
  {
    what: "a poll whose fetch rejects for the whole wait",
    routes: { poll: [REFUSED] },
    expect: "plain-error",
    carries: ["command cmd-1", "ECONNREFUSED"],
  },
  {
    what: "a poll answered with something that is not a list",
    routes: { poll: [() => json({ content: [] })] },
    expect: "plain-error",
    carries: ["command cmd-1"],
  },
  {
    what: "a QUEUED command whose later reads fail",
    routes: { poll: [row("QUEUED"), unavailable()] },
    expect: "plain-error",
    carries: ["command cmd-1", "returned 503"],
  },
  {
    what: "a command the list never shows",
    routes: { poll: [() => json([])] },
    expect: "plain-error",
    carries: ["command cmd-1", "last 100 commands"],
  },
];
for (const kase of READ_CASES) await checkDispatch("part 3", kase);

// ---------------------------------------------------------------------------
// Parts 4-6: the login
// ---------------------------------------------------------------------------

/** Two drivers of one fresh server dispatching in turn: the second sees
 *  whatever the first left in the session cache. */
async function twoCalls(routes: Routes) {
  const url = freshUrl();
  const srv = server(routes);
  const first = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  const second = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  return { first, second, srv };
}

function expectOneLogin(what: string, srv: Server): void {
  check(
    srv.count.csrf === 1 && srv.count.signin === 1,
    `${what}: expected one csrf read and one signin, got ${srv.count.csrf} and ${srv.count.signin}`,
  );
}

{
  const what = "part 4: three concurrent drivers";
  const url = freshUrl();
  const srv = server({});
  const results = await Promise.all(
    [0, 1, 2].map(() => outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET))),
  );
  check(
    results.every((r) => r.ok),
    `${what}: expected all three to succeed: ${results.map((r) => message(r.err)).join("; ")}`,
  );
  expectOneLogin(what, srv);
}

interface RetryCase {
  readonly what: string;
  readonly routes: Routes;
  /** Signins the server should have seen after the second call. */
  readonly signins: number;
  /** Substrings the FIRST failure's message must NOT carry. */
  readonly omits?: readonly string[];
}

const RETRY_CASES: RetryCase[] = [
  { what: "csrf read whose fetch rejects", routes: { csrf: [REFUSED, CSRF_OK] }, signins: 1 },
  {
    what: "csrf read refused 503",
    routes: { csrf: [unavailable("booting"), CSRF_OK] },
    signins: 1,
  },
  {
    what: "csrf read answered 200 without a token",
    routes: { csrf: [() => json({}), CSRF_OK] },
    signins: 1,
  },
  { what: "signin whose fetch rejects", routes: { signin: [REFUSED, SIGNIN_OK] }, signins: 2 },
  {
    what: "signin refused 503",
    routes: { signin: [unavailable("down"), SIGNIN_OK] },
    signins: 2,
    omits: ["will not try again"],
  },
  {
    what: "signin answered 200 without a token",
    routes: { signin: [() => json({ user: {} }), SIGNIN_OK] },
    signins: 2,
  },
];

for (const kase of RETRY_CASES) {
  const what = `part 5: ${kase.what}`;
  const { first, second, srv } = await twoCalls(kase.routes);
  if (first.ok) {
    check(false, `${what}: the first call was expected to fail`);
    continue;
  }
  for (const s of kase.omits ?? []) {
    check(
      !message(first.err).includes(s),
      `${what}: the first failure claims ${JSON.stringify(s)}: ${message(first.err)}`,
    );
  }
  if (!second.ok) {
    check(false, `${what}: the second call did not log in again: ${message(second.err)}`);
    continue;
  }
  check(
    srv.count.signin === kase.signins,
    `${what}: expected ${kase.signins} signin(s), got ${srv.count.signin}`,
  );
}

for (const status of [401, 403, 429]) {
  const what = `part 6: signin refused ${status}`;
  const { first, second, srv } = await twoCalls({
    signin: [() => json({ message: "Identifiants incorrects." }, status), SIGNIN_OK],
  });
  if (first.ok || second.ok) {
    check(false, `${what}: both calls were expected to fail`);
    continue;
  }
  check(
    classify(first.err) === "not-dispatched",
    `${what}: expected a non-dispatch, got ${classify(first.err)}: ${message(first.err)}`,
  );
  check(
    message(first.err).includes("will not try again"),
    `${what}: the message does not say the process will not retry: ${message(first.err)}`,
  );
  expectOneLogin(what, srv);
}

// ---------------------------------------------------------------------------
// Parts 7-8: the wire and the refusing arms
// ---------------------------------------------------------------------------

/** The `{action, payload}` body the command endpoint received, raw. */
async function commandBody(operation: CsmsOperation16): Promise<string | undefined> {
  const srv = server({});
  const result = await outcomeOf(
    driverFor(freshUrl(), srv).operations16.execute("CP 1", operation),
  );
  check(result.ok, `part 7: ${operation.action} failed: ${message(result.err)}`);
  return srv.sent.find((s) => s.method === "POST" && s.path.endsWith("/commands"))?.body;
}

{
  const srv = server({});
  await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP 1", RESET));
  const signin = srv.sent.find((s) => s.path === "/api/v1/auth/app/signin");
  check(
    signin?.headers.get("x-xsrf-token") === "csrf-1" &&
      signin.headers.get("cookie") === "XSRF-TOKEN=csrf-1",
    "part 7: the signin does not carry the CSRF pair",
  );
  check(
    signin?.body ===
      '{"tenant":"codetics","email":"admin@example.com","password":"a-password-of-16-chars"}',
    `part 7: unexpected signin body ${signin?.body}`,
  );
  const post = srv.sent.find((s) => s.method === "POST" && s.path.endsWith("/commands"));
  check(
    post?.path === "/api/v1/stations/CP%201/commands",
    `part 7: the station id is not encoded in the command path: ${post?.path}`,
  );
  check(
    post?.headers.get("authorization") === "Bearer bearer-1" &&
      post.headers.get("x-xsrf-token") === "csrf-1" &&
      post.headers.get("cookie") === "XSRF-TOKEN=csrf-1",
    "part 7: the command POST does not carry the bearer token and the CSRF pair",
  );
  check(
    post?.body === '{"action":"Reset","payload":{"type":"Soft"}}',
    `part 7: Reset body ${post?.body}`,
  );
  const poll = srv.sent.find((s) => s.path === "/api/v1/commands");
  check(
    poll?.headers.get("authorization") === "Bearer bearer-1" && !poll.headers.has("x-xsrf-token"),
    "part 7: a read must carry the bearer token and no CSRF header",
  );
}

const WIRE_CASES: readonly { operation: CsmsOperation16; body: string }[] = [
  {
    operation: {
      action: "SendLocalList",
      listVersion: 2,
      updateType: "Differential",
      localAuthorizationList: [
        { idTag: "TAG-2", status: "Accepted", parentIdTag: "PARENT" },
        { idTag: "TAG-3" },
      ],
    },
    body:
      '{"action":"SendLocalList","payload":{"listVersion":2,"localAuthorizationList":' +
      '[{"idTag":"TAG-2","idTagInfo":{"status":"Accepted","parentIdTag":"PARENT"}},' +
      '{"idTag":"TAG-3"}],"updateType":"Differential"}}',
  },
  {
    operation: {
      action: "SetChargingProfile",
      connectorId: 1,
      chargingProfile: "tx-default",
      transaction: "42",
    },
    body:
      '{"action":"SetChargingProfile","payload":{"connectorId":1,"csChargingProfiles":' +
      '{"chargingProfileId":56,"stackLevel":0,"chargingProfilePurpose":"TxDefaultProfile",' +
      '"chargingProfileKind":"Relative","chargingSchedule":{"chargingRateUnit":"W",' +
      '"chargingSchedulePeriod":[{"startPeriod":0,"limit":11000}]},"transactionId":42}}}',
  },
  {
    operation: { action: "RemoteStopTransaction", transaction: "17" },
    body: '{"action":"RemoteStopTransaction","payload":{"transactionId":17}}',
  },
  {
    operation: { action: "ClearChargingProfile", chargingProfile: "tx-default", connectorId: 1 },
    body: '{"action":"ClearChargingProfile","payload":{"id":56,"connectorId":1}}',
  },
  {
    operation: { action: "GetConfiguration" },
    body: '{"action":"GetConfiguration","payload":{}}',
  },
];
for (const kase of WIRE_CASES) {
  const body = await commandBody(kase.operation);
  check(
    body === kase.body,
    `part 7: ${kase.operation.action} body\n  got  ${body}\n  want ${kase.body}`,
  );
}

{
  const body = await commandBody({
    action: "ReserveNow",
    connectorId: 1,
    expiryDate: new Date("2026-01-01T00:00:00Z"),
    idTag: "TAG-1",
  });
  const payload = (JSON.parse(body ?? "{}") as { payload?: { reservationId?: unknown } }).payload;
  check(
    Number.isInteger(payload?.reservationId) && (payload?.reservationId as number) >= 0,
    `part 7: ReserveNow without a reservation ref must allocate an id: ${body}`,
  );
}

interface RefusalCase {
  readonly what: string;
  readonly operation: CsmsOperation16;
  readonly expect: Classification;
  readonly withProfiles?: boolean;
}

const REFUSAL_CASES: RefusalCase[] = [
  {
    what: "a GetConfiguration key list",
    operation: { action: "GetConfiguration", keys: ["HeartbeatInterval"] },
    expect: "unsupported",
  },
  {
    what: "a charging-profile ref the lookup does not know",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "unknown" },
    expect: "plain-error",
  },
  {
    what: "a charging-profile ref with no lookup at all",
    operation: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "tx-default" },
    expect: "plain-error",
    withProfiles: false,
  },
  {
    what: "a transaction ref that is not an integer",
    operation: { action: "RemoteStopTransaction", transaction: "" },
    expect: "plain-error",
  },
];
for (const kase of REFUSAL_CASES) {
  const what = `part 8: ${kase.what}`;
  const srv = server({});
  const result = await outcomeOf(
    driverFor(freshUrl(), srv, 400, kase.withProfiles ?? true).operations16.execute(
      "CP1",
      kase.operation,
    ),
  );
  const outcome = result.ok ? "dispatched" : classify(result.err);
  check(outcome === kase.expect, `${what}: expected ${kase.expect}, got ${outcome}`);
  check(srv.count.post === 0, `${what}: a refused operation must queue nothing`);
}

{
  const driver = driverFor(freshUrl(), server({}));
  const actions = driver.capabilities.operations16;
  check(
    actions.size === CSMS_OPERATION_16_ACTIONS.length &&
      CSMS_OPERATION_16_ACTIONS.every((a) => actions.has(a)),
    "part 8: capabilities must declare every OCPP 1.6 action",
  );
  check(
    driver.capabilities.operations201 === undefined && driver.operations201 === undefined,
    "part 8: the driver must not claim OCPP 2.0.1",
  );
  check(
    driver.capabilities.chargePoints === undefined && driver.chargePoints === undefined,
    "part 8: the driver must not claim charge-point administration",
  );
}

// ---------------------------------------------------------------------------
// Parts 9-10: a long-lived process
// ---------------------------------------------------------------------------

const EXPIRED: Handler = () => json({ message: "token expired" }, 401);
const SIGNIN_EXPIRED: Handler = () =>
  json({ token: "bearer-old", expires_at: "2000-01-01T00:00:00Z" });
const SIGNIN_VALID: Handler = () => json({ token: "bearer-1", expires_at: "2999-01-01T00:00:00Z" });

{
  const what = "part 9: an expired token, a command POST answered 401 once";
  const url = freshUrl();
  const srv = server({
    signin: [SIGNIN_EXPIRED, SIGNIN_VALID],
    post: [EXPIRED, () => json({ id: "cmd-1", state: "QUEUED" })],
  });
  const first = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(first.ok, `${what}: expected a fresh login and a retried POST: ${message(first.err)}`);
  check(
    srv.count.signin === 2 && srv.count.post === 2,
    `${what}: expected 2 signins and 2 POSTs, got ${srv.count.signin} and ${srv.count.post}`,
  );
  const second = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
  check(
    second.ok && srv.count.signin === 2,
    `${what}: the next call must reuse the fresh session, got ${srv.count.signin} signins`,
  );
}

{
  const what = "part 9: an expired token, a command POST answered 401 twice";
  const srv = server({ signin: [SIGNIN_EXPIRED], post: [EXPIRED] });
  const result = await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP1", RESET));
  check(
    !result.ok && classify(result.err) === "not-dispatched",
    `${what}: expected a non-dispatch, got ${result.ok ? "dispatched" : classify(result.err)}`,
  );
  check(
    srv.count.signin === 2 && srv.count.post === 2,
    `${what}: expected one retry, got ${srv.count.signin} signins and ${srv.count.post} POSTs`,
  );
}

{
  const what = "part 9: a valid token, every poll of the wait answered 401";
  const srv = server({ signin: [SIGNIN_VALID], poll: [EXPIRED] });
  const result = await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP1", RESET));
  check(
    !result.ok && classify(result.err) === "plain-error",
    `${what}: expected a plain Error, got ${result.ok ? "dispatched" : classify(result.err)}`,
  );
  check(
    srv.count.signin === 1 && srv.count.poll > 1,
    `${what}: expected one signin over ${srv.count.poll} polls, got ${srv.count.signin}`,
  );
}

{
  const what = "part 9: no expires_at, a command POST answered 401";
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  try {
    const url = freshUrl();
    const srv = server({ post: [EXPIRED, EXPIRED, () => json({ id: "cmd-1", state: "QUEUED" })] });
    const young = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
    check(
      !young.ok && srv.count.signin === 1,
      `${what}: a session younger than five minutes must not be renewed, got ${srv.count.signin} signins`,
    );
    offsetMs = 5 * 60_000;
    const old = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
    check(
      old.ok && srv.count.signin === 2,
      `${what}: a five-minute-old session must be renewed, got ${srv.count.signin} signins` +
        (old.ok ? "" : `: ${message(old.err)}`),
    );
  } finally {
    Date.now = realNow;
  }
}

{
  const what = "part 10: a 429 signin refusal after fifteen minutes";
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  try {
    const url = freshUrl();
    const srv = server({ signin: [() => json({}, 429), SIGNIN_OK] });
    const first = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
    offsetMs = 14 * 60_000;
    const within = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
    check(
      !first.ok && !within.ok && srv.count.signin === 1,
      `${what}: the refusal must hold within the window, got ${srv.count.signin} signins`,
    );
    offsetMs = 15 * 60_000;
    const after = await outcomeOf(driverFor(url, srv).operations16.execute("CP1", RESET));
    check(
      after.ok && srv.count.signin === 2,
      `${what}: expected a new login after the window, got ${srv.count.signin} signins` +
        (after.ok ? "" : `: ${message(after.err)}`),
    );
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------------------
// Part 11: the cached session belongs to one password
// ---------------------------------------------------------------------------

function driverWithPassword(url: string, srv: Server, password: string): CsmsDriver {
  return createCodeticsEvServerLiteCsmsDriver({
    config: { apiUrl: url, tenant: "codetics", email: "admin@example.com", password },
    fetch: srv.fetch,
  });
}

{
  const what = "part 11: a second password after a successful login";
  const url = freshUrl();
  const srv = server({});
  const right = await outcomeOf(
    driverWithPassword(url, srv, "the-right-password").operations16.execute("CP1", RESET),
  );
  await outcomeOf(
    driverWithPassword(url, srv, "a-wrong-password").operations16.execute("CP1", RESET),
  );
  const signins = srv.sent.filter((s) => s.path === "/api/v1/auth/app/signin");
  check(
    right.ok && signins.length === 2,
    `${what}: expected the second password to sign in itself, got ${signins.length} signins`,
  );
  check(
    signins[1]?.body?.includes("a-wrong-password") === true,
    `${what}: expected the second signin to carry the second password`,
  );
}

{
  const what = "part 11: a refusal kept for one password, then a corrected one";
  const url = freshUrl();
  const srv = server({ signin: [() => json({}, 401), SIGNIN_OK] });
  const wrong = await outcomeOf(
    driverWithPassword(url, srv, "a-wrong-password").operations16.execute("CP1", RESET),
  );
  const corrected = await outcomeOf(
    driverWithPassword(url, srv, "the-right-password").operations16.execute("CP1", RESET),
  );
  check(
    !wrong.ok && corrected.ok && srv.count.signin === 2,
    `${what}: expected the corrected password to sign in, got ${srv.count.signin} signins` +
      (corrected.ok ? "" : `: ${message(corrected.err)}`),
  );
  check(
    !wrong.ok && !message(wrong.err).includes("a-wrong-password"),
    `${what}: the refusal message quotes the password: ${message(wrong.err)}`,
  );
}

if (failures.length > 0) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  console.error(
    `\n${failures.length} failure(s). This guard holds two lines of the ev-server-lite ` +
      "driver: which failures say the charge point was never asked -- an accepted " +
      "command whose state could not be read is not one -- and which login failures " +
      "the process remembers. Remembering one the server did not count fails every " +
      "later call; forgetting one it did walks the account into its " +
      "ten-per-fifteen-minutes lockout.",
  );
  process.exit(1);
}
console.log("codetics-ev-server-lite driver: OK");

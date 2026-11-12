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
 * PROPERTY, in 14 parts:
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
 *     every OCPP 1.6 action and no OCPP 2.0.1.
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
 * 12. `commands` reports the same states as VALUES: QUEUED past the wait is
 *     `accepted`, SUCCEEDED `confirmed` (or `rejected` when the station
 *     answered Rejected/NotSupported), FAILED with a result `failed`, SENT
 *     that never resolves within the wait `unknown` (`timeout`), never
 *     `failed`. `ref` is the command id, `poll` reads it back and answers
 *     `null` for a ref the list does not show. A request that never became a
 *     CALL still throws exactly as `execute` does, and no outcome quotes the
 *     password or the bearer token. `execute` is untouched.
 * 13. `chargePoints` passes the shared conformance suite against a fake admin
 *     API, under the default configuration and with `allowUnauthenticated` and
 *     `clientCaConfigured`; nothing is skipped that the declaration makes
 *     applicable, and the declaration is the one the server supports: profile
 *     1 always, 0 and 3 only when configured, never 2, only Accepted,
 *     generated passwords, a required description.
 * 14. What the suite cannot see. The generated secret is returned once and by
 *     no read; a station created on profile 0 or 3 does not return the secret
 *     the server made on the way; `update` replaces the record with every
 *     member it read, not just the one it changed; `delete` resolves a 404 and
 *     answers a 409 (active session) with a plain `Error`, not an
 *     UnsupportedOperationError or a CsmsNotDispatchedError; a refused call
 *     sends no request at all; and no request, answer or error quotes the
 *     admin password.
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
  codeticsEvServerLiteCapabilities,
  createCodeticsEvServerLiteCsmsDriver,
  type CsmsDriver,
  type CsmsOperation16,
  type EvslChargingProfile,
  type FetchLike,
} from "@ovarilo/csms-drivers";

import { chargePointAdminConformance } from "@ovarilo/csms-drivers/conformance";
import { fakeCodeticsAdmin } from "./fixtures/fake-codetics-admin.ts";

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
    driver.capabilities.chargePoints !== undefined && driver.chargePoints !== undefined,
    "part 8: the driver declares charge-point administration, and part 13 holds it",
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
// ---------------------------------------------------------------------------
// Part 12: commands
// ---------------------------------------------------------------------------

function commandsOf(srv: Server, dispatchTimeoutMs = 400) {
  const commands = driverFor(freshUrl(), srv, dispatchTimeoutMs).commands;
  check(commands !== undefined, "12: driver.commands is missing");
  return commands!;
}

{
  const caps = driverFor(freshUrl(), server({})).capabilities.commands;
  check(
    caps?.completion === "confirmed" && caps.polling === true,
    `12: capabilities.commands expected confirmed + polling, got ${JSON.stringify(caps)}`,
  );
}

interface OutcomeCase {
  readonly what: string;
  readonly poll: Handler[];
  readonly state: string;
  readonly cause?: string;
}

const OUTCOME_CASES: OutcomeCase[] = [
  { what: "QUEUED past the wait", poll: [row("QUEUED")], state: "accepted" },
  {
    what: "SUCCEEDED",
    poll: [row("SUCCEEDED", { status: "Accepted" })],
    state: "confirmed",
  },
  {
    what: "SUCCEEDED, Rejected",
    poll: [row("SUCCEEDED", { status: "Rejected" })],
    state: "rejected",
  },
  {
    what: "SUCCEEDED, NotSupported",
    poll: [row("SUCCEEDED", { status: "NotSupported" })],
    state: "rejected",
  },
  {
    what: "FAILED with a CALLERROR",
    poll: [row("FAILED", { errorCode: "InternalError" })],
    state: "failed",
  },
  { what: "SENT, never answered", poll: [row("SENT")], state: "unknown", cause: "timeout" },
  {
    what: "SENT, then the server's own TIMED_OUT",
    poll: [row("SENT"), row("TIMED_OUT")],
    state: "unknown",
    cause: "timeout",
  },
  {
    what: "QUEUED then SENT then SUCCEEDED",
    poll: [row("QUEUED"), row("SENT"), row("SUCCEEDED", { status: "Accepted" })],
    state: "confirmed",
  },
];

for (const kase of OUTCOME_CASES) {
  const what = `12: submit16 ${kase.what}`;
  const out = await commandsOf(server({ poll: kase.poll }), 600).submit16("CP1", RESET);
  check(out.state === kase.state, `${what}: expected ${kase.state}, got ${JSON.stringify(out)}`);
  if (out.state === "unknown") {
    check(out.cause === kase.cause, `${what}: expected cause ${kase.cause}, got ${out.cause}`);
  }
  if (out.state !== "unsupported") {
    check(!Number.isNaN(Date.parse(out.at)), `${what}: \`at\` is not an instant: ${out.at}`);
  }
  if (out.state !== "unsupported" && out.state !== "rejected") {
    check(out.ref === "cmd-1", `${what}: expected ref cmd-1, got ${out.ref}`);
  }
}

{
  const out = await commandsOf(
    server({ poll: [row("SUCCEEDED", { status: "Accepted" })] }),
  ).submit16("CP1", RESET);
  check(
    out.state === "confirmed" && JSON.stringify(out.response) === '{"status":"Accepted"}',
    `12: confirmed carries the station's result, got ${JSON.stringify(out)}`,
  );
}

for (const [what, routes, expect] of [
  ["FAILED with no result", { poll: [row("FAILED")] }, "not-dispatched"],
  ["CANCELLED", { poll: [row("CANCELLED")] }, "not-dispatched"],
  ["TIMED_OUT with no SENT observed", { poll: [row("TIMED_OUT")] }, "not-dispatched"],
  ["a refused POST", { post: [unavailable()] }, "not-dispatched"],
] as [string, Routes, Classification][]) {
  const r = await outcomeOf(commandsOf(server(routes)).submit16("CP1", RESET));
  const got = r.ok ? "dispatched" : classify(r.err);
  check(got === expect, `12: submit16 ${what}: expected a ${expect} throw, got ${got}`);
}

{
  const srv = server({});
  const r = await outcomeOf(
    commandsOf(srv).submit16("CP1", { action: "GetConfiguration", keys: ["A"] }),
  );
  check(
    classify(r.err) === "unsupported" && srv.count.post === 0,
    `12: a GetConfiguration key list expected an unsupported throw and no POST, got ${classify(r.err)} / ${srv.count.post} POSTs`,
  );
}

{
  // A command that is queued but whose state cannot be read is not a verdict
  // on the wire: no evidence, with the ref to poll later.
  const out = await commandsOf(server({ poll: [unavailable()] }), 300).submit16("CP1", RESET);
  check(
    out.state === "unknown" && out.cause === "no-evidence" && out.ref === "cmd-1",
    `12: an unreadable state expected unknown/no-evidence, got ${JSON.stringify(out)}`,
  );
}

{
  const ac = new AbortController();
  const srv = server({ poll: [row("SENT")] });
  setTimeout(() => ac.abort(), 100);
  const out = await commandsOf(srv, 5000).submit16("CP1", RESET, { signal: ac.signal });
  check(
    out.state === "unknown" && out.cause === "no-evidence",
    `12: an aborted wait after dispatch expected unknown, got ${JSON.stringify(out)}`,
  );
}

{
  const commands = commandsOf(
    server({ poll: [row("SUCCEEDED", { status: "Accepted" }), row("SENT"), row("FAILED", {})] }),
  );
  const polled = await commands.poll?.("cmd-1");
  check(polled?.state === "confirmed", `12: poll of a known ref, got ${JSON.stringify(polled)}`);
  const missing = await commandsOf(server({})).poll?.("never-queued");
  check(
    missing === null,
    `12: poll of an unknown ref expected null, got ${JSON.stringify(missing)}`,
  );
  const pending = await commandsOf(server({ poll: [row("SENT")] })).poll?.("cmd-1");
  check(
    pending?.state === "accepted",
    `12: poll of SENT expected accepted, got ${JSON.stringify(pending)}`,
  );
  const timedOut = await commandsOf(server({ poll: [row("TIMED_OUT")] })).poll?.("cmd-1");
  check(
    timedOut?.state === "unknown" && timedOut.cause === "timeout",
    `12: poll of TIMED_OUT expected unknown/timeout, got ${JSON.stringify(timedOut)}`,
  );
  const unread = await outcomeOf(
    commandsOf(server({ poll: [unavailable()] })).poll?.("cmd-1") ?? Promise.resolve(null),
  );
  check(classify(unread.err) === "plain-error", "12: poll that cannot read expected a plain Error");
}

{
  const srv = server({ poll: [row("FAILED", { errorCode: "InternalError" })] });
  const out = await commandsOf(srv).submit16("CP1", RESET);
  const text = JSON.stringify(out);
  check(
    !text.includes("a-password-of-16-chars") && !text.includes("bearer-1"),
    `12: an outcome quotes a secret: ${text}`,
  );
}

{
  // execute() keeps its contract beside the new surface.
  const srv = server({ poll: [row("SENT")] });
  const r = await outcomeOf(driverFor(freshUrl(), srv).operations16.execute("CP1", RESET));
  check(r.ok, "12: execute resolves at SENT as before");
}

// ---------------------------------------------------------------------------
// Parts 13-14: charge-point administration
// ---------------------------------------------------------------------------

const ADMIN_CONFIG = (apiUrl: string) => ({
  apiUrl,
  tenant: "codetics",
  email: "admin@example.test",
  password: "a-password-of-16-chars",
});

{
  const variants: readonly [
    string,
    { allowUnauthenticated?: boolean; clientCaConfigured?: boolean },
    number[],
  ][] = [
    ["default", {}, [1]],
    ["allowUnauthenticated", { allowUnauthenticated: true }, [0, 1]],
    ["clientCaConfigured", { clientCaConfigured: true }, [1, 3]],
    ["both", { allowUnauthenticated: true, clientCaConfigured: true }, [0, 1, 3]],
  ];
  for (const [name, options, profiles] of variants) {
    const admin = fakeCodeticsAdmin();
    const driver = createCodeticsEvServerLiteCsmsDriver({
      config: ADMIN_CONFIG(freshUrl()),
      fetch: admin.fetch,
      ...options,
    });
    const declared = driver.capabilities.chargePoints;
    check(
      declared !== undefined &&
        [...declared.securityProfiles].sort().join() === profiles.join() &&
        declared.registrations?.size === 1 &&
        declared.registrations.has("Accepted") &&
        declared.basicAuthPassword === "generated" &&
        declared.description === "required",
      `13 (${name}): the declaration must be profiles ${profiles.join()}, Accepted only, generated, required`,
    );
    const config = codeticsEvServerLiteCapabilities(options).chargePoints;
    check(
      config !== undefined && [...config.securityProfiles].sort().join() === profiles.join(),
      `13 (${name}): the builder must derive the same profiles without a client`,
    );
    const report = await chargePointAdminConformance(driver);
    check(
      report.failed.length === 0,
      `13 (${name}): the conformance suite must pass: ${JSON.stringify(report.failed)}`,
    );
    check(
      report.passed.length > 0,
      `13 (${name}): the conformance suite must have passed some rules, not skipped them all`,
    );
    check(admin.stations.size === 0, `13 (${name}): the suite must leave no station behind`);
  }
}

{
  const admin = fakeCodeticsAdmin();
  const driver = createCodeticsEvServerLiteCsmsDriver({
    config: ADMIN_CONFIG(freshUrl()),
    fetch: admin.fetch,
    allowUnauthenticated: true,
    clientCaConfigured: true,
  });
  const cp = driver.chargePoints!;

  const created = await cp.create({ id: "CP A/1", security: { profile: 1 }, description: "bay" });
  const secret = created?.generatedBasicAuthPassword;
  check(
    secret === admin.stations.get("CP A/1")?.secret,
    "14: create returns the secret the server generated",
  );
  check(admin.sent[0]?.path === "/api/v1/stations", "14: create posts to /api/v1/stations");
  check(
    !JSON.stringify(await cp.get("CP A/1")).includes(secret ?? "?"),
    "14: no read returns the secret",
  );

  // Profile 0 and 3: the server starts on profile 1, so the driver moves the
  // station and must not hand back the secret it made on the way.
  for (const profile of [0, 3] as const) {
    const id = `CP-P${profile}`;
    const result = await cp.create({ id, security: { profile }, description: "x" });
    check(
      result === undefined || result.generatedBasicAuthPassword === undefined,
      `14: create on profile ${profile} returns no secret`,
    );
    check(
      admin.stations.get(id)?.securityProfile === profile,
      `14: create on profile ${profile} applies it`,
    );
    const move = admin.sent.filter((r) => r.path.endsWith(`/stations/${id}/security`));
    check(
      move.length === 1 &&
        JSON.stringify(move[0]?.body) ===
          JSON.stringify({ securityProfile: profile, sendToStation: false }),
      `14: profile ${profile} is applied server-side with sendToStation false`,
    );
  }

  // A profile 0 station, moved back to 1, gets a new secret.
  const back = await cp.update("CP-P0", { security: { profile: 1 } });
  check(
    typeof back?.generatedBasicAuthPassword === "string" &&
      back.generatedBasicAuthPassword === admin.stations.get("CP-P0")?.secret,
    "14: update to profile 1 returns the secret it generated",
  );

  // Read-modify-write: the server replaces the whole record, so a member the
  // driver did not send would be lost.
  admin.stations.get("CP A/1")!.enabled = true;
  admin.sent.length = 0;
  await cp.update("CP A/1", { description: "renamed" });
  const put = admin.sent.find((r) => r.method === "PUT");
  check(
    JSON.stringify(put?.body) ===
      JSON.stringify({ id: "CP A/1", name: "renamed", enabled: true, securityProfile: 1 }),
    `14: update replaces the record with every member it read: ${JSON.stringify(put?.body)}`,
  );
  check(
    admin.stations.get("CP A/1")?.enabled === true && cp !== undefined,
    "14: update keeps the members it did not name",
  );

  // delete
  admin.active.add("CP A/1");
  const busy = await cp.delete("CP A/1").then(
    () => null,
    (e: unknown) => e,
  );
  check(
    busy instanceof Error &&
      !(busy instanceof UnsupportedOperationError) &&
      !(busy instanceof CsmsNotDispatchedError) &&
      busy.constructor === Error &&
      busy.message.includes("409"),
    `14: delete during an active session is a plain Error naming 409: ${message(busy)}`,
  );
  check(admin.stations.has("CP A/1"), "14: a refused delete removes nothing");
  admin.active.clear();
  await cp.delete("CP A/1");
  await cp.delete("CP A/1");
  check(!admin.stations.has("CP A/1"), "14: delete removes, and a second delete resolves");

  // Refusals send nothing.
  admin.sent.length = 0;
  const refusals: [string, () => Promise<unknown>][] = [
    [
      "a supplied password",
      () =>
        cp.create({ id: "X", security: { profile: 1, basicAuthPassword: "pw" }, description: "d" }),
    ],
    ["profile 2", () => cp.create({ id: "X", security: { profile: 2 }, description: "d" })],
    ["a blank name", () => cp.create({ id: "X", security: { profile: 1 }, description: " " })],
    ["a missing name", () => cp.create({ id: "X", security: { profile: 1 } })],
    [
      "Pending",
      () =>
        cp.create({ id: "X", registration: "Pending", security: { profile: 1 }, description: "d" }),
    ],
    ["a null description", () => cp.update("CP-P0", { description: null })],
    ["a Rejected update", () => cp.update("CP-P0", { registration: "Rejected" })],
  ];
  for (const [what, run] of refusals) {
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    check(err instanceof UnsupportedOperationError, `14: ${what} is an UnsupportedOperationError`);
  }
  check(
    admin.sent.length === 0,
    `14: a refused call sends no request: ${JSON.stringify(admin.sent)}`,
  );

  check(
    !JSON.stringify(admin.sent).includes("a-password-of-16-chars"),
    "14: no admin request body carries the admin password",
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

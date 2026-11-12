// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * command-outcomes.ts -- the optional `commands` surface (`CsmsCommands`,
 * `capabilities.commands`) and what the HTTP adapter makes of it.
 *
 * PROPERTY, in 6 parts:
 *  1. OPT-IN AND BACKWARD COMPATIBLE. A driver without `commands` is served
 *     exactly as before: the 202 body has no `outcome`, `execute` is the call
 *     made, and `GET /v1/driver` reports `commands: null`. A declaration
 *     without the surface (or the reverse) reads as no surface.
 *  2. EVERY STATE IS A VALUE. unsupported, rejected, accepted, confirmed,
 *     failed and unknown each reach the client in `outcome` on a 202 that
 *     still says `status: "dispatched"`, with the driver's own fields intact.
 *     One request makes one `submit16` (never `submit201`) and no `execute`.
 *  3. A TIMEOUT IS NEVER A FAILURE. The deadline answers 504 `timeout`
 *     ("outcome unknown"), with no `outcome`; a driver reporting a timeout
 *     reports `unknown`/`timeout`, which is not `failed`. Errors keep their
 *     statuses (no `outcome` on 4xx/5xx).
 *  4. POLLING ONLY WHEN SUPPORTED. `GET /v1/commands/{ref}` answers the polled
 *     outcome, 404 `not_found` for an unknown ref, 501 `unsupported_capability`
 *     without polling (declared and implemented, both), 405 for other methods.
 *  5. NOTHING SECRET LEAVES. A configured secret inside `detail`, a station
 *     `response` (at any depth, keys included), a polled outcome or a polled
 *     ref is redacted; the log line carries no outcome.
 *  6. THE OUTCOME IS A WHITELIST. Only a state's documented fields are
 *     serialised (an extra property -- a receipt, a raw body -- is dropped),
 *     and an outcome that is not one of the six states is a daemon-side
 *     500 `internal`, never a 202 without `outcome`. The action gate (501)
 *     precedes the commands branch.
 */

import {
  CSMS_OPERATION_16_ACTIONS,
  CsmsNotDispatchedError,
  type CommandOutcome,
  type CommandRef,
  type CsmsCommands,
  type CsmsDriver,
  type CsmsOperation16,
} from "@ovarilo/csms-drivers";
import { createCsmsHttpHandler } from "@ovarilo/csms-drivers/server";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const AT = "2026-11-12T10:00:00.000Z";
const SECRET = "s3cret-token";

const STATES: Record<string, CommandOutcome> = {
  unsupported: { state: "unsupported", reason: "no such operation here" },
  rejected: { state: "rejected", at: AT, detail: "station said Rejected" },
  accepted: { state: "accepted", at: AT, ref: "cmd-1" },
  confirmed: { state: "confirmed", at: AT, ref: "cmd-1", response: { status: "Accepted" } },
  failed: { state: "failed", at: AT, ref: "cmd-1", detail: "CALLERROR InternalError" },
  unknown: { state: "unknown", at: AT, ref: "cmd-1", cause: "timeout", detail: "no answer" },
};

interface FakeOptions {
  /** Implements `commands`. Default true. */
  surface?: boolean;
  /** Declares `capabilities.commands`. Default: whatever `surface` is. */
  declare?: boolean;
  polling?: boolean;
  /** The declared 1.6 actions. Default: all of them. */
  actions?: readonly (typeof CSMS_OPERATION_16_ACTIONS)[number][];
  /** Implements `poll`. Default: `polling`. */
  implementPoll?: boolean;
  submit?: (cpId: string, op: unknown) => Promise<CommandOutcome>;
  poll?: (ref: CommandRef) => Promise<CommandOutcome | null>;
}

interface Seen {
  submits: { cpId: string; op: unknown }[];
  submits201: { cpId: string; op: unknown }[];
  executes: { cpId: string; op: CsmsOperation16 }[];
  polls: string[];
}

function fakeDriver(options: FakeOptions = {}): { driver: CsmsDriver; seen: Seen } {
  const seen: Seen = { submits: [], submits201: [], executes: [], polls: [] };
  const surface = options.surface ?? true;
  const declare = options.declare ?? surface;
  const polling = options.polling ?? false;
  const commands: CsmsCommands = {
    async submit16(cpId, op) {
      seen.submits.push({ cpId, op });
      return (options.submit ?? (async () => STATES.accepted!))(cpId, op);
    },
    async submit201(cpId, op) {
      seen.submits201.push({ cpId, op });
      return STATES.accepted!;
    },
    ...((options.implementPoll ?? polling)
      ? {
          async poll(ref: CommandRef) {
            seen.polls.push(ref);
            return (options.poll ?? (async () => STATES.confirmed!))(ref);
          },
        }
      : {}),
  };
  const driver: CsmsDriver = {
    capabilities: {
      operations16: new Set(options.actions ?? CSMS_OPERATION_16_ACTIONS),
      ...(declare ? { commands: { completion: "accepted", polling } } : {}),
    },
    operations16: {
      async execute(cpId, op) {
        seen.executes.push({ cpId, op });
        return "receipt";
      },
    },
    ...(surface ? { commands } : {}),
  };
  return { driver, seen };
}

interface Exchange {
  status: number;
  body: any;
  text: string;
  log: string[];
  seen: Seen;
}

async function exchange(
  method: string,
  path: string,
  body?: unknown,
  fake: FakeOptions = {},
  timeoutMs?: number,
): Promise<Exchange> {
  const { driver, seen } = fakeDriver(fake);
  const log: string[] = [];
  const handler = createCsmsHttpHandler(driver, {
    about: { id: "memory", displayName: "In-memory CSMS" },
    secrets: [SECRET],
    log: (line) => log.push(line),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const init: RequestInit = {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handler(new Request(`http://daemon${path}`, init));
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text, log, seen };
}

const RESET = "/v1/charge-points/CP-1/operations/reset";

// ---------------------------------------------------------------------------
// Part 1 -- opt-in and backward compatible.
// ---------------------------------------------------------------------------

{
  const ex = await exchange("POST", RESET, { type: "Soft" }, { surface: false });
  check(ex.status === 202, `without commands the operation answers 202, got ${ex.status}`);
  check(
    JSON.stringify(ex.body) ===
      JSON.stringify({
        chargePointId: "CP-1",
        operation: "reset",
        action: "Reset",
        status: "dispatched",
      }),
    `without commands the 202 body is unchanged, no outcome: ${ex.text}`,
  );
  check(ex.seen.executes.length === 1, "without commands the call is execute, once");
  const desc = await exchange("GET", "/v1/driver", undefined, { surface: false });
  check(desc.body?.commands === null, `no surface reads as commands:null: ${desc.text}`);

  for (const [name, fake] of [
    ["declared without the surface", { surface: false, declare: true }],
    ["surface without the declaration", { surface: true, declare: false }],
  ] as const) {
    const half = await exchange("POST", RESET, { type: "Soft" }, fake);
    check(half.body && !("outcome" in half.body), `${name}: no outcome, ${half.text}`);
    check(half.seen.executes.length === 1, `${name}: execute is the call`);
    const d = await exchange("GET", "/v1/driver", undefined, fake);
    check(d.body?.commands === null, `${name}: reads as null, ${d.text}`);
  }

  const declared = await exchange("GET", "/v1/driver", undefined, { polling: true });
  check(
    JSON.stringify(declared.body?.commands) ===
      JSON.stringify({ completion: "accepted", polling: true }),
    `the description lists the commands capability: ${declared.text}`,
  );
  const hollow = await exchange("GET", "/v1/driver", undefined, {
    polling: true,
    implementPoll: false,
  });
  check(
    hollow.body?.commands?.polling === false,
    `polling declared without poll() reads as false: ${hollow.text}`,
  );
}

// ---------------------------------------------------------------------------
// Part 2 -- every state is a value.
// ---------------------------------------------------------------------------

for (const [name, outcome] of Object.entries(STATES)) {
  const ex = await exchange("POST", RESET, { type: "Hard" }, { submit: async () => outcome });
  check(ex.status === 202, `${name}: answers 202, got ${ex.status}`);
  check(ex.body?.status === "dispatched", `${name}: keeps status "dispatched": ${ex.text}`);
  check(
    JSON.stringify(ex.body?.outcome) === JSON.stringify(outcome),
    `${name}: the outcome reaches the client intact: ${ex.text}`,
  );
  check(
    ex.seen.submits.length === 1 && ex.seen.executes.length === 0,
    `${name}: one submit, no execute`,
  );
  check(
    JSON.stringify(ex.seen.submits[0]) ===
      JSON.stringify({ cpId: "CP-1", op: { action: "Reset", type: "Hard" } }),
    `${name}: submit receives the decoded operation: ${JSON.stringify(ex.seen.submits[0])}`,
  );
}

// ---------------------------------------------------------------------------
// Part 3 -- a timeout is never a failure; errors keep their statuses.
// ---------------------------------------------------------------------------

{
  const hang = await exchange(
    "POST",
    RESET,
    { type: "Soft" },
    { submit: () => new Promise<CommandOutcome>(() => {}) },
    20,
  );
  check(hang.status === 504, `a deadline answers 504, got ${hang.status}`);
  check(hang.body?.error?.code === "timeout", `504 stays code timeout: ${hang.text}`);
  check(/unknown/.test(hang.body?.error?.message ?? ""), `504 says the outcome is unknown`);
  check(!("outcome" in (hang.body ?? {})), `504 carries no outcome: ${hang.text}`);
  check(!/failed/.test(hang.text), `a timeout never reads as failed: ${hang.text}`);

  const timedOut: CommandOutcome = { state: "unknown", at: AT, cause: "timeout" };
  const reported = await exchange(
    "POST",
    RESET,
    { type: "Soft" },
    { submit: async () => timedOut },
  );
  check(
    reported.body?.outcome?.state === "unknown" && reported.body.outcome.cause === "timeout",
    `a driver-reported timeout stays unknown/timeout: ${reported.text}`,
  );

  const notDispatched = await exchange(
    "POST",
    RESET,
    { type: "Soft" },
    {
      submit: async () => {
        throw new CsmsNotDispatchedError("Reset", "connection refused");
      },
    },
  );
  check(
    notDispatched.status === 502 && notDispatched.body?.error?.code === "transport_failure",
    `a never-dispatched throw keeps 502 transport_failure: ${notDispatched.text}`,
  );
  check(!("outcome" in (notDispatched.body ?? {})), "no outcome on an error status");

  const plain = await exchange(
    "POST",
    RESET,
    { type: "Soft" },
    {
      submit: async () => {
        throw new Error("CSMS said 500");
      },
    },
  );
  check(
    plain.status === 502 && plain.body?.error?.code === "csms_rejected",
    `a plain Error keeps 502 csms_rejected: ${plain.text}`,
  );

  const bad = await exchange("POST", RESET, { type: "Sideways" });
  check(
    bad.status === 400 && bad.seen.submits.length === 0,
    `an invalid body is refused before submit: ${bad.status}`,
  );
  const undeclared = await exchange("POST", "/v1/charge-points/CP-1/operations/unknown-op", {});
  check(undeclared.status === 404, `an unknown path stays 404, got ${undeclared.status}`);
}

// ---------------------------------------------------------------------------
// Part 4 -- polling only when supported.
// ---------------------------------------------------------------------------

{
  const ok = await exchange("GET", "/v1/commands/cmd-1", undefined, { polling: true });
  check(ok.status === 200, `a poll answers 200, got ${ok.status}`);
  check(
    JSON.stringify(ok.body?.outcome) === JSON.stringify(STATES.confirmed),
    `the polled outcome is in outcome: ${ok.text}`,
  );
  check(ok.body?.ref === "cmd-1", `the body names the ref: ${ok.text}`);
  check(ok.seen.polls[0] === "cmd-1", "poll receives the decoded ref");

  const odd = await exchange("GET", "/v1/commands/a%2Fb%20c", undefined, { polling: true });
  check(odd.seen.polls[0] === "a/b c", `a percent-encoded ref is decoded: ${odd.seen.polls[0]}`);

  const missing = await exchange("GET", "/v1/commands/nope", undefined, {
    polling: true,
    poll: async () => null,
  });
  check(
    missing.status === 404 && missing.body?.error?.code === "not_found",
    `an unknown ref is 404 not_found: ${missing.status} ${missing.text}`,
  );

  for (const [name, fake] of [
    ["no polling declared", { polling: false }],
    ["polling declared without poll()", { polling: true, implementPoll: false }],
    ["no commands surface", { surface: false }],
  ] as const) {
    const ex = await exchange("GET", "/v1/commands/cmd-1", undefined, fake);
    check(
      ex.status === 501 && ex.body?.error?.code === "unsupported_capability",
      `${name}: 501 unsupported_capability, got ${ex.status} ${ex.text}`,
    );
  }

  const post = await exchange("POST", "/v1/commands/cmd-1", {}, { polling: true });
  check(
    post.status === 405 && post.seen.polls.length === 0,
    `only GET is served on a command: ${post.status}`,
  );
  const bare = await exchange("GET", "/v1/commands", undefined, { polling: true });
  check(bare.status === 404, `/v1/commands without a ref is 404, got ${bare.status}`);

  const failing = await exchange("GET", "/v1/commands/cmd-1", undefined, {
    polling: true,
    poll: async () => {
      throw new Error("backend down");
    },
  });
  check(
    failing.status === 502 && failing.body?.error?.code === "csms_rejected",
    `a poll failure keeps the driver-error mapping: ${failing.status}`,
  );
  const slow = await exchange(
    "GET",
    "/v1/commands/cmd-1",
    undefined,
    { polling: true, poll: () => new Promise<CommandOutcome | null>(() => {}) },
    20,
  );
  check(slow.status === 504, `a poll is under the deadline too, got ${slow.status}`);
}

// ---------------------------------------------------------------------------
// Part 5 -- nothing secret leaves.
// ---------------------------------------------------------------------------

{
  const leaky: CommandOutcome = {
    state: "confirmed",
    at: AT,
    ref: "cmd-1",
    response: { status: "Accepted", nested: [{ token: `Bearer ${SECRET}` }], n: 3, ok: true },
  };
  const ex = await exchange("POST", RESET, { type: "Soft" }, { submit: async () => leaky });
  check(!ex.text.includes(SECRET), `a secret in a station response is redacted: ${ex.text}`);
  check(
    ex.body?.outcome?.response?.nested?.[0]?.token === "Bearer [redacted]",
    `redaction keeps the structure: ${ex.text}`,
  );
  check(
    ex.body?.outcome?.response?.n === 3 && ex.body.outcome.response.ok === true,
    "non-string values are untouched",
  );

  const detail = await exchange(
    "POST",
    RESET,
    { type: "Soft" },
    { submit: async () => ({ state: "rejected", at: AT, detail: `bad key ${SECRET}` }) },
  );
  check(!detail.text.includes(SECRET), `a secret in detail is redacted: ${detail.text}`);

  const polled = await exchange("GET", "/v1/commands/cmd-1", undefined, {
    polling: true,
    poll: async () => ({ state: "failed", at: AT, detail: SECRET }),
  });
  check(!polled.text.includes(SECRET), `a polled outcome is redacted: ${polled.text}`);
  const secretPath = await exchange("GET", `/v1/commands/${SECRET}`, undefined, { polling: true });
  check(
    secretPath.log.every((line) => !line.includes(SECRET)),
    `the log redacts a secret in the ref: ${secretPath.log.join("|")}`,
  );
  check(
    !secretPath.text.includes(SECRET),
    `the response does not echo a secret ref: ${secretPath.text}`,
  );
  check(
    ex.log.every((line) => !line.includes("Accepted") && !line.includes("outcome")),
    `the log carries no outcome: ${ex.log.join("|")}`,
  );

  const keyed = await exchange(
    "POST",
    RESET,
    { type: "Soft" },
    {
      submit: async () => ({
        state: "confirmed",
        at: AT,
        response: { [`key-${SECRET}`]: "v", deep: [{ [SECRET]: 1 }] },
      }),
    },
  );
  check(!keyed.text.includes(SECRET), `a secret used as a key is redacted: ${keyed.text}`);
  check(
    keyed.body?.outcome?.response?.["key-[redacted]"] === "v",
    `a redacted key keeps its value: ${keyed.text}`,
  );
}

// ---------------------------------------------------------------------------
// Part 6 -- the outcome is a whitelist.
// ---------------------------------------------------------------------------

{
  for (const [name, outcome] of Object.entries(STATES)) {
    const ex = await exchange(
      "POST",
      RESET,
      { type: "Hard" },
      {
        submit: async () =>
          ({ ...outcome, receipt: "https://csms/task/9", raw: { a: 1 } }) as never,
      },
    );
    check(
      ex.status === 202 && JSON.stringify(ex.body?.outcome) === JSON.stringify(outcome),
      `${name}: an extra property is dropped: ${ex.text}`,
    );
    const polled = await exchange("GET", "/v1/commands/cmd-1", undefined, {
      polling: true,
      poll: async () => ({ ...outcome, receipt: "x" }) as never,
    });
    check(
      polled.status === 200 && JSON.stringify(polled.body?.outcome) === JSON.stringify(outcome),
      `${name}: a polled extra property is dropped: ${polled.text}`,
    );
  }

  for (const [name, bad] of [
    ["undefined", undefined],
    ["null", null],
    ["a string", "accepted"],
    ["an unknown state", { state: "pending", at: AT }],
    ["no state", { at: AT }],
  ] as const) {
    const ex = await exchange(
      "POST",
      RESET,
      { type: "Soft" },
      { submit: async () => bad as never },
    );
    check(
      ex.status === 500 && ex.body?.error?.code === "internal" && !("outcome" in (ex.body ?? {})),
      `submit returning ${name} is 500 internal, got ${ex.status} ${ex.text}`,
    );
  }
  for (const [name, bad] of [
    ["undefined", undefined],
    ["an unknown state", { state: "pending" }],
  ] as const) {
    const ex = await exchange("GET", "/v1/commands/cmd-1", undefined, {
      polling: true,
      poll: async () => bad as never,
    });
    check(
      ex.status === 500 && ex.body?.error?.code === "internal",
      `poll returning ${name} is 500 internal, got ${ex.status} ${ex.text}`,
    );
  }

  const gated = await exchange("POST", RESET, { type: "Soft" }, { actions: [] });
  check(
    gated.status === 501 && gated.body?.error?.code === "unsupported_capability",
    `an undeclared action is 501 even with commands: ${gated.status} ${gated.text}`,
  );
  check(gated.seen.submits.length === 0, "an undeclared action makes no submit");

  // An action valid in both versions routes to the version of the route: the
  // 1.6 handler calls submit16 and never submit201.
  for (const [path, body] of [
    ["clear-charging-profile", {}],
    ["trigger-message", { requestedMessage: "Heartbeat" }],
  ] as const) {
    const amb = await exchange("POST", `/v1/charge-points/CP1/operations/${path}`, body);
    check(
      amb.status === 202 && amb.seen.submits.length === 1 && amb.seen.submits201.length === 0,
      `${path} routes to submit16 only: ${amb.status} ${amb.text} ${amb.seen.submits201.length}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} failure(s):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("command-outcomes: ok");

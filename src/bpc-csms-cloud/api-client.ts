// Copyright 2026 Sukrit Jaidee
// SPDX-License-Identifier: Apache-2.0
/**
 * api-client.ts -- the bpc-csms-cloud console session.
 *
 * THE CONSOLE LOGS IN WITH A FORM. `POST /login` takes
 * `application/x-www-form-urlencoded` `username` and `password` and answers a
 * redirect with a `csms_session` cookie; every `/api/` route after that reads
 * the cookie and answers `401 {"error":"Unauthorized"}` without it. A session
 * ends at the next 08:00 of the server's clock, or when an operator signs it out.
 *
 * REFUSED LOGINS ARE COSTLY. The server counts wrong passwords per client
 * address: the fifth locks that address out for fifteen minutes (answered
 * 429), and every refusal is delayed a second. So the driver logs in once per
 * process, server, account and password (a SHA-256 digest, never the raw
 * password), shared by every driver instance with those credentials, and keeps
 * a 401 or 429 refusal for fifteen minutes instead of trying again.
 *
 * A COMMAND ANSWERED 401 logs in again and is sent once more, but only once the
 * session is a minute old: a 401 the server keeps sending costs at most one
 * login a minute.
 */

import { createHash } from "node:crypto";

import { CsmsNotDispatchedError, type FetchLike } from "../contracts.ts";
import { preview, reason, setCookiePairs } from "../shared/http.ts";
import type { BpcCsmsCloudConfig } from "./config.ts";

const LOGIN_TIMEOUT_MS = 15_000;
/** How old a session must be before a 401 on it is worth a new login. */
const RENEW_MIN_AGE_MS = 60_000;
/** How long a refused login is remembered before this process tries again. */
const KEPT_REFUSAL_MS = 15 * 60_000;
/** The login answers that are kept rather than retried: a wrong password and
 *  the address lock-out it leads to. */
const KEPT_REFUSALS: readonly number[] = [401, 429];
const SESSION_COOKIE = "csms_session";

interface Session {
  readonly cookie: string;
  readonly renewableAt: number;
}

/** Module-level, so every driver of one process shares a login. */
const sessions = new Map<string, Promise<Session>>();
const refusedAt = new Map<string, number>();

/** A login that failed: nothing was sent to the station. */
class LoginFailed extends CsmsNotDispatchedError {
  constructor(
    operation: string,
    reason: string,
    readonly kept: boolean,
  ) {
    super(operation, reason);
  }
}

/**
 * A command whose wait was cut short -- by `dispatchTimeoutMs` or by the
 * caller's signal -- after the request may have left. `execute` treats it as
 * the {@link CsmsNotDispatchedError} it is; `commands.submit16` reports it as
 * `unknown`. Not exported from the package: rely on `instanceof
 * CsmsNotDispatchedError`.
 */
export class CommandWaitInterruptedError extends CsmsNotDispatchedError {
  constructor(
    operation: string,
    reason: string,
    readonly timedOut: boolean,
  ) {
    super(operation, reason);
  }
}

function forget(key: string, entry: Promise<Session> | undefined): void {
  if (entry !== undefined && sessions.get(key) === entry) {
    sessions.delete(key);
    refusedAt.delete(key);
  }
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface RawResponse {
  readonly status: number;
  readonly text: string;
}

export class BpcCsmsCloudApi {
  constructor(
    private readonly cfg: BpcCsmsCloudConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /** One request. A transport failure is a {@link CsmsNotDispatchedError};
   *  for a command (`command` given) an abort after it may have left is a
   *  {@link CommandWaitInterruptedError}. */
  private async send(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    command?: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ res: Response; text: string }> {
    const url = `${this.cfg.apiUrl}${path}`;
    const callerSignal = command?.signal;
    const signal =
      callerSignal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), callerSignal]);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: "manual", signal });
    } catch (err) {
      const byCaller = callerSignal?.aborted === true;
      const unknown = `whether the server acted on it is unknown (${reason(err)})`;
      const why = byCaller
        ? `aborted by the caller after the request may have left, and ${unknown}`
        : isAbort(err)
          ? `timed out after ${timeoutMs} ms: the request left, and ${unknown}`
          : reason(err);
      if (command !== undefined && (byCaller || isAbort(err))) {
        throw new CommandWaitInterruptedError(`bpc-csms-cloud: POST ${url}`, why, !byCaller);
      }
      throw new CsmsNotDispatchedError(`bpc-csms-cloud: POST ${url}`, why);
    }
    const text = await res.text().catch(() => "<unreadable body>");
    return { res, text };
  }

  private sessionKey(): string {
    const digest = createHash("sha256").update(this.cfg.password).digest("hex");
    return `${this.cfg.apiUrl}|${this.cfg.username}|${digest}`;
  }

  private async session(): Promise<{ session: Session; entry: Promise<Session> }> {
    const key = this.sessionKey();
    const refused = refusedAt.get(key);
    if (refused !== undefined && Date.now() - refused >= KEPT_REFUSAL_MS) {
      forget(key, sessions.get(key));
    }
    const cached = sessions.get(key);
    if (cached !== undefined) return { session: await cached, entry: cached };
    const pending = this.login();
    sessions.set(key, pending);
    pending.catch((err: unknown) => {
      if (sessions.get(key) !== pending) return;
      if (err instanceof LoginFailed && err.kept) refusedAt.set(key, Date.now());
      else sessions.delete(key);
    });
    return { session: await pending, entry: pending };
  }

  private async login(): Promise<Session> {
    const what = "bpc-csms-cloud: POST /login";
    const { res, text } = await this.send(
      "/login",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: this.cfg.username,
          password: this.cfg.password,
        }).toString(),
      },
      LOGIN_TIMEOUT_MS,
    );
    if (KEPT_REFUSALS.includes(res.status)) {
      throw new LoginFailed(
        what,
        `returned ${res.status} for ${this.cfg.username} -- the server locks a client out` +
          " after five wrong passwords, so this process will not try again for fifteen" +
          ` minutes: ${preview(text)}`,
        true,
      );
    }
    const cookie = setCookiePairs(res)
      .filter(([name]) => name === SESSION_COOKIE)
      .pop()?.[1];
    if (res.status < 300 || res.status > 399 || cookie === undefined || cookie === "") {
      throw new LoginFailed(
        what,
        `answered ${res.status} without a ${SESSION_COOKIE} cookie: ${preview(text)}`,
        false,
      );
    }
    return { cookie, renewableAt: Date.now() + RENEW_MIN_AGE_MS };
  }

  private async authenticated(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ res: RawResponse; entry: Promise<Session>; session: Session }> {
    const { session, entry } = await this.session();
    const { res, text } = await this.send(
      path,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${session.cookie}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
      { signal },
    );
    return { res: { status: res.status, text }, entry, session };
  }

  /** `POST` a JSON body to a console route with the session cookie. */
  async post(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RawResponse> {
    const first = await this.authenticated(path, body, timeoutMs, signal);
    if (first.res.status !== 401 || Date.now() < first.session.renewableAt) return first.res;
    forget(this.sessionKey(), first.entry);
    return (await this.authenticated(path, body, timeoutMs, signal)).res;
  }
}

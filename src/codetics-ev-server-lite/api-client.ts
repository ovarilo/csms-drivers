// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * api-client.ts -- the one HTTP surface this driver uses: the server's admin
 * REST API under `/api/v1`.
 *
 * WHAT THE SERVER ASKS OF A CLIENT (security/SecurityConfiguration.kt,
 * security/AuthController.kt):
 *
 *  - a bearer token from `POST /api/v1/auth/app/signin {tenant,email,password}`,
 *    answered as `{token, expires_at, user}`;
 *  - CSRF on EVERY mutating request, signin included, bearer or not. The
 *    repository is `CookieCsrfTokenRepository` with the plain (non-XOR) request
 *    handler, so the token `GET /api/v1/auth/csrf` returns is sent back twice:
 *    as the `XSRF-TOKEN` cookie and in the header that response names.
 *
 * ONE LOGIN PER PROCESS, AND THE REASON IS A LIMIT RATHER THAN A COURTESY.
 * AccountService#login counts every attempt, good or bad, against
 * `login:<tenant>:<email>` -- ten per fifteen minutes -- and the counter lives
 * in the server's database, so only a restart clears it. Several drivers
 * created in one process would otherwise spend that budget quickly. So the
 * session is cached at module level, keyed by server and account, and shared
 * by every client in the process, in-flight attempt included.
 *
 * THE KEY IS BOUND TO THE CREDENTIAL. It also carries a SHA-256 digest of the
 * password -- never the password itself -- so a client configured with a
 * wrong password does not borrow a session another client's right one
 * opened, and a refusal kept for one password does not block a corrected
 * one.
 *
 * ONLY A REFUSED SIGNIN IS CACHED. The counter is incremented by
 * `POST /api/v1/auth/app/signin` alone, and it counts before anything else in
 * login can fail. A signin answered 401 (bad credentials) or 429 (the limit)
 * was counted and is deterministic: a retry gets the same answer and spends
 * more budget. A 403 never reaches login -- the security chain's access-denied
 * handler sends it, i.e. the CSRF pair was refused -- and is kept because the
 * same pair would be refused again, not because it was counted. Those three
 * are kept for the server's fifteen-minute window, so a long-lived process
 * (an HTTP handler, say) recovers without a restart. Every other failure is dropped from the
 * cache and the next call tries again: a `fetch` that threw (a CSMS still
 * booting), any answer to the uncounted `GET /api/v1/auth/csrf`, a 2xx without
 * a token, and a signin 5xx -- which WAS counted, and is retried anyway because
 * it is the server's transient fault.
 *
 * A TOKEN OUTLIVED. Signin answers an `expires_at`, and a process serving a
 * driver can outlive it. An authenticated request answered 401 once that
 * moment has come drops the cached session -- unless another caller already
 * replaced it -- logs in once more and is sent again, once: a 401 on the fresh
 * token is the request's answer. A 401 on a token that has not expired renews
 * nothing, because every renewal is a counted signin: a 401 the server keeps
 * sending (the dispatch poll reads every 250 ms) would otherwise spend the
 * whole budget in seconds and lock the account out. Without an `expires_at`,
 * a session is renewable from five minutes old, three signins per window.
 *
 * FAILURE CLASSES. A request `fetch` could not complete, and one the server
 * answered with a non-2xx status, are both {@link CsmsNotDispatchedError}: for
 * every call this driver makes, a refused HTTP request is one whose effect --
 * a queued command, a read -- did not happen, so nothing it would have caused
 * went on the wire. A 2xx whose body cannot be read is a plain `Error`: the
 * request was answered, and whether it took effect is exactly what is unknown.
 */
import { createHash } from "node:crypto";
import { CsmsNotDispatchedError, type FetchLike } from "../contracts.ts";
import {
  errorBody,
  parseAnsweredBody,
  readAnsweredText,
  reason,
  setCookiePairs,
} from "../shared/http.ts";
import type { EvslConfig } from "./config.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export type EvslHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface Session {
  token: string;
  csrf: string;
  csrfHeader: string;
  /** From when a 401 may renew this session. See the header. */
  renewableAt: number;
}

/** How early before `expires_at` a 401 may renew, for clock skew. */
const EXPIRY_SKEW_MS = 30_000;
/** The age from which a session whose signin gave no `expires_at` may be
 *  renewed: at most three signins per rate-limit window. */
const RENEW_WITHOUT_EXPIRY_MS = 5 * 60_000;

function renewableAt(expiresAt: unknown): number {
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(expiry) ? expiry - EXPIRY_SKEW_MS : Date.now() + RENEW_WITHOUT_EXPIRY_MS;
}

/** Keyed by server, account and password digest. See the header for why it is
 *  process-wide. */
const sessions = new Map<string, Promise<Session>>();

/** When each kept signin refusal in {@link sessions} was received. */
const refusedAt = new Map<string, number>();

/** The server's login rate-limit window: how long a kept refusal is kept. */
const KEPT_REFUSAL_MS = 15 * 60_000;

/** The value of the first cookie named `name` among a response's `Set-Cookie`
 *  headers, or undefined when absent or empty. Only the CSRF cookie is ever
 *  read, so this is not a jar. */
function setCookie(res: Response, name: string): string | undefined {
  const value = setCookiePairs(res).find(([n]) => n === name)?.[1];
  return value === "" ? undefined : value;
}

/** The signin statuses a retry would only repeat: bad credentials (401) and
 *  the limit itself (429), both counted, and a refused CSRF pair (403), which
 *  is not. See the header. */
const KEPT_REFUSALS: readonly number[] = [401, 403, 429];

/** A signin refused with one of {@link KEPT_REFUSALS}. The one login failure
 *  the session cache keeps; see the header. */
class SigninRefused extends CsmsNotDispatchedError {}

/** Drops `pending` from the cache, unless another caller replaced it. */
function forget(key: string, pending: Promise<Session> | undefined): void {
  if (pending !== undefined && sessions.get(key) === pending) {
    sessions.delete(key);
    refusedAt.delete(key);
  }
}

export class EvslApi {
  /** `fetchImpl` is the {@link FetchLike} seam. The default resolves the
   *  global per call rather than capturing it. */
  constructor(
    private readonly cfg: EvslConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Response> {
    const url = `${this.cfg.apiUrl}${path}`;
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        // JSON.stringify keeps insertion order, and the server forwards a
        // command payload's members in the order it received them -- which
        // requests.ts relies on for SendLocalList.
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CsmsNotDispatchedError(`codetics-ev-server-lite: ${method} ${url}`, reason(err));
    }
  }

  /** Server, account and a digest of the password -- never the password
   *  itself. See the header. */
  private sessionKey(): string {
    const digest = createHash("sha256").update(this.cfg.password).digest("hex");
    return `${this.cfg.apiUrl}|${this.cfg.tenant}|${this.cfg.email}|${digest}`;
  }

  /** The cached session, logging in on first use. */
  private session(): Promise<Session> {
    const key = this.sessionKey();
    const refused = refusedAt.get(key);
    if (refused !== undefined && Date.now() - refused >= KEPT_REFUSAL_MS) {
      forget(key, sessions.get(key));
    }
    const cached = sessions.get(key);
    if (cached !== undefined) return cached;
    const attempt = this.login();
    sessions.set(key, attempt);
    attempt.catch((err: unknown) => {
      if (sessions.get(key) !== attempt) return;
      if (err instanceof SigninRefused) refusedAt.set(key, Date.now());
      else sessions.delete(key);
    });
    return attempt;
  }

  private async login(): Promise<Session> {
    const csrfRes = await this.send("GET", "/api/v1/auth/csrf", {}, undefined);
    if (!csrfRes.ok) {
      throw new CsmsNotDispatchedError(
        "codetics-ev-server-lite: GET /api/v1/auth/csrf",
        `returned ${csrfRes.status}: ${await errorBody(csrfRes)}`,
      );
    }
    const csrfBody = (await csrfRes.json().catch(() => null)) as {
      token?: unknown;
      headerName?: unknown;
    } | null;
    const csrf =
      setCookie(csrfRes, "XSRF-TOKEN") ??
      (typeof csrfBody?.token === "string" ? csrfBody.token : undefined);
    const csrfHeader =
      typeof csrfBody?.headerName === "string" ? csrfBody.headerName : "X-XSRF-TOKEN";
    if (csrf === undefined) {
      throw new Error("codetics-ev-server-lite: GET /api/v1/auth/csrf answered without a token");
    }

    const what = "codetics-ev-server-lite: POST /api/v1/auth/app/signin";
    const res = await this.send(
      "POST",
      "/api/v1/auth/app/signin",
      { cookie: `XSRF-TOKEN=${csrf}`, [csrfHeader]: csrf },
      { tenant: this.cfg.tenant, email: this.cfg.email, password: this.cfg.password },
    );
    if (!res.ok) {
      const refused = `returned ${res.status} for ${this.cfg.email} on tenant ${this.cfg.tenant}`;
      if (KEPT_REFUSALS.includes(res.status)) {
        throw new SigninRefused(
          what,
          `${refused} -- the server counts every attempt against a limit of ten per` +
            " fifteen minutes, so this process will not try again for fifteen minutes" +
            `: ${await errorBody(res)}`,
        );
      }
      throw new CsmsNotDispatchedError(what, `${refused}: ${await errorBody(res)}`);
    }
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
      expires_at?: unknown;
    } | null;
    if (typeof body?.token !== "string" || body.token === "") {
      throw new Error(`${what} answered ${res.status} without a token`);
    }
    return {
      token: body.token,
      csrf: setCookie(res, "XSRF-TOKEN") ?? csrf,
      csrfHeader,
      renewableAt: renewableAt(body.expires_at),
    };
  }

  /** One send under the cached session, with the session it used. A method
   *  other than GET carries the CSRF pair. */
  private async authenticated(
    method: EvslHttpMethod,
    path: string,
    body: unknown,
  ): Promise<{ res: Response; pending: Promise<Session>; session: Session }> {
    const pending = this.session();
    const session = await pending;
    const mutating = method !== "GET";
    const res = await this.send(
      method,
      path,
      {
        authorization: `Bearer ${session.token}`,
        ...(mutating
          ? { cookie: `XSRF-TOKEN=${session.csrf}`, [session.csrfHeader]: session.csrf }
          : {}),
      },
      mutating ? (body ?? {}) : undefined,
    );
    const rotated = setCookie(res, "XSRF-TOKEN");
    if (rotated !== undefined) session.csrf = rotated;
    return { res, pending, session };
  }

  /** One authenticated exchange, renewing the session once when the token
   *  outlived its `expires_at`. See the header. */
  private async exchange(method: EvslHttpMethod, path: string, body: unknown): Promise<Response> {
    const first = await this.authenticated(method, path, body);
    if (first.res.status === 401 && Date.now() >= first.session.renewableAt) {
      // See the header: a token outlived, retried once on a fresh login.
      await first.res.body?.cancel();
      forget(this.sessionKey(), first.pending);
      return (await this.authenticated(method, path, body)).res;
    }
    return first.res;
  }

  /**
   * One authenticated request, answered with its parsed JSON body, or null
   * for an empty one. A method other than GET makes it a mutation, which
   * carries the CSRF pair.
   */
  async request(method: EvslHttpMethod, path: string, body?: unknown): Promise<unknown> {
    const res = await this.exchange(method, path, body);
    const what = `codetics-ev-server-lite: ${method} ${path}`;
    if (!res.ok) {
      throw new CsmsNotDispatchedError(what, `returned ${res.status}: ${await errorBody(res)}`);
    }
    return this.answeredBody(res, what);
  }

  /**
   * Like {@link request}, but a status in `accepted` is an answer rather than
   * a failure: the caller reads it, e.g. a 404 that means "absent". Any other
   * non-2xx is a plain `Error` -- the admin calls are not OCPP CALLs, so
   * "never dispatched" has no meaning for them.
   *
   * `secretBearing` marks a call whose 2xx body carries a generated secret: a
   * body that will not parse is then reported without being quoted.
   */
  async call(
    method: EvslHttpMethod,
    path: string,
    body?: unknown,
    accepted: readonly number[] = [],
    secretBearing = false,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const res = await this.exchange(method, path, body);
    const what = `codetics-ev-server-lite: ${method} ${path}`;
    if (!res.ok) {
      if (accepted.includes(res.status)) {
        await res.body?.cancel();
        return { status: res.status, body: null };
      }
      throw new Error(`${what} returned ${res.status}: ${await errorBody(res)}`);
    }
    return { status: res.status, body: await this.answeredBody(res, what, secretBearing) };
  }

  private async answeredBody(res: Response, what: string, quiet = false): Promise<unknown> {
    const text = await readAnsweredText(res, what);
    if (text === "") return null;
    if (!quiet) return parseAnsweredBody(text, what);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${what} returned unparseable body (not quoted: it may hold a secret)`);
    }
  }
}

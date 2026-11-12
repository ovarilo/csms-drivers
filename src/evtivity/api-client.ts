// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * api-client.ts -- the one HTTP surface this driver uses: EVtivity's REST API
 * under `/v1`, behind a bearer token.
 *
 * WHAT THE SERVER ASKS OF A CLIENT, source-verified at v0.1.51
 * (packages/api/src/routes/users.ts, `/auth/login`):
 *
 *  - `POST /v1/auth/login {email, password}`, answered `{token, user, role}`;
 *    the token is a JWT that lives one hour;
 *  - `authorization: Bearer <token>` on every other call. No CSRF, no cookie.
 *
 * ONE LOGIN PER PROCESS, renewed when it runs out. The route is rate limited
 * (AUTH_RATE_LIMIT_MAX, 30 per minute by default) and every refused password
 * counts toward the account's sign-in backoff, so several drivers in one
 * process each logging in would spend a budget for nothing. The session is
 * cached at module level, keyed by server and account, in-flight attempt
 * included, and shared by every client in the process.
 *
 * THE KEY IS BOUND TO THE CREDENTIAL. It also carries a SHA-256 digest of the
 * password -- never the password itself -- so a client configured with a
 * wrong password does not borrow a session another client's right one
 * opened, and a refusal kept for one password does not block a corrected
 * one.
 *
 * A TOKEN OUTLIVED. Two things end a session. The token's JWT `exp` coming
 * within {@link EXPIRY_MARGIN_MS} replaces it before use. And a command
 * answered 401 drops the session -- unless another caller already replaced
 * it -- logs in once more and is sent again, once: a 401 on the fresh token
 * is the command's answer. That second path covers a token the server stopped
 * honouring before its `exp` (a rotated secret, say), but it only opens once
 * the session is {@link RENEW_MIN_AGE_MS} old: every renewal is a login, and
 * a 401 the server keeps sending would otherwise spend a login on every
 * command. A 401 on a younger session is the command's answer.
 *
 * WHICH LOGIN FAILURES ARE KEPT. A 401 (INVALID_CREDENTIALS: a retry gets the
 * same answer and feeds the backoff), a 403 (an MFA policy the account cannot
 * meet) and a 200 `{mustResetPassword: true}` are deterministic, and are kept
 * for {@link KEPT_REFUSAL_MS} -- this driver's own choice, not a window
 * EVtivity defines -- so a long-lived process (an HTTP handler, say) recovers
 * once an operator fixed the account, without a restart. Every other failure
 * is forgotten and the next call tries again: a `fetch` that threw or timed
 * out (an API still booting), a 429 (a per-minute window that passes), a 5xx,
 * and a 2xx without a token.
 *
 * Kept or forgotten, every login failure is a {@link CsmsNotDispatchedError}:
 * it happens before any command is sent. So what the cache keeps is a flag on
 * the error, never its class.
 *
 * FAILURE CLASSES. A request that could not CONNECT is
 * {@link CsmsNotDispatchedError}: nothing reached the server. So is a request
 * that left and was then aborted by our own timeout: what the server did with
 * it is unknown, and the contract files exactly that uncertainty there --
 * which matters for the command routes, which block until the station answers
 * (requests.ts). An answered request returns its status and body text for the
 * caller to classify: the command routes classify their statuses themselves,
 * in requests.ts.
 */
import { createHash } from "node:crypto";
import { CsmsNotDispatchedError, type FetchLike } from "../contracts.ts";
import { preview, reason } from "../shared/http.ts";
import type { EvtivityConfig } from "./config.ts";

/** The login request's own bound. */
const LOGIN_TIMEOUT_MS = 15_000;
/** A token this close to its `exp` is replaced before use. */
const EXPIRY_MARGIN_MS = 60_000;
/** The age from which a 401 may renew a session: at most one login a minute
 *  out of a rate limit of thirty. See the header. */
const RENEW_MIN_AGE_MS = 60_000;
/** How long a kept login refusal is kept. See the header. */
const KEPT_REFUSAL_MS = 15 * 60_000;

interface Session {
  token: string;
  /** Epoch ms, or Infinity when the token carries no readable `exp`. */
  expiresAt: number;
  /** From when a 401 may renew this session. See the header. */
  renewableAt: number;
}

/** Keyed by server and account. See the header for why it is process-wide. */
const sessions = new Map<string, Promise<Session>>();

/** When each kept login refusal in {@link sessions} was received. */
const refusedAt = new Map<string, number>();

/** Login refusals a retry would only repeat. See the header. */
const KEPT_REFUSALS: readonly number[] = [401, 403];

/**
 * A login that produced no token. Always a non-dispatch: it fails before any
 * command is sent. Whether the session cache keeps it is the `kept` flag, not
 * the class -- every login failure shares the class; see the header.
 */
class LoginFailed extends CsmsNotDispatchedError {
  constructor(
    operation: string,
    reason: string,
    readonly kept: boolean,
  ) {
    super(operation, reason);
  }
}

/** Drops `entry` from the cache, unless another caller replaced it. */
function forget(key: string, entry: Promise<Session> | undefined): void {
  if (entry !== undefined && sessions.get(key) === entry) {
    sessions.delete(key);
    refusedAt.delete(key);
  }
}

/** A `fetch` rejection by a timeout, after the request may have left. */
function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/** The parsed JSON of a text, or undefined when it is not JSON. Lenient on
 *  purpose: an error body that is not JSON is still the status's finding. */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The `exp` of a JWT, in epoch ms, or Infinity when it cannot be read. */
function expiryOf(token: string): number {
  try {
    const part = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : Infinity;
  } catch {
    return Infinity;
  }
}

/** An answered request: its status and its body as text. */
export interface RawResponse {
  readonly status: number;
  /** The body as text; `<unreadable body>` when it could not be read. */
  readonly text: string;
}

export class EvtivityApi {
  /** `fetchImpl` is the {@link FetchLike} seam. The default resolves the
   *  global per call rather than capturing it. */
  constructor(
    private readonly cfg: EvtivityConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async send(
    path: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number,
  ): Promise<RawResponse> {
    const url = `${this.cfg.apiUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...headers },
        // JSON.stringify keeps insertion order, which requests.ts relies on
        // for SendLocalList.
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A timeout is filed with the requests that never connected: the
      // request left, but nothing shows it became an OCPP CALL, and the
      // contract (CsmsNotDispatchedError) claims exactly that.
      const why = isAbort(err)
        ? `timed out after ${timeoutMs} ms: the request left, and whether the ` +
          `server acted on it is unknown (${reason(err)})`
        : reason(err);
      throw new CsmsNotDispatchedError(`evtivity: POST ${url}`, why);
    }
    // Best-effort: the status is the caller's finding, and a body that will not
    // stream must not replace it with a different failure.
    const text = await res.text().catch(() => "<unreadable body>");
    return { status: res.status, text };
  }

  /** Server, account and a digest of the password -- never the password
   *  itself. See the header. */
  private sessionKey(): string {
    const digest = createHash("sha256").update(this.cfg.password).digest("hex");
    return `${this.cfg.apiUrl}|${this.cfg.email}|${digest}`;
  }

  /** The cached session and the cache entry it came from, logging in on
   *  first use and when it runs out. */
  private async session(): Promise<{ session: Session; entry: Promise<Session> }> {
    const key = this.sessionKey();
    const refused = refusedAt.get(key);
    if (refused !== undefined && Date.now() - refused >= KEPT_REFUSAL_MS) {
      forget(key, sessions.get(key));
    }
    const cached = sessions.get(key);
    if (cached !== undefined) {
      const session = await cached;
      if (session.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return { session, entry: cached };
      forget(key, cached);
      return this.session();
    }
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
    const what = "evtivity: POST /v1/auth/login";
    const res = await this.send(
      "/v1/auth/login",
      {},
      { email: this.cfg.email, password: this.cfg.password },
      LOGIN_TIMEOUT_MS,
    );
    if (KEPT_REFUSALS.includes(res.status)) {
      throw new LoginFailed(
        what,
        `returned ${res.status} for ${this.cfg.email} -- every refused password counts` +
          " toward the account's sign-in backoff, so this process will not try again for" +
          ` fifteen minutes: ${preview(res.text)}`,
        true,
      );
    }
    if (res.status < 200 || res.status > 299) {
      throw new LoginFailed(
        what,
        `returned ${res.status} for ${this.cfg.email}: ${preview(res.text)}`,
        false,
      );
    }
    const body = parseJsonOrUndefined(res.text) as
      | { token?: unknown; mustResetPassword?: unknown }
      | undefined;
    if (body?.mustResetPassword === true) {
      throw new LoginFailed(
        what,
        `${this.cfg.email} must reset its password before it can sign in (seed it with` +
          " INITIAL_ADMIN_MUST_RESET_PASSWORD=false); this process will not try again for" +
          " fifteen minutes",
        true,
      );
    }
    if (typeof body?.token !== "string" || body.token === "") {
      throw new LoginFailed(
        what,
        `answered ${res.status} without a token: ${preview(res.text)}`,
        false,
      );
    }
    const now = Date.now();
    return {
      token: body.token,
      expiresAt: expiryOf(body.token),
      renewableAt: now + RENEW_MIN_AGE_MS,
    };
  }

  /** One send under the cached session, with the session it used. */
  private async authenticated(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ res: RawResponse; entry: Promise<Session>; session: Session }> {
    const { session, entry } = await this.session();
    const res = await this.send(
      path,
      { authorization: `Bearer ${session.token}` },
      body,
      timeoutMs,
    );
    return { res, entry, session };
  }

  /**
   * One authenticated POST, answered raw: the caller reads the status. A 401
   * renews the session and is sent once more, but only once that session is
   * old enough; see the header.
   */
  async post(path: string, body: unknown, timeoutMs: number): Promise<RawResponse> {
    const first = await this.authenticated(path, body, timeoutMs);
    if (first.res.status !== 401 || Date.now() < first.session.renewableAt) return first.res;
    forget(this.sessionKey(), first.entry);
    return (await this.authenticated(path, body, timeoutMs)).res;
  }
}

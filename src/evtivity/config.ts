// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

/** Settings needed by the reusable EVtivity REST API client. */
export interface EvtivityConfig {
  /** REST API base, no trailing slash, e.g. http://localhost:8480. Every
   *  route this driver calls lives under `/v1`. */
  readonly apiUrl: string;
  /** An administrator account, e.g. the one EVtivity's seed creates
   *  (INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD). */
  readonly email: string;
  readonly password: string;
  /** How long `execute()` waits for a command route, which blocks until the
   *  station answers, before declaring the command never dispatched. Keep it
   *  above the server's own 35 s bound on a command, so an abort means the
   *  server broke that bound rather than a slow station being cut off.
   *  Defaults to {@link DEFAULT_EVTIVITY_DISPATCH_TIMEOUT_MS}. */
  readonly dispatchTimeoutMs?: number;
}

export const DEFAULT_EVTIVITY_DISPATCH_TIMEOUT_MS = 45_000;

// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

/** Settings needed by the reusable Codetics ev-server-lite admin API client. */
export interface EvslConfig {
  /** Admin API base, no trailing slash, e.g. http://localhost:8380. */
  readonly apiUrl: string;
  /** Tenant slug the admin account and every station belong to. */
  readonly tenant: string;
  /** An administrator of that tenant, e.g. the server's bootstrap account
   *  (BOOTSTRAP_EMAIL / BOOTSTRAP_PASSWORD). */
  readonly email: string;
  readonly password: string;
  /** How long `execute()` waits for the CSMS to move a queued command to the
   *  station before declaring it never dispatched. Defaults to
   *  {@link DEFAULT_EVSL_DISPATCH_TIMEOUT_MS}. */
  readonly dispatchTimeoutMs?: number;
}

export const DEFAULT_EVSL_DISPATCH_TIMEOUT_MS = 15_000;

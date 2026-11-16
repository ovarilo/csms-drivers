// Copyright 2026 Sukrit Jaidee
// SPDX-License-Identifier: Apache-2.0

/** Settings needed by the reusable bpc-csms-cloud console API client. */
export interface BpcCsmsCloudConfig {
  /** The console's base URL, no trailing slash, e.g. http://localhost:10000.
   *  One port serves the console, its API and OCPP (`/ocpp/<id>`). */
  readonly apiUrl: string;
  /** A console account allowed to send commands, e.g. the built-in
   *  administrator (`CSMS_USER` / `CSMS_PASS`). */
  readonly username: string;
  readonly password: string;
  /** How long `execute()` waits for `POST /api/command`, which blocks until the
   *  station answers, before declaring the command never dispatched. Keep it
   *  above the server's own 30 s wait for a station's answer, so an abort means
   *  the server broke that bound rather than a slow station being cut off.
   *  Defaults to {@link DEFAULT_BPC_CSMS_CLOUD_DISPATCH_TIMEOUT_MS}. */
  readonly dispatchTimeoutMs?: number;
}

export const DEFAULT_BPC_CSMS_CLOUD_DISPATCH_TIMEOUT_MS = 45_000;

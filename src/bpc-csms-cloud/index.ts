// Copyright 2026 Sukrit Jaidee
// SPDX-License-Identifier: Apache-2.0
/**
 * The bpc-csms-cloud driver: a single-file Python CSMS (aiohttp, python-ocpp)
 * with a web console, driven here over OCPP 1.6J. Every operation goes through
 * the console's own JSON routes -- `POST /api/command`, which blocks until the
 * station answers, and `POST /api/ops/fw/update` for UpdateFirmware -- so the
 * driver needs nothing but a console account.
 *
 * Creating the driver does no I/O. The first call that needs the server logs
 * in, once per process, server, account and password -- see api-client.ts.
 */

import {
  CSMS_OPERATION_16_ACTIONS,
  type CsmsCapabilities,
  type CsmsOperation16,
  type FetchLike,
} from "../contracts.ts";
import type { CsmsConnectorApi, CsmsDriver, CsmsSessionApi } from "../models.ts";
import { BpcCsmsCloudApi } from "./api-client.ts";
import { DEFAULT_BPC_CSMS_CLOUD_DISPATCH_TIMEOUT_MS, type BpcCsmsCloudConfig } from "./config.ts";
import { dispatch, submitOperation, type BpcCsmsCloudRefs } from "./requests.ts";

export interface BpcCsmsCloudCsmsDriverOptions {
  readonly config: BpcCsmsCloudConfig;
  readonly refs?: BpcCsmsCloudRefs;
  readonly fetch?: FetchLike;
  readonly sessions?: CsmsSessionApi;
  readonly connectors?: CsmsConnectorApi;
}

/** Every OCPP 1.6 action has a console command; requests.ts refuses the
 *  variants the console cannot send as asked. */
export const BPC_CSMS_CLOUD_CAPABILITIES: CsmsCapabilities = {
  operations16: new Set(CSMS_OPERATION_16_ACTIONS),
  // The route blocks until the station answers, so submit16 reads the answer
  // itself; there is no command to look up afterwards.
  commands: { completion: "confirmed", polling: false },
};

/** Creates the reusable bpc-csms-cloud operation surface, without TCK
 *  lifecycle hooks. */
export function createBpcCsmsCloudCsmsDriver(options: BpcCsmsCloudCsmsDriverOptions): CsmsDriver {
  const api = new BpcCsmsCloudApi(options.config, options.fetch);
  const refs = options.refs ?? {};
  const timeoutMs = options.config.dispatchTimeoutMs ?? DEFAULT_BPC_CSMS_CLOUD_DISPATCH_TIMEOUT_MS;
  return {
    capabilities: BPC_CSMS_CLOUD_CAPABILITIES,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    operations16: {
      async execute(cpId: string, operation: CsmsOperation16): Promise<string> {
        return dispatch(api, cpId, operation, refs, timeoutMs);
      },
    },
    commands: {
      submit16: async (cpId, operation, opts) =>
        submitOperation(api, cpId, operation, refs, timeoutMs, opts?.signal),
    },
  };
}

export * from "./api-client.ts";
export * from "./config.ts";
export * from "./requests.ts";

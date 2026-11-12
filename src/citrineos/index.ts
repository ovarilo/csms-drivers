// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

import {
  CSMS_OPERATION_16_ACTIONS,
  CSMS_OPERATION_201_ACTIONS,
  type CommandOutcome,
  type CsmsCapabilities,
  type CsmsOperation16,
  type CsmsOperation201,
  type FetchLike,
} from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import type { CsmsConnectorApi, CsmsSessionApi } from "../models.ts";
import type { CitrineApiConfig } from "./config.ts";
import { CitrineMessageApi } from "./api-client.ts";
import { toCitrineRequest, toCitrineRequest201, type CitrineRefs } from "./requests.ts";
import { speaksOcpp201, unroutedActions, unroutedActions201 } from "./variant.ts";

export interface CitrineOsCsmsDriverOptions {
  readonly config: CitrineApiConfig;
  readonly refs: CitrineRefs;
  readonly fetch?: FetchLike;
  readonly sessions?: CsmsSessionApi;
  readonly connectors?: CsmsConnectorApi;
}

export function citrineOsCapabilities(config: CitrineApiConfig): CsmsCapabilities {
  const unsupported16 = unroutedActions(config.variant);
  const unsupported201 = unroutedActions201(config.variant);
  return {
    operations16: new Set(CSMS_OPERATION_16_ACTIONS.filter((action) => !unsupported16.has(action))),
    ...(speaksOcpp201(config.variant)
      ? {
          operations201: new Set(
            CSMS_OPERATION_201_ACTIONS.filter((action) => !unsupported201.has(action)),
          ),
        }
      : {}),
    // CitrineOS acknowledges the dispatch, not the station's answer.
    commands: { completion: "accepted", polling: false },
  };
}

const accepted = (): CommandOutcome => ({ state: "accepted", at: new Date().toISOString() });

/** Creates the reusable CitrineOS operation surface without TCK lifecycle hooks. */
export function createCitrineOsCsmsDriver(options: CitrineOsCsmsDriverOptions): CsmsDriver {
  const api = new CitrineMessageApi(options.config, options.fetch);
  const execute16 = async (cpId: string, operation: CsmsOperation16): Promise<string> => {
    const request = await toCitrineRequest(operation, options.refs, options.config.variant);
    return api.send(cpId, request);
  };
  const v2 = speaksOcpp201(options.config.variant);
  const execute201 = async (cpId: string, operation: CsmsOperation201): Promise<string> =>
    api.send(cpId, toCitrineRequest201(operation, options.config.variant));
  return {
    capabilities: citrineOsCapabilities(options.config),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    operations16: { execute: execute16 },
    ...(v2 ? { operations201: { execute: execute201 } } : {}),
    // Accepted-only: what `execute` throws is thrown here too, and `submit201`
    // exists exactly when `operations201` does.
    commands: {
      async submit16(cpId, operation, opts) {
        opts?.signal?.throwIfAborted();
        await execute16(cpId, operation);
        return accepted();
      },
      ...(v2
        ? {
            async submit201(
              cpId: string,
              operation: CsmsOperation201,
              opts?: { signal?: AbortSignal },
            ) {
              opts?.signal?.throwIfAborted();
              await execute201(cpId, operation);
              return accepted();
            },
          }
        : {}),
    },
  };
}

export * from "./api-client.ts";
export * from "./config.ts";
export * from "./requests.ts";
export * from "./variant.ts";

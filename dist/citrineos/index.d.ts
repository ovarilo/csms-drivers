import { type CsmsCapabilities, type FetchLike } from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import type { CsmsConnectorApi, CsmsSessionApi } from "../models.ts";
import type { CitrineApiConfig } from "./config.ts";
import { type CitrineRefs } from "./requests.ts";
export interface CitrineOsCsmsDriverOptions {
    readonly config: CitrineApiConfig;
    readonly refs: CitrineRefs;
    readonly fetch?: FetchLike;
    readonly sessions?: CsmsSessionApi;
    readonly connectors?: CsmsConnectorApi;
}
export declare function citrineOsCapabilities(config: CitrineApiConfig): CsmsCapabilities;
/** Creates the reusable CitrineOS operation surface without TCK lifecycle hooks. */
export declare function createCitrineOsCsmsDriver(options: CitrineOsCsmsDriverOptions): CsmsDriver;
export * from "./api-client.ts";
export * from "./config.ts";
export * from "./requests.ts";
export * from "./variant.ts";

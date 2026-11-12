// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * http.ts -- the response helpers the CitrineOS clients use, kept at this path
 * because `@ovarilo/csms-drivers/citrineos/http` is a public subpath that
 * adapters composing their own CitrineOS driver import.
 *
 * The helpers themselves live in `../shared/http.ts`, shared with the other
 * drivers; see that module for the rule they hold. This module re-exports the
 * part of it the subpath was published with, and nothing more.
 */
export { errorBody, preview, readAnsweredBody } from "../shared/http.ts";

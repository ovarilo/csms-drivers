// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Public-factory composition: a SteVe OCPP 1.6 operation must be encoded and
 * posted through its authenticated manager-UI flow, and a CitrineOS OCPP 1.6
 * operation must reach the matching route with its station and tenant. A SteVe
 * ReserveNow carrying a parentIdTag is posted only when it is the parent
 * SteVe will send anyway, and refused as unsupported otherwise. The fakes
 * observe the public factory result without starting a CSMS.
 */

import {
  createCitrineOsCsmsDriver,
  createSteveCsmsDriver,
  STEVE_CAPABILITIES,
  UnsupportedOperationError,
  type CommandOutcome,
} from "@ovarilo/csms-drivers";
import type { FetchLike } from "@ovarilo/csms-drivers";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

async function verifySteveFactory(): Promise<void> {
  const posts: { url: string; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/signin") && method === "GET") {
      return new Response('<input name="_csrf" value="login-token">');
    }
    if (url.endsWith("/signin") && method === "POST") {
      return redirect("/manager/home");
    }
    if (url.endsWith("/operations/v1.6/Reset") && method === "GET") {
      return new Response('<input name="_csrf" value="operation-token">');
    }
    if (url.endsWith("/operations/v1.6/Reset") && method === "POST") {
      posts.push({ url, body: await new Response(init?.body).text() });
      return redirect("/manager/operations/tasks/42");
    }
    return new Response("unexpected request", { status: 500 });
  };

  const driver = createSteveCsmsDriver({
    config: { baseUrl: "http://steve/manager", username: "operator", password: "secret" },
    fetch,
  });
  const receipt = await driver.operations16.execute("CP-1", { action: "Reset", type: "Hard" });
  const form = new URLSearchParams(posts[0]?.body);

  check(
    driver.capabilities.operations16.has("Reset"),
    "SteVe capability declaration includes its wired operation",
  );
  check(
    driver.capabilities === STEVE_CAPABILITIES,
    "the package root exports STEVE_CAPABILITIES, the declaration the SteVe factory returns",
  );
  check(
    driver.operations201 === undefined,
    "SteVe factory does not claim an OCPP 2.0.1 operation surface",
  );
  check(receipt === "/manager/operations/tasks/42", "SteVe factory returns its task redirect");
  check(posts.length === 1, "SteVe factory posts one OCPP operation");
  check(posts[0]?.url.endsWith("/operations/v1.6/Reset"), "SteVe factory selects the Reset form");
  check(
    form.get("chargePointSelectList") === "V_16_JSON;CP-1;-",
    "SteVe factory targets the requested station",
  );
  check(form.get("resetType") === "HARD", "SteVe factory maps the OCPP operation to the UI form");
}

/**
 * SteVe's ReserveNow form has no parentIdTag field: SteVe sends the reserved
 * tag's STORED parent (ChargePointServiceClient#reserveNow reads it from
 * ocpp_tag). So a requested parentIdTag is either the one SteVe will send, or
 * one this driver cannot express -- and dropping it silently would let a
 * scenario believe it reserved for a group it never named. Four rows: the
 * request without a parent is untouched, and a parent is posted only when the
 * injected lookup says SteVe stores exactly that one.
 */
async function verifySteveReserveNowParent(): Promise<void> {
  function harness(): { fetch: FetchLike; posts: string[] } {
    const posts: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/signin") && method === "GET") {
        return new Response('<input name="_csrf" value="login-token">');
      }
      if (url.endsWith("/signin") && method === "POST") {
        return redirect("/manager/home");
      }
      if (url.endsWith("/operations/v1.6/ReserveNow") && method === "GET") {
        return new Response('<input name="_csrf" value="operation-token">');
      }
      if (url.endsWith("/operations/v1.6/ReserveNow") && method === "POST") {
        posts.push(await new Response(init?.body).text());
        return redirect("/manager/operations/tasks/43");
      }
      return new Response("unexpected request", { status: 500 });
    };
    return { fetch, posts };
  }
  const config = { baseUrl: "http://steve/manager", username: "operator", password: "secret" };
  const reserve = {
    action: "ReserveNow" as const,
    connectorId: 1,
    idTag: "TAG-RES",
    expiryDate: new Date("2030-01-01T00:00:00Z"),
  };
  const lookedUp: string[] = [];
  const storedParent = async (idTag: string): Promise<string | null> => {
    lookedUp.push(idTag);
    return idTag === "TAG-RES" ? "TAG-GRP" : null;
  };

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
      return undefined;
    } catch (err) {
      return err;
    }
  }

  const plain = harness();
  await createSteveCsmsDriver({ config, fetch: plain.fetch }).operations16.execute("CP-1", reserve);
  check(plain.posts.length === 1, "SteVe ReserveNow without a parentIdTag is posted as before");

  const blind = harness();
  const blindErr = await refusal(
    createSteveCsmsDriver({ config, fetch: blind.fetch }).operations16.execute("CP-1", {
      ...reserve,
      parentIdTag: "TAG-GRP",
    }),
  );
  check(
    blindErr instanceof UnsupportedOperationError,
    "SteVe ReserveNow refuses a parentIdTag it has no way to check against the stored parent",
  );
  check(
    blind.posts.length === 0,
    "SteVe ReserveNow posts nothing when it cannot check the parentIdTag",
  );

  const matching = harness();
  const matchingErr = await refusal(
    createSteveCsmsDriver({
      config,
      fetch: matching.fetch,
      ocppTagParent: storedParent,
    }).operations16.execute("CP-1", {
      ...reserve,
      parentIdTag: "TAG-GRP",
    }),
  );
  check(
    matchingErr === undefined && matching.posts.length === 1,
    `SteVe ReserveNow posts a parentIdTag equal to the reserved tag's stored parent${matchingErr ? ` (threw: ${matchingErr instanceof Error ? matchingErr.message : JSON.stringify(matchingErr)})` : ""}`,
  );
  check(
    lookedUp.join(",") === "TAG-RES",
    "SteVe ReserveNow looks up the parent of the RESERVED idTag",
  );

  const wrong = harness();
  const wrongErr = await refusal(
    createSteveCsmsDriver({
      config,
      fetch: wrong.fetch,
      ocppTagParent: storedParent,
    }).operations16.execute("CP-1", {
      ...reserve,
      parentIdTag: "TAG-OTHER",
    }),
  );
  check(
    wrongErr instanceof UnsupportedOperationError,
    "SteVe ReserveNow refuses a parentIdTag other than the reserved tag's stored parent",
  );
  check(
    wrong.posts.length === 0,
    "SteVe ReserveNow posts nothing for a parentIdTag SteVe would not send",
  );
}

async function verifyCitrine16Factory(): Promise<void> {
  let requestUrl = "";
  let requestBody = "";
  const fetch: FetchLike = async (input, init) => {
    requestUrl = String(input);
    requestBody = await new Response(init?.body).text();
    return Response.json([{ success: true, payload: "Accepted" }]);
  };

  const driver = createCitrineOsCsmsDriver({
    config: { variant: "v2", apiUrl: "http://citrine/api", tenantId: 7 },
    refs: { ocppTransactionId: async () => 1 },
    fetch,
  });
  const receipt = await driver.operations16.execute("CP-2", { action: "Reset", type: "Hard" });

  check(
    driver.capabilities.operations16.has("Reset"),
    "CitrineOS capability declaration includes its wired operation",
  );
  check(
    driver.capabilities.operations201?.has("Reset") === true,
    "CitrineOS declares its wired OCPP 2.0.1 operation surface",
  );
  check(driver.operations201 !== undefined, "CitrineOS factory returns its OCPP 2.0.1 operations");
  check(
    requestUrl.includes("/ocpp/1.6/configuration/reset?"),
    "CitrineOS factory sends a 1.6 Reset route",
  );
  check(
    requestUrl.includes("identifier=CP-2") && requestUrl.includes("tenantId=7"),
    "CitrineOS factory targets the station and tenant",
  );
  check(requestBody === '{"type":"Hard"}', "CitrineOS factory serializes the 1.6 request body");
  check(receipt.includes('"success":true'), "CitrineOS factory returns the confirmation receipt");
}

/**
 * `commands` on the two accepted-only drivers (SteVe, CitrineOS). Neither CSMS
 * hands back the station's answer, so a successful dispatch is `accepted`,
 * never `confirmed`, with no ref (nothing to poll) and no `poll`. What
 * `execute` throws -- a capability gap, a request that never became a CALL --
 * is still thrown, and the variant decides whether `submit201` exists.
 */
async function verifyAcceptedOnlyCommands(): Promise<void> {
  const config = { baseUrl: "http://steve/manager", username: "operator", password: "secret" };
  const steveFetch = (resetStatus: number): FetchLike => {
    return async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/signin") && method === "GET") {
        return new Response('<input name="_csrf" value="login-token">');
      }
      if (url.endsWith("/signin") && method === "POST") return redirect("/manager/home");
      if (url.endsWith("/operations/v1.6/Reset") && method === "GET") {
        return new Response('<input name="_csrf" value="operation-token">');
      }
      if (url.endsWith("/operations/v1.6/Reset") && method === "POST") {
        return resetStatus === 302
          ? redirect("/manager/operations/tasks/42")
          : new Response("boom", { status: resetStatus });
      }
      return new Response("unexpected request", { status: 500 });
    };
  };
  const reset = { action: "Reset" as const, type: "Hard" as const };
  const shape = (o: CommandOutcome): string =>
    o.state === "accepted" && !("ref" in o) && !Number.isNaN(Date.parse(o.at))
      ? "accepted"
      : JSON.stringify(o);
  async function thrown(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
      return undefined;
    } catch (err) {
      return err;
    }
  }

  const steve = createSteveCsmsDriver({ config, fetch: steveFetch(302) });
  check(
    steve.capabilities.commands?.completion === "accepted" &&
      steve.capabilities.commands.polling === false,
    "SteVe declares commands { completion: accepted, polling: false }",
  );
  check(
    steve.commands?.poll === undefined && steve.commands?.submit201 === undefined,
    "SteVe commands has neither poll nor submit201",
  );
  check(
    shape((await steve.commands?.submit16("CP-1", reset)) as CommandOutcome) === "accepted",
    "SteVe submit16 reports an accepted outcome without a ref",
  );
  const aborted = new AbortController();
  aborted.abort();
  check(
    (await thrown(steve.commands!.submit16("CP-1", reset, { signal: aborted.signal }))) !==
      undefined,
    "SteVe submit16 posts nothing for an already aborted signal",
  );
  check(
    (await thrown(
      createSteveCsmsDriver({ config, fetch: steveFetch(500) }).commands!.submit16("CP-1", reset),
    )) instanceof Error,
    "SteVe submit16 throws what execute throws when the form is not accepted",
  );
  check(
    (await thrown(
      steve.commands!.submit16("CP-1", {
        action: "ReserveNow",
        connectorId: 1,
        idTag: "T",
        expiryDate: new Date("2030-01-01T00:00:00Z"),
        parentIdTag: "P",
      }),
    )) instanceof UnsupportedOperationError,
    "SteVe submit16 throws UnsupportedOperationError for a request it cannot express",
  );

  const citrineFetch: FetchLike = async () =>
    Response.json([{ success: true, payload: "Accepted" }]);
  const refs = { ocppTransactionId: async () => 1 };
  const v2 = createCitrineOsCsmsDriver({
    config: { variant: "v2", apiUrl: "http://citrine/api", tenantId: 7 },
    refs,
    fetch: citrineFetch,
  });
  check(
    v2.capabilities.commands?.completion === "accepted" &&
      v2.capabilities.commands.polling === false &&
      v2.commands?.poll === undefined,
    "CitrineOS v2 declares commands { completion: accepted, polling: false } and no poll",
  );
  check(
    shape((await v2.commands?.submit16("CP-2", reset)) as CommandOutcome) === "accepted",
    "CitrineOS v2 submit16 reports an accepted outcome without a ref",
  );
  check(
    shape(
      (await v2.commands?.submit201?.("CP-2", {
        action: "Reset",
        type: "Immediate",
      })) as CommandOutcome,
    ) === "accepted",
    "CitrineOS v2 submit201 reports an accepted outcome without a ref",
  );
  const v1 = createCitrineOsCsmsDriver({
    config: { variant: "v1", apiUrl: "http://citrine/api", tenantId: 7 },
    refs,
    fetch: citrineFetch,
  });
  check(
    v1.capabilities.commands?.completion === "accepted" && v1.commands?.submit201 === undefined,
    "CitrineOS v1 declares commands but has no submit201, like operations201",
  );
  check(
    shape((await v1.commands?.submit16("CP-2", reset)) as CommandOutcome) === "accepted",
    "CitrineOS v1 submit16 reports an accepted outcome",
  );
  check(
    (await thrown(
      createCitrineOsCsmsDriver({
        config: { variant: "v2", apiUrl: "http://citrine/api", tenantId: 7 },
        refs,
        fetch: async () => new Response("down", { status: 500 }),
      }).commands!.submit16("CP-2", reset),
    )) instanceof Error,
    "CitrineOS submit16 throws what execute throws when the API refuses",
  );
}

await verifySteveFactory();
await verifySteveReserveNowParent();
await verifyCitrine16Factory();
await verifyAcceptedOnlyCommands();

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("CSMS factories: SteVe UI wiring and CitrineOS 1.6 dispatch hold.");
}

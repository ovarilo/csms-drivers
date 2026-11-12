# The CSMS driver over HTTP

`@ovarilo/csms-drivers/server` serves a CSMS driver over HTTP/JSON, so an
application in any language can provision a charge point and send an OCPP 1.6
remote operation through the CSMS without importing TypeScript. The API is the
same whichever CSMS is behind it: SteVe's form fields and CitrineOS's routes
stay inside their drivers.

The handler is a thin adapter. Each request decodes its body, checks what the
driver declares, makes at most one driver call and translates the outcome. It
keeps no state between requests and runs no workflow: sequencing calls is the
client's job.

## Running it

`createCsmsHttpHandler(driver, options)` is a `(Request) => Promise<Response>`
over any `CsmsDriver`, which you can hand to `Bun.serve`:

```ts
import { createSteveCsmsDriver } from "@ovarilo/csms-drivers";
import { createCsmsHttpHandler } from "@ovarilo/csms-drivers/server";

const driver = createSteveCsmsDriver({ config: { baseUrl, username, password } });
Bun.serve({
  hostname: "127.0.0.1",
  port: 8787,
  fetch: createCsmsHttpHandler(driver, {
    about: { id: "steve", displayName: "SteVe" },
    secrets: [password],
    log: (line) => console.error(line),
  }),
});
```

| option | default | |
|---|---|---|
| `about` | required | The identity `GET /v1/driver` reports. |
| `timeoutMs` | `60000` | How long one driver call may take before the server answers `504 timeout`. From 1 to 2147483647: a deadline that expires before any driver can answer would report every dispatched operation as `timeout`, so it is refused with a `RangeError` rather than clamped. |
| `secrets` | none | Values redacted from every message the server returns or logs: the driver's credentials. |
| `log` | none | Receives one line per request (method, path, status, error code), never a body. |

The handler has no authentication of its own, so listen on loopback unless
you put an authenticated proxy in front of it.

The `ocpp-tck csms-server` command of
[open-ocpp-tck](https://github.com/juherr/open-ocpp-tck) is a ready-made host
for this handler: it loads a driver from `CSMS_DRIVER`, derives `secrets`
from the environment and stops on SIGINT or SIGTERM.

Credentials are never returned: `GET /v1/driver` reports declarations only,
and the read-back of a charge point has no password. Error messages and log
lines are redacted, but only of values the handler knows: the `secrets` it was
given, and the Basic Auth password carried by the request itself. A driver's
built-in default credential is not known to it. Neither is a password the CSMS
echoes back escaped or truncated.

### Browsers cannot call it

Listening on loopback keeps other machines out, but not a web page open on
the same machine: a page can send a cross-origin "simple" request (a `POST`
with a `text/plain` body) to `127.0.0.1` without a CORS preflight. The page
never reads the response, but the operation still happens. Browser
protections for local addresses (Local Network Access) are not available in
every browser, so the server refuses these requests itself, before routing
and before any driver call:

- a request carrying an `Origin` header answers `403 forbidden_origin`.
  Browsers send it on every cross-origin `POST`, including form posts and
  `no-cors` requests, and native HTTP clients do not;
- a `POST` or `PATCH` whose `Content-Type` is not `application/json` (with or
  without parameters such as `; charset=utf-8`) answers
  `415 unsupported_media_type`. This applies to operations without a body,
  such as `clear-cache`, too. A page cannot send this type without a
  preflight, and the server answers no preflight.

So a client must send `Content-Type: application/json` on every `POST` and
`PATCH`; `curl -d` does not do it by default, so add
`-H 'content-type: application/json'`. `DELETE` needs no content type.

To drive the server from a browser application, put your own authenticated
backend in front of it.

One gap remains, and it is accepted on purpose: reads. A page using DNS
rebinding reaches the server under its own host name, so to the browser its
`GET` requests are same-origin and carry no `Origin`. Such a page can read
everything the two `GET` routes return:

- `GET /v1/driver`: the driver's id and display name, its protocols, the
  operations it supports and the security profiles it accepts;
- `GET /v1/charge-points/{id}`, for an id it already knows or guesses (there
  is no route that lists stations): that station's registration status, its
  security profile number and its `description`.

None of this is a credential: passwords are never read back, and the driver's
own credentials never leave it. But `description` is free text, and whatever
an operator writes there (a site address, an internal note) is exposed this
way. Do not put anything in it you would not show to a web page.

Such a page still cannot write. Browsers send `Origin` on every request whose
method is not `GET` or `HEAD`, same-origin ones included (as `null` under a
`no-referrer` policy), and the server refuses any request that carries it.

The server does not check the `Host` header. That would close the read gap,
but it would also refuse clients that address the server by another name.

### Authentication and `Host` are yours

The handler performs no authentication and no `Host`-header check, so a
DNS-rebinding page can read every `GET` through the user's browser. The
embedding application must put both in front of it (a reverse proxy or
middleware that authenticates the caller and refuses an unexpected `Host`).
This matters most for `GET /v1/commands/{ref}`: its `outcome` can carry the
station's own `response` payload, and any caller that can guess or obtain a
ref can read it.

## The API

All routes are under `/v1`. Bodies are JSON. Decoding is strict: a missing or
mistyped member is refused, and so is any member the model does not have.

| route | driver call |
|---|---|
| `GET /v1/driver` | none: what the driver declares |
| `POST /v1/charge-points` | `chargePoints.create` |
| `GET /v1/charge-points/{id}` | `chargePoints.get` |
| `PATCH /v1/charge-points/{id}` | `chargePoints.update` |
| `DELETE /v1/charge-points/{id}` | `chargePoints.delete` |
| `POST /v1/charge-points/{id}/operations/{operation}` | `operations16.execute`, or `commands.submit16` when the driver has it |
| `GET /v1/commands/{ref}` | `commands.poll` |

`{id}` is the station's OCPP identity, percent-encoded like any other path
segment.

### What the driver supports

```http
GET /v1/driver
```

For example, for a driver that declares two operations and charge-point
administration:

```json
{
  "id": "example",
  "displayName": "Example CSMS",
  "protocols": ["OCPP-1.6J"],
  "operations16": [
    { "operation": "reset", "action": "Reset" },
    { "operation": "remote-start", "action": "RemoteStartTransaction" }
  ],
  "chargePoints": {
    "securityProfiles": [0, 1, 2],
    "registrations": ["Accepted", "Pending", "Rejected"],
    "basicAuthPassword": "supplied",
    "description": "optional"
  },
  "commands": { "completion": "accepted", "polling": false }
}
```

`operations16` lists only the operations this driver declares. `chargePoints`
is `null` unless the driver both declares charge-point administration and
provides it. `commands` is `null` unless the driver both declares command
outcomes and provides them; `polling` is `true` only when `GET
/v1/commands/{ref}` is served. `protocols` is `null` when the driver does not
say.

### Provisioning a charge point

The model is the library's [charge-point administration](../README.md#charge-point-administration)
surface, and the JSON members carry the same names.

```http
POST /v1/charge-points
content-type: application/json

{
  "id": "CP-1",
  "registration": "Accepted",
  "security": { "profile": 1, "basicAuthPassword": "s3cret" },
  "description": "Bay 1"
}
```

```http
HTTP/1.1 201 Created
location: /v1/charge-points/CP-1

{ "id": "CP-1" }
```

- `registration` is `Accepted`, `Pending` or `Rejected`. If omitted, it is
  `Accepted`.
- `security.profile` is 0 to 3. For profiles 1 and 2, whether
  `basicAuthPassword` is required depends on `chargePoints.basicAuthPassword`
  (below); a password that is present must be non-empty, and one absent while
  the driver is `"supplied"` answers `501 unsupported_capability`, not 400.
  Profiles 0 and 3 refuse one. If `security` is omitted,
  the profile is 0. A profile the driver does not list in
  `securityProfiles`, including that implicit 0, answers
  `501 unsupported_capability`. So does a `registration` the driver does not
  list in `registrations`; the description always lists them, all three when
  the driver declares none.
- `create` is not an upsert. If the id already exists, it answers
  `409 conflict` and changes nothing.
- `chargePoints.basicAuthPassword` in the description says who chooses the
  password of profile 1 and 2. `"supplied"` (the default) is the request above.
  `"generated"`: send `"security": { "profile": 1 }` with no
  `basicAuthPassword`; the CSMS makes one and the response carries it, once:

  ```http
  HTTP/1.1 201 Created
  cache-control: no-store

  { "id": "CP-1", "generatedBasicAuthPassword": "k3x9..." }
  ```

  The wrong shape for the driver (a password sent to a generating driver, none
  to a supplying one) answers `501 unsupported_capability`. The password is
  never read back by `GET` and never logged: log lines carry the method, the
  path and the status, no body. It is not in `secrets` either, because it is
  the payload; store it from the response.
- `chargePoints.description` is `"optional"` (the default) or `"required"`.
  When required, a `create` without a non-blank `description` answers
  `400 invalid_input`.

```http
GET /v1/charge-points/CP-1
```

```json
{ "id": "CP-1", "registration": "Accepted", "security": { "profile": 1 }, "description": "Bay 1" }
```

An unknown id answers `404 not_found`. The password is never read back.

```http
PATCH /v1/charge-points/CP-1
content-type: application/json

{ "registration": "Rejected", "description": null }
```

`PATCH` answers `204` and changes only the members it names. A `security`
block replaces the whole block, so moving to profile 0 or 3 discards the
stored password. On a driver that generates passwords, a `security` of profile
1 or 2 without `basicAuthPassword` rotates it, and the answer is then `200`
with `{ "generatedBasicAuthPassword": "..." }` (`cache-control: no-store`)
instead of `204`. `"description": null` clears the description, unless the
driver requires one: `null` or a blank description then answers
`400 invalid_input`. An unknown id
answers `404 not_found` and creates nothing. A `security.profile` or
`registration` the driver does not declare answers
`501 unsupported_capability`, checked before the id is looked up.

`DELETE /v1/charge-points/CP-1` answers `204`, including for an id that does
not exist.

To provision idempotently, call `GET` first, then `POST` if the station is
absent or `PATCH` if it exists.

### Sending an OCPP 1.6 operation

```http
POST /v1/charge-points/CP-1/operations/reset
content-type: application/json

{ "type": "Hard" }
```

```http
HTTP/1.1 202 Accepted

{ "chargePointId": "CP-1", "operation": "reset", "action": "Reset", "status": "dispatched" }
```

`202` means the CSMS accepted or dispatched the request. It does not mean the
charge point has answered: the charge point's response is not returned, and
the station side is where to observe it. The body is the operation's
`CsmsOperation16` arm without `action`, because the path names the action.
Dates are RFC 3339 strings with an offset (`2030-01-02T03:04:05Z`). A date
that does not exist, such as `2030-02-31` or hour 24, is refused instead of
being rolled over to another day. A leap second is refused too, because the
driver contract carries a JavaScript `Date`.
Transaction, reservation and charging-profile references are the driver's
opaque string handles. An operation without members accepts an empty body.

| path | `CsmsOperation16` action | body |
|---|---|---|
| `reset` | `Reset` | `type`: `Hard` \| `Soft` |
| `unlock` | `UnlockConnector` | `connectorId` |
| `clear-cache` | `ClearCache` | none |
| `change-availability` | `ChangeAvailability` | `connectorId`, `type`: `Operative` \| `Inoperative` |
| `get-configuration` | `GetConfiguration` | `keys?`: string[] (omitted means every key) |
| `change-configuration` | `ChangeConfiguration` | `key`, `value` |
| `remote-start` | `RemoteStartTransaction` | `idTag`, `connectorId?`, `chargingProfile?` |
| `remote-stop` | `RemoteStopTransaction` | `transaction` |
| `trigger-message` | `TriggerMessage` | `requestedMessage`, `connectorId?` |
| `set-charging-profile` | `SetChargingProfile` | `connectorId`, `chargingProfile`, `transaction?` |
| `get-composite-schedule` | `GetCompositeSchedule` | `connectorId`, `duration`, `chargingRateUnit?` |
| `clear-charging-profile` | `ClearChargingProfile` | `chargingProfile?`, `connectorId?`, `purpose?`, `stackLevel?` |
| `update-firmware` | `UpdateFirmware` | `location`, `retrieveDate`, `retries?`, `retryInterval?` |
| `get-diagnostics` | `GetDiagnostics` | `location`, `startTime?`, `stopTime?`, `retries?`, `retryInterval?` |
| `get-local-list-version` | `GetLocalListVersion` | none |
| `send-local-list` | `SendLocalList` | `listVersion`, `updateType`, `localAuthorizationList?` |
| `reserve-now` | `ReserveNow` | `connectorId`, `idTag`, `expiryDate`, `parentIdTag?`, `reservation?` |
| `cancel-reservation` | `CancelReservation` | `reservation` |

The member types and enumerations are those of `CsmsOperation16` in
[`contracts.ts`](../contracts.ts).

### Command outcomes

A driver that provides the optional `commands` surface makes the same `202`
carry what is known about the command:

```http
HTTP/1.1 202 Accepted

{ "chargePointId": "CP-1", "operation": "reset", "action": "Reset", "status": "dispatched",
  "outcome": { "state": "accepted", "at": "2030-01-02T03:04:05.000Z", "ref": "cmd-1" } }
```

`status: "dispatched"` stays for clients that predate `outcome`, and is not a
verdict: **read `outcome.state`**. A driver without `commands` answers exactly
as before, with no `outcome`. The server then makes one `commands.submit16` call
instead of `operations16.execute`.

| `outcome.state` | meaning | fields |
|---|---|---|
| `unsupported` | The CSMS cannot express the command. Nothing was sent. | `reason` |
| `rejected` | The CSMS or the station refused it (including a CSMS refusal of the request). | `at`, `detail?` |
| `accepted` | Dispatched or queued. The station's answer is **not** known. | `at`, `ref?` |
| `confirmed` | The station's `CALLRESULT` was observed. | `at`, `ref?`, `response?` |
| `failed` | A `CALLERROR`, or the command failed after dispatch. | `at`, `ref?`, `detail?` |
| `unknown` | No evidence either way. | `at`, `ref?`, `cause`: `timeout` \| `connection-lost` \| `no-evidence`, `detail?` |

`at` is an ISO 8601 instant. `detail` and `response` are redacted of the
server's `secrets`, at any depth, like every other message it returns.

One rule: a verdict (`unsupported`, `rejected`, `failed`, `unknown`) is
returned by `submit16` as a value, so it is a `202` with an `outcome`; it does not
change the status line. `submit16` throws only when no verdict can be given (an
environment or transport fault before any answer, a plain `Error`), and that
is an error response with no `outcome` (`502`, `504`...). A driver that still
throws `UnsupportedOperationError` or `CsmsNotDispatchedError` from `submit16`
is a legacy path: the handler maps it as for `execute` (`501`, `502`), with no
`outcome`. Those two classes are `execute` semantics, not the `submit16` contract.

```http
GET /v1/commands/cmd-1
```

```json
{ "ref": "cmd-1", "outcome": { "state": "confirmed", "at": "2030-01-02T03:04:09.000Z", "ref": "cmd-1", "response": { "status": "Accepted" } } }
```

Polling exists only when `commands.polling` is `true`: otherwise the route
answers `501 unsupported_capability`, and a `ref` the driver does not know is
`404 not_found`. The `ref` is opaque; percent-encode it.

#### What a 2xx means, per driver

A `2xx` is a statement about the CSMS, never about the station, unless
`outcome.state` is `confirmed`. `capabilities.commands.completion` is the
furthest state `submit16` reaches on its own:

- `accepted`: the CSMS took the command. The station's `CALLRESULT` is never
  read back, so a station that ignores the CALL, or answers `Rejected`, still
  yields `accepted`. `Reset` accepted is not a reset rebooted.
- `confirmed`: the driver can read the station's `CALLRESULT`. Even then the
  status inside it (`Accepted`, `Rejected`, `Scheduled`) is the station's
  answer to the request, not proof the effect happened: `Reset` `Accepted`
  means the station will reset, not that it has.

What each bundled driver reads, and what its `2xx` or `CALLRESULT` therefore
means, is in the table of the main README ("Command outcomes" in
[`README.md`](../../README.md#command-outcomes)). SteVe and CitrineOS are
accepted-only: their `outcome` never goes past `accepted`.

#### Safe handling in a UI

- Show `accepted` as "sent", never "done". Show `confirmed` as "the station
  answered", and its `response` as the station's words.
- Show `unknown` as "no answer yet", with `cause`. Never render it, or a `504
  timeout`, as an error that implies nothing happened: the station may have
  acted.
- `rejected`, `failed` and `unsupported` mean it did not happen as asked:
  those can be shown as failures.
- Do not infer `failed` from a timeout, in either direction.

#### Retrying

No idempotency key is offered, so a retry is a second command.

- `unknown`, `504 timeout` and `connection-lost` leave it open whether the
  first command took effect. If the driver `polling`, poll the `ref` first
  (when there is one) and retry only on a verdict that says it did not run.
- Retry blind only an idempotent operation: `Reset`, `ChangeAvailability`,
  `ChangeConfiguration`, `ClearCache`, `TriggerMessage`, `UnlockConnector`
  are in practice safe to repeat. `RemoteStartTransaction`, `ReserveNow` and
  `SendLocalList` are not: ask for state (`GetConfiguration`, the
  transaction list, your own record of the `ref`) before sending them again.
- `accepted` is not a reason to retry. Wait, then poll or observe the station.

## Errors

Every error has the same body. Branch on `code`; `message` is for humans and
may change.

```json
{ "error": { "code": "unsupported_capability", "message": "this driver does not declare ReserveNow" } }
```

| status | `code` | meaning |
|---|---|---|
| 400 | `invalid_input` | The body is not valid JSON, or does not match the model. The driver was not called. |
| 404 | `not_found` | No such route or operation path, no such charge point, or no such command `ref`. |
| 403 | `forbidden_origin` | The request carries an `Origin` header, so it comes from a browser page. See [Browsers cannot call it](#browsers-cannot-call-it). The driver was not called. |
| 405 | `method_not_allowed` | The route exists but does not serve this method. The `allow` header names the methods it does serve. |
| 415 | `unsupported_media_type` | A `POST` or `PATCH` without `Content-Type: application/json`. The driver was not called. |
| 409 | `conflict` | `create` of an id that already exists. Nothing was changed. |
| 501 | `unsupported_capability` | The driver does not declare the operation, has no charge-point administration, does not accept the security profile or registration status, does not poll command outcomes (`GET /v1/commands/{ref}`), or refused the request as something it cannot express. |
| 502 | `transport_failure` | The request never reached the CSMS as an operation: the connection failed, the CSMS refused the driver's credentials, or it refused the request before dispatching it. The driver contract has no separate class for an authentication failure, so this code covers it. |
| 502 | `csms_rejected` | The CSMS answered, but did not do what was asked, for example a form that came back with validation errors. |
| 504 | `timeout` | The driver call did not finish within `--timeout-ms`. **The outcome is unknown**: the request may still have been dispatched. It carries no `outcome`, and is never to be read as a failure. |
| 500 | `internal` | A defect in the server itself. |

## Limits

- OCPP 1.6 operations only. The OCPP 2.0.1 vocabulary (`operations201`) is
  not served yet; it would get its own path prefix, so adding it changes
  nothing above.
- The server does not read sessions or connector state.

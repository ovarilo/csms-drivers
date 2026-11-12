// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * charge-points.ts -- the charge-point administration contract, asked of one
 * `CsmsDriver`. The property it checks, and why each rule is stated the way it
 * is, are in the header of tests/csms-driver-charge-points.ts, which holds this
 * suite to a flawed copy per rule.
 *
 * Published as `@ovarilo/csms-drivers/conformance`, so a LIVE caller can import
 * it without running that guard: `tools/steve-charge-points.ts` asks it of the
 * pinned SteVe. Pure functions over the core types, no test runner. The
 * stations it creates use the fixed ids in {@link CONFORMANCE_IDS}, which a
 * crashed run leaves behind, so a live caller runs
 * {@link clearConformanceStations} first. Not the check itself: a flawed copy
 * whose `delete` throws would then fail before its own rule is asked.
 */
import {
  ChargePointAlreadyExistsError,
  ChargePointNotFoundError,
  type ChargePointDefinition,
  type ChargePointDetails,
  type ChargePointProvisioned,
  type ChargePointRegistration,
  type ChargePointSecurity,
  type ChargePointSecurityProfile,
  type ChargePointUpdate,
  type CsmsChargePointAdmin,
  type CsmsChargePointCapabilities,
} from "../charge-points.ts";
import { UnsupportedOperationError } from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import { createRecorder, type ConformanceRecorder, type ConformanceReport } from "./report.ts";

/** Every station id the lifecycle may create, and the one it must never find. */
export const CONFORMANCE_IDS = [
  "CONFORMANCE-1",
  "CONFORMANCE-2",
  "CONFORMANCE-3",
  "CONFORMANCE-4",
  "CONFORMANCE-5",
  "CONFORMANCE-6",
  "CONFORMANCE-7",
  "CONFORMANCE-8",
  "CONFORMANCE-9",
  "CONFORMANCE-10",
  "CONFORMANCE-11",
  "CONFORMANCE-MISSING",
] as const;
const [
  STATION_1,
  STATION_2,
  STATION_3,
  STATION_4,
  STATION_5,
  STATION_6,
  STATION_7,
  STATION_8,
  STATION_9,
  STATION_10,
  STATION_11,
  MISSING,
] = CONFORMANCE_IDS;

/** Deletes what a crashed run may have left behind; a live caller runs it first. */
export async function clearConformanceStations(admin: CsmsChargePointAdmin): Promise<void> {
  for (const id of CONFORMANCE_IDS) await admin.delete(id);
}

/** Every rule the conformance check asks about. Typed, so a check cannot ask
 *  about a rule part 5 does not hold a flawed copy to. */
export const RULE = {
  declaredWhenImplemented:
    "capabilities.chargePoints is declared exactly when chargePoints is implemented",
  declaresAProfile: "a declared admin surface names at least one security profile",
  registrationsDeclaredShape: "declared registrations are non-empty and contain Accepted",
  getReturnsDeclaredRegistration: "get returns only a registration the driver declares",
  getMissingIsNull: "get of a missing id is null",
  createStores: "create stores the registration, security profile and description it is given",
  readBackKeepsId: "get returns the id the station was created with",
  createExistingThrows: "create of an existing id throws ChargePointAlreadyExistsError",
  createExistingChangesNothing: "create of an existing id leaves the station unchanged",
  updateAppliesRegistration: "update applies the registration it names",
  updateKeepsUnnamed: "update leaves the members it does not name unchanged",
  updateAppliesDescription: "update applies the description it names",
  nullDescriptionClears: "a description of null clears it",
  updateAppliesSecurity: "update applies the security it names",
  securityUpdateKeepsUnnamed: "a security update leaves the members it does not name unchanged",
  declaredSecurityUpdateResolves: "a security update to a declared profile resolves",
  updateMissingThrows: "update of a missing id throws ChargePointNotFoundError",
  updateMissingCreatesNothing: "update of a missing id creates nothing",
  deleteRemoves: "delete removes the station",
  deleteMissingResolves: "delete of a missing id resolves",
  defaultRegistration: "an omitted registration reads back Accepted",
  defaultSecurity: "omitted security reads back profile 0",
  omittedSecurityNeedsProfile0:
    "create with omitted security throws UnsupportedOperationError when profile 0 is not declared",
  refusedDefaultStoresNothing: "a create refused for its omitted security stores nothing",
  passwordWriteOnly:
    "no read returns a password-named member, and a write returns one only as generatedBasicAuthPassword",
  generatedPasswordReturned:
    "a driver declaring generated passwords returns a generatedBasicAuthPassword from every create and update that sets profile 1 or 2",
  noPasswordUnlessGenerated:
    "create and update return no generatedBasicAuthPassword unless the driver declares generated passwords and the write sets profile 1 or 2",
  passwordModeBinds:
    "create and update throw UnsupportedOperationError for a password supplied where passwords are generated, or omitted where they are supplied",
  refusedPasswordModeChangesNothing:
    "a create or update refused for its password mode changes nothing",
  requiredDescriptionOnCreate:
    "when the description is required, create without a non-blank one throws UnsupportedOperationError and stores nothing",
  requiredDescriptionKept:
    "when the description is required, update with a null or blank one throws UnsupportedOperationError and changes nothing",
  createRefusesUndeclared:
    "create with an undeclared security profile throws UnsupportedOperationError",
  refusedCreateStoresNothing: "a refused create stores nothing",
  updateRefusesUndeclared:
    "update to an undeclared security profile throws UnsupportedOperationError",
  refusedUpdateChangesNothing: "a refused update changes nothing",
  undeclaredRegistrationRefused:
    "create and update with an undeclared registration throw UnsupportedOperationError",
  refusedRegistrationChangesNothing:
    "a create or update refused for its registration changes nothing",
} as const;
export type Rule = (typeof RULE)[keyof typeof RULE];

/** What an absent `registrations` declaration means. */
export const ALL_REGISTRATIONS: readonly ChargePointRegistration[] = [
  "Accepted",
  "Pending",
  "Rejected",
];

export const ALL_PROFILES: readonly ChargePointSecurityProfile[] = [0, 1, 2, 3];

export function rejectsWith(
  action: () => Promise<unknown>,
  type: abstract new (...args: never[]) => Error,
): Promise<boolean> {
  return action().then(
    () => false,
    (error) => error instanceof type,
  );
}

/** The security block for `profile`: a supplied password on profile 1 and 2,
 *  or none when the CSMS `"generated"` them. */
export function securityFor(
  profile: ChargePointSecurityProfile,
  mode: "supplied" | "generated" = "supplied",
): ChargePointSecurity {
  if (profile === 1 || profile === 2) {
    return mode === "supplied" ? { profile, basicAuthPassword: "conformance-secret" } : { profile };
  }
  return { profile };
}

/** The whole observable record, keys sorted at every level, so two reads
 *  compare equal exactly when nothing a consumer can see differs. */
function observable(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member !== null && typeof member === "object" && !Array.isArray(member)
      ? Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b)))
      : member,
  );
}

/** Any member named like a password, at any depth, whatever its value -- a
 *  masked `"***"` is still the contract returning authentication material. */
function exposesPassword(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(([key, member]) => /password/i.test(key) || exposesPassword(member))
  );
}

/** Every rule of the suite, in the order a report lists them. */
export const CHARGE_POINT_RULES: readonly Rule[] = Object.values(RULE);

/**
 * Asks `driver` every charge-point administration rule its declaration makes
 * applicable. A rule that depends on something the driver does not declare --
 * a registration status, a security profile, the admin surface itself -- is
 * `skipped` with the reason, never `passed`.
 */
export async function chargePointAdminConformance(driver: CsmsDriver): Promise<ConformanceReport> {
  const recorder = createRecorder(CHARGE_POINT_RULES);
  const { expect } = recorder;

  const declared = driver.capabilities.chargePoints;
  const admin = driver.chargePoints;
  expect((declared === undefined) === (admin === undefined), RULE.declaredWhenImplemented);
  if (declared === undefined || admin === undefined) {
    return recorder.report(
      declared === undefined && admin === undefined
        ? "the driver declares no charge-point administration surface"
        : declared === undefined
          ? "the admin surface is implemented but not declared"
          : "the admin surface is declared but not implemented",
    );
  }
  expect(declared.securityProfiles.size > 0, RULE.declaresAProfile);
  // Absent means all three; present, it is never empty and holds the default.
  const registrations = declared.registrations ?? new Set(ALL_REGISTRATIONS);
  expect(registrations.size > 0 && registrations.has("Accepted"), RULE.registrationsDeclaredShape);

  // A driver that throws where the contract says it resolves is a violation
  // to report, not a crash of the guard.
  try {
    await exerciseLifecycle(admin, declared, registrations, recorder);
    return recorder.report("the suite did not reach this rule");
  } catch (error) {
    const detail = `the lifecycle threw unexpectedly: ${String(error)}`;
    recorder.abort(detail, detail);
    return recorder.report("the lifecycle threw before this rule was asked");
  }
}

/** Every rule `driver` breaks; empty when it conforms. A rule skipped as not applicable is not one. */
export async function chargePointAdminViolations(driver: CsmsDriver): Promise<string[]> {
  return (await chargePointAdminConformance(driver)).failed.map((failure) => failure.rule);
}

async function exerciseLifecycle(
  admin: CsmsChargePointAdmin,
  capabilities: CsmsChargePointCapabilities,
  registrations: ReadonlySet<ChargePointRegistration>,
  recorder: ConformanceRecorder<Rule>,
): Promise<void> {
  const { expect, skip } = recorder;
  const profiles = capabilities.securityProfiles;
  const mode = capabilities.basicAuthPassword ?? "supplied";
  const descriptionRequired = capabilities.description === "required";
  const secure = (profile: ChargePointSecurityProfile): ChargePointSecurity =>
    securityFor(profile, mode);
  // A required description is given everywhere a station is created, so that
  // a refusal can only be for the rule under test; an optional one is left out
  // where the default is what is read back.
  if (mode === "supplied") {
    skip(RULE.generatedPasswordReturned, 'passwords are declared "supplied": none is generated');
  }
  const optionalDescription = descriptionRequired ? { description: "required" } : {};
  const sets = (security: ChargePointSecurity | undefined): boolean =>
    security?.profile === 1 || security?.profile === 2;
  // Every write is also a check on what it hands back: a password only as
  // `generatedBasicAuthPassword`, and that exactly when the CSMS generated one.
  const judge = (result: void | ChargePointProvisioned, security?: ChargePointSecurity): void => {
    const { generatedBasicAuthPassword, ...rest } = result ?? {};
    expect(!exposesPassword(rest), RULE.passwordWriteOnly);
    if (mode === "generated" && sets(security)) {
      expect(
        typeof generatedBasicAuthPassword === "string" && generatedBasicAuthPassword !== "",
        RULE.generatedPasswordReturned,
      );
    } else {
      expect(generatedBasicAuthPassword === undefined, RULE.noPasswordUnlessGenerated);
    }
  };
  const create = async (definition: ChargePointDefinition): Promise<void> =>
    judge(await admin.create(definition), definition.security);
  const update = async (cpId: string, patch: ChargePointUpdate): Promise<void> =>
    judge(await admin.update(cpId, patch), patch.security);
  // Every read is also a check that no password escapes it.
  const read = async (cpId: string): Promise<ChargePointDetails | null> => {
    const details = await admin.get(cpId);
    expect(!exposesPassword(details), RULE.passwordWriteOnly);
    // `get` never returns a status the driver does not declare.
    expect(
      details === null || registrations.has(details.registration),
      RULE.getReturnsDeclaredRegistration,
    );
    return details;
  };
  // A station that must exist at this point; its absence is a violation
  // reported elsewhere, so it ends the lifecycle rather than cascading.
  const mustRead = async (cpId: string): Promise<ChargePointDetails> => {
    const details = await read(cpId);
    if (details === null) throw new Error(`station ${cpId} vanished`);
    return details;
  };
  const same = (a: unknown, b: unknown): boolean => observable(a) === observable(b);

  // Every member away from its default: a non-zero profile where one is
  // declared, a non-Accepted registration, a description.
  const declared = [...profiles];
  const profile = declared.find((candidate) => candidate !== 0) ?? declared[0];
  if (profile === undefined) {
    skip(CHARGE_POINT_RULES, "no security profile is declared");
    return;
  }
  const otherProfile = declared.find((candidate) => candidate !== profile);
  // The same for the registration: away from the default where one is
  // declared, and a second one to move to. A CSMS declaring only Accepted has
  // no other state, so the registration rules are exercised as far as they go
  // (a create and an update naming Accepted) and the moves between states are
  // skipped here, not failed.
  const registration =
    (["Rejected", "Pending"] as const).find((candidate) => registrations.has(candidate)) ??
    "Accepted";
  const otherRegistration = (["Pending", "Accepted", "Rejected"] as const).find(
    (candidate) => candidate !== registration && registrations.has(candidate),
  );

  // Part 2.
  const station: ChargePointDefinition = {
    id: STATION_1,
    registration,
    security: secure(profile),
    description: "first",
  };
  expect((await read(station.id)) === null, RULE.getMissingIsNull);
  await create(station);
  const created = await mustRead(station.id);
  expect(
    created.registration === registration &&
      created.security.profile === profile &&
      created.description === "first",
    RULE.createStores,
  );
  expect(created.id === station.id, RULE.readBackKeepsId);
  expect(
    await rejectsWith(
      () =>
        admin.create({
          id: station.id,
          registration: "Accepted",
          security: secure(otherProfile ?? profile),
          description: "second",
        }),
      ChargePointAlreadyExistsError,
    ),
    RULE.createExistingThrows,
  );
  expect(same(await read(station.id), created), RULE.createExistingChangesNothing);

  // Part 3: an update applies what it names and nothing else, each step
  // compared with the whole record before it.
  let before = await mustRead(station.id);
  const movedTo = otherRegistration ?? registration;
  await update(station.id, { registration: movedTo });
  let after = await mustRead(station.id);
  if (otherRegistration === undefined) {
    skip(
      RULE.updateAppliesRegistration,
      "registrations declares only Accepted: no state to move to",
    );
  } else {
    expect(after.registration === movedTo, RULE.updateAppliesRegistration);
  }
  expect(same(after, { ...before, registration: movedTo }), RULE.updateKeepsUnnamed);

  before = after;
  await update(station.id, { description: "second" });
  after = await mustRead(station.id);
  expect(after.description === "second", RULE.updateAppliesDescription);
  expect(same(after, { ...before, description: "second" }), RULE.updateKeepsUnnamed);

  // A security update the declaration allows resolves even when there is
  // only one profile to move to -- the one the station already has. The
  // password it replaces is not observable here; #155 owns that per driver.
  before = after;
  expect(
    await update(station.id, { security: secure(profile) }).then(
      () => true,
      () => false,
    ),
    RULE.declaredSecurityUpdateResolves,
  );
  after = await mustRead(station.id);
  expect(same(after, before), RULE.securityUpdateKeepsUnnamed);

  if (otherProfile !== undefined) {
    before = after;
    await update(station.id, { security: secure(otherProfile) });
    after = await mustRead(station.id);
    expect(after.security.profile === otherProfile, RULE.updateAppliesSecurity);
    expect(
      same(after, { ...before, security: { profile: otherProfile } }),
      RULE.securityUpdateKeepsUnnamed,
    );
  } else {
    skip(RULE.updateAppliesSecurity, "securityProfiles declares a single profile: none to move to");
  }

  if (descriptionRequired) {
    skip(RULE.nullDescriptionClears, "description is required: it cannot be cleared");
  } else {
    before = after;
    await update(station.id, { description: null });
    after = await mustRead(station.id);
    const { description: _cleared, ...withoutDescription } = before;
    expect(after.description === undefined, RULE.nullDescriptionClears);
    expect(same(after, withoutDescription), RULE.updateKeepsUnnamed);
  }

  expect(
    await rejectsWith(
      () => admin.update(MISSING, { registration: "Accepted" }),
      ChargePointNotFoundError,
    ),
    RULE.updateMissingThrows,
  );
  expect((await read(MISSING)) === null, RULE.updateMissingCreatesNothing);

  await admin.delete(station.id);
  expect((await read(station.id)) === null, RULE.deleteRemoves);
  expect(
    await admin.delete(station.id).then(
      () => true,
      () => false,
    ),
    RULE.deleteMissingResolves,
  );

  // Part 3, defaults. The registration default does not depend on profile 0.
  await create({ id: STATION_2, security: secure(profile), ...optionalDescription });
  expect((await read(STATION_2))?.registration === "Accepted", RULE.defaultRegistration);
  await admin.delete(STATION_2);
  // The security default IS profile 0, so it is only as available as 0 is.
  if (profiles.has(0)) {
    skip(
      RULE.omittedSecurityNeedsProfile0,
      "profile 0 is declared, so omitted security is accepted",
    );
    await create({ id: STATION_3, ...optionalDescription });
    expect((await read(STATION_3))?.security.profile === 0, RULE.defaultSecurity);
  } else {
    skip(
      RULE.defaultSecurity,
      "profile 0 is not declared, so there is no default security to read",
    );
    expect(
      await rejectsWith(
        () => admin.create({ id: STATION_3, ...optionalDescription }),
        UnsupportedOperationError,
      ),
      RULE.omittedSecurityNeedsProfile0,
    );
    expect((await read(STATION_3)) === null, RULE.refusedDefaultStoresNothing);
  }
  await admin.delete(STATION_3);

  // Part 4: an undeclared profile is refused, and the refusal changes
  // nothing -- including the members the refused patch named beside it.
  const undeclared = ALL_PROFILES.find((candidate) => !profiles.has(candidate));
  if (undeclared !== undefined) {
    expect(
      await rejectsWith(
        () =>
          admin.create({
            id: STATION_4,
            security: secure(undeclared),
            ...optionalDescription,
          }),
        UnsupportedOperationError,
      ),
      RULE.createRefusesUndeclared,
    );
    expect((await read(STATION_4)) === null, RULE.refusedCreateStoresNothing);
    await admin.delete(STATION_4);

    await create({
      id: STATION_5,
      registration,
      security: secure(profile),
      description: "kept",
    });
    before = await mustRead(STATION_5);
    expect(
      await rejectsWith(
        () =>
          admin.update(STATION_5, {
            registration: otherRegistration ?? registration,
            description: "changed",
            security: secure(undeclared),
          }),
        UnsupportedOperationError,
      ),
      RULE.updateRefusesUndeclared,
    );
    expect(same(await read(STATION_5), before), RULE.refusedUpdateChangesNothing);
    await admin.delete(STATION_5);
  } else {
    skip(
      [
        RULE.createRefusesUndeclared,
        RULE.refusedCreateStoresNothing,
        RULE.updateRefusesUndeclared,
        RULE.refusedUpdateChangesNothing,
      ],
      "securityProfiles declares all four profiles: none is undeclared",
    );
  }

  // Part 5: an undeclared registration is refused like an undeclared profile,
  // and the refusal changes nothing -- including the members the refused patch
  // named beside it. Skipped, not failed, when all three are declared.
  const undeclaredRegistration = ALL_REGISTRATIONS.find(
    (candidate) => !registrations.has(candidate),
  );
  if (undeclaredRegistration !== undefined) {
    expect(
      await rejectsWith(
        () =>
          admin.create({
            id: STATION_6,
            registration: undeclaredRegistration,
            security: secure(profile),
            ...optionalDescription,
          }),
        UnsupportedOperationError,
      ),
      RULE.undeclaredRegistrationRefused,
    );
    expect((await read(STATION_6)) === null, RULE.refusedRegistrationChangesNothing);
    await admin.delete(STATION_6);

    await create({
      id: STATION_7,
      registration,
      security: secure(profile),
      description: "kept",
    });
    before = await mustRead(STATION_7);
    expect(
      await rejectsWith(
        () =>
          admin.update(STATION_7, {
            registration: undeclaredRegistration,
            description: "changed",
            security: secure(otherProfile ?? profile),
          }),
        UnsupportedOperationError,
      ),
      RULE.undeclaredRegistrationRefused,
    );
    expect(same(await read(STATION_7), before), RULE.refusedRegistrationChangesNothing);
    await admin.delete(STATION_7);
  } else {
    skip(
      [RULE.undeclaredRegistrationRefused, RULE.refusedRegistrationChangesNothing],
      "registrations declares all three statuses: none is undeclared",
    );
  }

  // Part 6: who chooses the Basic Auth password. A password supplied where the
  // CSMS generates them, or left out where the caller must send it, is refused
  // like an undeclared profile, and the refusal changes nothing.
  const passworded = declared.find((candidate) => candidate === 1 || candidate === 2);
  if (passworded === undefined) {
    skip(
      [RULE.passwordModeBinds, RULE.refusedPasswordModeChangesNothing],
      "no security profile with a Basic Auth password is declared",
    );
    if (mode === "generated") {
      skip(
        RULE.generatedPasswordReturned,
        "no security profile with a Basic Auth password is declared",
      );
    }
  } else {
    const wrongMode: ChargePointSecurity =
      mode === "generated"
        ? { profile: passworded, basicAuthPassword: "conformance-secret" }
        : { profile: passworded };
    expect(
      await rejectsWith(
        () => admin.create({ id: STATION_8, security: wrongMode, ...optionalDescription }),
        UnsupportedOperationError,
      ),
      RULE.passwordModeBinds,
    );
    expect((await read(STATION_8)) === null, RULE.refusedPasswordModeChangesNothing);
    await admin.delete(STATION_8);

    await create({
      id: STATION_9,
      registration,
      security: secure(passworded),
      description: "kept",
    });
    before = await mustRead(STATION_9);
    expect(
      await rejectsWith(
        () =>
          admin.update(STATION_9, {
            registration: otherRegistration ?? registration,
            description: "changed",
            security: wrongMode,
          }),
        UnsupportedOperationError,
      ),
      RULE.passwordModeBinds,
    );
    expect(same(await read(STATION_9), before), RULE.refusedPasswordModeChangesNothing);
    await admin.delete(STATION_9);
  }

  // Part 7: a required description. Create needs a non-blank one and update
  // neither clears nor blanks it; each refusal changes nothing.
  if (!descriptionRequired) {
    skip(
      [RULE.requiredDescriptionOnCreate, RULE.requiredDescriptionKept],
      'description is declared "optional" (or not at all): it may be omitted and cleared',
    );
  } else {
    let refusedEveryCreate = true;
    for (const description of [undefined, "", "   "]) {
      refusedEveryCreate &&= await rejectsWith(
        () =>
          admin.create({
            id: STATION_10,
            security: secure(profile),
            ...(description === undefined ? {} : { description }),
          }),
        UnsupportedOperationError,
      );
    }
    expect(refusedEveryCreate, RULE.requiredDescriptionOnCreate);
    expect((await read(STATION_10)) === null, RULE.requiredDescriptionOnCreate);
    await admin.delete(STATION_10);

    await create({ id: STATION_11, security: secure(profile), description: "kept" });
    before = await mustRead(STATION_11);
    for (const description of [null, "", "   "]) {
      expect(
        await rejectsWith(
          () => admin.update(STATION_11, { description }),
          UnsupportedOperationError,
        ),
        RULE.requiredDescriptionKept,
      );
      expect(same(await read(STATION_11), before), RULE.requiredDescriptionKept);
    }
    await admin.delete(STATION_11);
  }
}

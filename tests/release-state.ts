// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Release state: a re-run of the Release workflow must resume a partial
 * release, and must never mistake an error, or another commit's artifact, for
 * "already done" or "nothing there yet".
 *
 * 1. Registry (`npm view <pkg>@X.Y.Z version gitHead --json`): published from
 *    this commit is "published"; E404 is "missing"; published from another
 *    commit, or without a gitHead to tell, is refused; any other failure
 *    (E401, E403, network, unreadable output) is refused, never "missing".
 * 2. Tag (`gh api repos/<repo>/commits/vX.Y.Z`): on this commit is
 *    "on-commit"; GitHub's 422 "No commit found" is "free"; on another commit
 *    is refused; any other failure (404 repository, 401, network) is refused.
 * 3. Release (`gh api repos/<repo>/releases/tags/vX.Y.Z`): a release of that
 *    tag is "exists"; 404 Not Found is "missing" (the repository was already
 *    proven reachable by the tag lookup); a release of another tag, any other
 *    failure (401, 403, 5xx, network) or unreadable output is refused.
 */

import { registryState, releaseState, tagState } from "../scripts/release.ts";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function refuses(run: () => unknown, pattern: RegExp, message: string): void {
  try {
    run();
    failures.push(`${message}: no error`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    check(pattern.test(text), `${message}: unexpected error "${text}"`);
  }
}

const SHA = "ea753089bcaee380619e8d5c701720a4fdf153dc";
const OTHER = "2f263177ca4958bf0860acfd311230208ac7b1ac";
const npmError = (code: string) =>
  JSON.stringify({ error: { code, summary: `${code} summary`, detail: "detail" } });

// 1. Registry.
check(
  registryState(
    { exitCode: 0, stdout: JSON.stringify({ version: "0.1.0", gitHead: SHA }) },
    SHA,
  ) === "published",
  "a version published from this commit is published",
);
check(
  registryState({ exitCode: 1, stdout: npmError("E404") }, SHA) === "missing",
  "E404 is missing",
);
refuses(
  () =>
    registryState(
      { exitCode: 0, stdout: JSON.stringify({ version: "0.1.0", gitHead: OTHER }) },
      SHA,
    ),
  new RegExp(`published from ${OTHER}`),
  "a version published from another commit is refused",
);
refuses(
  () => registryState({ exitCode: 0, stdout: JSON.stringify("0.1.0") }, SHA),
  /no gitHead/,
  "a published version without gitHead is refused",
);
for (const code of ["E401", "E403", "E500", "ECONNRESET", "ENOTFOUND"]) {
  refuses(
    () => registryState({ exitCode: 1, stdout: npmError(code) }, SHA),
    new RegExp(code),
    `${code} is refused, not read as missing`,
  );
}
refuses(
  () => registryState({ exitCode: 1, stdout: "" }, SHA),
  /npm view failed/,
  "a failure without a readable error is refused",
);
refuses(
  () => registryState({ exitCode: 0, stdout: "<html>proxy</html>" }, SHA),
  /npm view/,
  "unreadable output is refused",
);

// 2. Tag.
check(
  tagState({ exitCode: 0, stdout: JSON.stringify({ sha: SHA }) }, SHA) === "on-commit",
  "a tag on this commit is on-commit",
);
check(
  tagState(
    {
      exitCode: 1,
      stdout: JSON.stringify({ message: "No commit found for SHA: v9.9.9", status: "422" }),
    },
    SHA,
  ) === "free",
  "GitHub's 422 No commit found is free",
);
refuses(
  () => tagState({ exitCode: 0, stdout: JSON.stringify({ sha: OTHER }) }, SHA),
  new RegExp(`points to ${OTHER}`),
  "a tag on another commit is refused",
);
for (const [status, message] of [
  ["404", "Not Found"],
  ["401", "Bad credentials"],
  ["422", "Validation Failed"],
]) {
  refuses(
    () => tagState({ exitCode: 1, stdout: JSON.stringify({ message, status }) }, SHA),
    new RegExp(status!),
    `HTTP ${status} ${message} is refused, not read as free`,
  );
}
refuses(
  () => tagState({ exitCode: 1, stdout: "" }, SHA),
  /tag lookup failed/,
  "a failure without a readable body (network) is refused",
);

// 3. Release.
check(
  releaseState({ exitCode: 0, stdout: JSON.stringify({ tag_name: "v0.1.0" }) }, "v0.1.0") ===
    "exists",
  "a release of the tag exists",
);
check(
  releaseState(
    { exitCode: 1, stdout: JSON.stringify({ message: "Not Found", status: "404" }) },
    "v0.1.0",
  ) === "missing",
  "404 Not Found is missing",
);
refuses(
  () => releaseState({ exitCode: 0, stdout: JSON.stringify({ tag_name: "v0.0.9" }) }, "v0.1.0"),
  /v0\.0\.9/,
  "a release of another tag is refused",
);
for (const [status, message] of [
  ["401", "Bad credentials"],
  ["403", "Resource not accessible by integration"],
  ["502", "Bad Gateway"],
]) {
  refuses(
    () => releaseState({ exitCode: 1, stdout: JSON.stringify({ message, status }) }, "v0.1.0"),
    new RegExp(status!),
    `HTTP ${status} ${message} is refused, not read as missing`,
  );
}
refuses(
  () => releaseState({ exitCode: 1, stdout: "" }, "v0.1.0"),
  /release lookup failed/,
  "a failure without a readable body (network) is refused",
);
refuses(
  () => releaseState({ exitCode: 0, stdout: "<html>proxy</html>" }, "v0.1.0"),
  /unreadable/,
  "unreadable output is refused",
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    "Release state: registry, tag and release lookups tell missing from failed and foreign.",
  );
}

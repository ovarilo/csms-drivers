// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Release changelog: CHANGELOG.md follows Keep a Changelog 1.1.0, and a release
 * is cut from it, never from commit messages.
 *
 * 1. Preparing X.Y.Z turns `## [Unreleased]` into `## [X.Y.Z] - <date>` under a
 *    fresh, empty `## [Unreleased]`, and rewrites the link references: the
 *    unreleased link compares from vX.Y.Z, and X.Y.Z links to its own diff (or
 *    to its tag when it is the first release).
 * 2. Preparing refuses an empty Unreleased section, a version that already has
 *    a section, a malformed version and a version lower than package.json's.
 * 3. The release notes are exactly the body of the dated X.Y.Z section; a
 *    missing, undated or empty section is refused rather than released empty.
 */

import { assertReleasable, prepareChangelog, releaseNotes } from "../scripts/release.ts";

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

const REPO = "https://github.com/ovarilo/csms-drivers";

const HEADER = `# Changelog

All notable changes to this project will be documented in this file.
`;

const FIRST = `${HEADER}
## [Unreleased]

### Added

- First feature.

[unreleased]: ${REPO}/commits/main
`;

const SECOND = `${HEADER}
## [Unreleased]

### Fixed

- A bug.

## [0.1.0] - 2026-10-19

### Added

- First feature.

[unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`;

// 1. Promotion and links.
{
  const out = prepareChangelog(FIRST, "0.1.0", "2026-10-19", REPO);
  check(
    out ===
      `${HEADER}
## [Unreleased]

## [0.1.0] - 2026-10-19

### Added

- First feature.

[unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`,
    `first release is promoted and linked to its tag, got:\n${out}`,
  );
}
{
  const out = prepareChangelog(SECOND, "0.2.0", "2026-11-02", REPO);
  check(
    out.includes(
      "## [Unreleased]\n\n## [0.2.0] - 2026-11-02\n\n### Fixed\n\n- A bug.\n\n## [0.1.0]",
    ),
    `second release is promoted above the first, got:\n${out}`,
  );
  check(
    out.endsWith(
      `[unreleased]: ${REPO}/compare/v0.2.0...HEAD
[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`,
    ),
    `second release compares against the previous tag, got:\n${out}`,
  );
}

// 2. Refusals.
refuses(
  () =>
    prepareChangelog(
      `${HEADER}\n## [Unreleased]\n\n## [0.1.0] - 2026-10-19\n\n- x\n`,
      "0.2.0",
      "2026-11-02",
      REPO,
    ),
  /Unreleased.*empty/,
  "an empty Unreleased section is refused",
);
refuses(
  () => prepareChangelog(SECOND, "0.1.0", "2026-11-02", REPO),
  /already/,
  "an existing version is refused",
);
refuses(
  () => prepareChangelog(`${HEADER}\n- no section\n`, "0.1.0", "2026-11-02", REPO),
  /Unreleased/,
  "a changelog without Unreleased is refused",
);
refuses(
  () => assertReleasable("0.2", "0.1.0"),
  /not a release version/,
  "a malformed version is refused",
);
refuses(
  () => assertReleasable("0.2.0+build", "0.1.0"),
  /not a release version/,
  "build metadata is refused",
);
refuses(
  () => assertReleasable("0.0.9", "0.1.0"),
  /lower/,
  "a version lower than package.json is refused",
);
assertReleasable("0.1.0", "0.1.0");
assertReleasable("0.2.0-rc.1", "0.1.0");
assertReleasable("1.0.0", "0.10.0");
refuses(
  () => assertReleasable("0.9.0", "0.10.0"),
  /lower/,
  "versions compare numerically, not as strings",
);

// 3. Release notes.
check(
  releaseNotes(SECOND, "0.1.0") === "### Added\n\n- First feature.",
  `notes are the section body, got: ${JSON.stringify(releaseNotes(SECOND, "0.1.0"))}`,
);
refuses(
  () => releaseNotes(SECOND, "0.2.0"),
  /no dated section/,
  "notes of a missing version are refused",
);
refuses(
  () => releaseNotes(`${HEADER}\n## [0.3.0]\n\n- x\n`, "0.3.0"),
  /no dated section/,
  "notes of an undated section are refused",
);
refuses(
  () =>
    releaseNotes(`${HEADER}\n## [0.3.0] - 2026-11-02\n\n## [0.2.0] - 2026-11-01\n\n- x\n`, "0.3.0"),
  /empty/,
  "notes of an empty section are refused",
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Release changelog: promotion, links, refusals and notes hold.");
}

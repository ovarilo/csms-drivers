// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Release helper over CHANGELOG.md (Keep a Changelog 1.1.0).
 *
 *   bun scripts/release.ts prepare X.Y.Z   dates the Unreleased section and bumps package.json
 *   bun scripts/release.ts notes X.Y.Z     prints the X.Y.Z section, the GitHub Release body,
 *                                          refused unless package.json is X.Y.Z
 *
 * `prepare` builds the release pull request; the dispatched Release workflow then checks that
 * package.json and the changelog agree, publishes, tags and calls `notes`.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNRELEASED_HEADING = /^## \[Unreleased\][^\n]*$/m;
const UNRELEASED_LINK = /^\[unreleased\]: (.+)$/im;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertVersion(version: string): void {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`${version} is not a release version (X.Y.Z or X.Y.Z-prerelease)`);
  }
}

/** Refuses a malformed version and one lower than package.json's (equal is the first release). */
export function assertReleasable(version: string, current: string): void {
  assertVersion(version);
  if (Bun.semver.order(version, current) < 0) {
    throw new Error(`${version} is lower than package.json version ${current}`);
  }
}

/** The body between a heading and the next `## ` heading or the link references. */
function sectionBody(changelog: string, headingEnd: number): string {
  const rest = changelog.slice(headingEnd);
  const end = rest.search(/^## |^\[[^\]]+\]: /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** Dates the Unreleased section as `version` and rewrites the link references. */
export function prepareChangelog(
  changelog: string,
  version: string,
  date: string,
  repoUrl: string,
): string {
  assertVersion(version);
  if (new RegExp(`^## \\[${escape(version)}\\]`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const heading = UNRELEASED_HEADING.exec(changelog);
  if (!heading) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const headingEnd = heading.index + heading[0].length;
  if (sectionBody(changelog, headingEnd) === "") {
    throw new Error("the Unreleased section of CHANGELOG.md is empty: nothing to release");
  }

  const link = UNRELEASED_LINK.exec(changelog);
  if (!link) throw new Error("CHANGELOG.md has no [unreleased]: link reference");

  // Before the first release, the unreleased link points at the commits, not at a compare.
  const previous = /\/compare\/(v.+?)\.\.\.HEAD$/.exec(link[1]!.trim())?.[1];
  const versionLink = previous
    ? `[${version}]: ${repoUrl}/compare/${previous}...v${version}`
    : `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  const unreleasedLink = `[unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  return `${changelog.slice(0, headingEnd)}\n\n## [${version}] - ${date}${changelog.slice(headingEnd)}`.replace(
    UNRELEASED_LINK,
    `${unreleasedLink}\n${versionLink}`,
  );
}

/** The body of the dated `version` section, refused when missing, undated or empty. */
export function releaseNotes(changelog: string, version: string): string {
  const heading = new RegExp(`^## \\[${escape(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").exec(
    changelog,
  );
  if (!heading)
    throw new Error(
      `CHANGELOG.md has no dated section for ${version} (## [${version}] - YYYY-MM-DD)`,
    );
  const body = sectionBody(changelog, heading.index + heading[0].length);
  if (body === "") throw new Error(`the ${version} section of CHANGELOG.md is empty`);
  return body;
}

function repoUrl(pkg: { repository?: { url?: string } }): string {
  const url = pkg.repository?.url;
  if (!url) throw new Error("package.json has no repository.url");
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

if (import.meta.main) {
  const [command, version] = process.argv.slice(2);
  try {
    if (!version || (command !== "prepare" && command !== "notes")) {
      throw new Error("usage: bun scripts/release.ts <prepare|notes> X.Y.Z");
    }
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    const raw = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(raw) as { version: string; repository?: { url?: string } };
    if (command === "notes") {
      // The release job publishes package.json as is: the notes must describe that version.
      if (pkg.version !== version) {
        throw new Error(
          `package.json is ${pkg.version}, not ${version}: merge the release pull request first`,
        );
      }
      console.log(releaseNotes(changelog, version));
    } else {
      assertReleasable(version, pkg.version);
      const date = new Date().toISOString().slice(0, 10);
      writeFileSync("CHANGELOG.md", prepareChangelog(changelog, version, date, repoUrl(pkg)));
      writeFileSync("package.json", raw.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`));
      console.log(
        `Prepared ${version}: commit as "chore(release): ${version}" and open a pull request.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

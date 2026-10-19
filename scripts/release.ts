// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Release helper over CHANGELOG.md (Keep a Changelog 1.1.0).
 *
 *   bun scripts/release.ts prepare X.Y.Z   dates the Unreleased section and bumps package.json
 *   bun scripts/release.ts notes X.Y.Z     prints the X.Y.Z section, the GitHub Release body
 *
 * `prepare` builds the release pull request; the dispatched Release workflow then checks that
 * package.json and the changelog agree, publishes, tags and calls `notes`.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const UNRELEASED_HEADING = /^## \[Unreleased\][^\n]*$/m;
const UNRELEASED_LINK = /^\[unreleased\]: (.+)$/im;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parse(version: string): RegExpMatchArray {
  const match = RELEASE_VERSION.exec(version);
  if (!match) throw new Error(`${version} is not a release version (X.Y.Z or X.Y.Z-prerelease)`);
  return match;
}

/** Refuses a malformed version and one lower than package.json's (equal is the first release). */
export function assertReleasable(version: string, current: string): void {
  const next = parse(version);
  const now = parse(current);
  for (let i = 1; i <= 3; i++) {
    const delta = Number(next[i]) - Number(now[i]);
    if (delta > 0) return;
    if (delta < 0) throw new Error(`${version} is lower than package.json version ${current}`);
  }
  if (next[4] === undefined && now[4] !== undefined) return;
  if (next[4] !== undefined && now[4] === undefined) {
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
  parse(version);
  if (new RegExp(`^## \\[${escape(version)}\\]`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const heading = UNRELEASED_HEADING.exec(changelog);
  if (!heading) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const headingEnd = heading.index + heading[0].length;
  if (sectionBody(changelog, headingEnd) === "") {
    throw new Error("the Unreleased section of CHANGELOG.md is empty: nothing to release");
  }

  let out = `${changelog.slice(0, headingEnd)}\n\n## [${version}] - ${date}${changelog.slice(headingEnd)}`;

  const previous = /\/compare\/(v[^/]+?)\.\.\.HEAD$/.exec(
    UNRELEASED_LINK.exec(out)?.[1]?.trim() ?? "",
  )?.[1];
  const versionLink = previous
    ? `[${version}]: ${repoUrl}/compare/${previous}...v${version}`
    : `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  const unreleasedLink = `[unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  out = UNRELEASED_LINK.test(out)
    ? out.replace(UNRELEASED_LINK, `${unreleasedLink}\n${versionLink}`)
    : `${out.trimEnd()}\n\n${unreleasedLink}\n${versionLink}\n`;
  return out;
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
    if (command === "notes") {
      console.log(releaseNotes(changelog, version));
    } else {
      const raw = readFileSync("package.json", "utf8");
      const pkg = JSON.parse(raw) as { version: string; repository?: { url?: string } };
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

// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Release helper over CHANGELOG.md (Keep a Changelog 1.1.0).
 *
 *   bun scripts/release.ts prepare X.Y.Z   dates the Unreleased section and bumps package.json
 *   bun scripts/release.ts notes X.Y.Z     prints the X.Y.Z section, the GitHub Release body,
 *                                          refused unless package.json is X.Y.Z
 *   bun scripts/release.ts registry-state X.Y.Z SHA   prints published | missing
 *   bun scripts/release.ts tag-state X.Y.Z SHA        prints on-commit | free
 *
 * `prepare` builds the release pull request; the dispatched Release workflow then checks that
 * package.json and the changelog agree, publishes, tags and calls `notes`. The two state
 * commands let a re-run resume a partial release: anything they cannot classify for certain,
 * or that belongs to another commit, fails the run instead of being skipped or overwritten.
 */

import { readFileSync, writeFileSync } from "node:fs";

import semver from "semver";

const UNRELEASED_HEADING = /^## \[Unreleased\][^\n]*$/m;
const UNRELEASED_LINK = /^\[unreleased\]: (.+)$/im;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strict SemVer 2.0.0, as written (no `v`, no padding), and no build metadata: npm drops it. */
function assertVersion(version: string): void {
  if (semver.valid(version) !== version || version.includes("+")) {
    throw new Error(`${version} is not a release version (X.Y.Z or X.Y.Z-prerelease)`);
  }
}

/** Refuses a malformed version and one lower than package.json's (equal is the first release). */
export function assertReleasable(version: string, current: string): void {
  assertVersion(version);
  if (semver.lt(version, current)) {
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

/** What a command printed and how it exited. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Reads `npm view <pkg>@X.Y.Z version gitHead --json`. Only E404 means "not published": npm also
 * answers E404 for a package the token cannot see, but the publishing token has packages:write
 * on it, and a wrong guess there makes `npm publish` fail rather than pass silently.
 */
export function registryState(view: CommandResult, sha: string): "published" | "missing" {
  const output = parseJson(view.stdout);
  if (view.exitCode !== 0) {
    const code = field(field(output, "error"), "code");
    if (code === "E404") return "missing";
    const summary = field(field(output, "error"), "summary");
    throw new Error(
      typeof code === "string"
        ? `npm view failed with ${code}: ${String(summary)}`
        : `npm view failed (exit ${view.exitCode}) without a readable error`,
    );
  }
  if (output === undefined) throw new Error(`npm view printed unreadable output: ${view.stdout}`);
  const gitHead = field(output, "gitHead");
  if (typeof gitHead !== "string") {
    throw new Error("the published version has no gitHead: cannot tell which commit it came from");
  }
  if (gitHead !== sha)
    throw new Error(`the version is already published from ${gitHead}, not ${sha}`);
  return "published";
}

/**
 * Reads `gh api repos/<repo>/commits/vX.Y.Z` (the tag, peeled to its commit). Only GitHub's 422
 * "No commit found" means the tag does not exist; any other failure is not a free tag.
 */
export function tagState(lookup: CommandResult, sha: string): "on-commit" | "free" {
  const output = parseJson(lookup.stdout);
  if (lookup.exitCode !== 0) {
    const status = field(output, "status");
    const message = field(output, "message");
    if (status === "422" && typeof message === "string" && message.startsWith("No commit found")) {
      return "free";
    }
    throw new Error(
      typeof status === "string"
        ? `tag lookup failed with HTTP ${status}: ${String(message)}`
        : `tag lookup failed (exit ${lookup.exitCode}) without a readable error`,
    );
  }
  const tagged = field(output, "sha");
  if (typeof tagged !== "string")
    throw new Error(`tag lookup printed unreadable output: ${lookup.stdout}`);
  if (tagged !== sha) throw new Error(`the tag already points to ${tagged}, not ${sha}`);
  return "on-commit";
}

function run(argv: string[]): CommandResult {
  const result = Bun.spawnSync(argv, { stderr: "inherit" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function repoUrl(pkg: { repository?: { url?: string } }): string {
  const url = pkg.repository?.url;
  if (!url) throw new Error("package.json has no repository.url");
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

if (import.meta.main) {
  const [command, version, sha] = process.argv.slice(2);
  try {
    const stateCommand = command === "registry-state" || command === "tag-state";
    if (!version || (stateCommand ? !sha : command !== "prepare" && command !== "notes")) {
      throw new Error(
        "usage: bun scripts/release.ts <prepare|notes> X.Y.Z\n" +
          "       bun scripts/release.ts <registry-state|tag-state> X.Y.Z SHA",
      );
    }
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    const raw = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(raw) as {
      name: string;
      version: string;
      repository?: { url?: string };
      publishConfig?: { registry?: string };
    };
    if (command === "registry-state") {
      const registry = pkg.publishConfig?.registry;
      if (!registry) throw new Error("package.json has no publishConfig.registry");
      const view = run([
        "npm",
        "view",
        `${pkg.name}@${version}`,
        "version",
        "gitHead",
        "--json",
        "--registry",
        registry,
      ]);
      console.log(registryState(view, sha!));
    } else if (command === "tag-state") {
      const repo = new URL(repoUrl(pkg)).pathname.slice(1);
      console.log(tagState(run(["gh", "api", `repos/${repo}/commits/v${version}`]), sha!));
    } else if (command === "notes") {
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

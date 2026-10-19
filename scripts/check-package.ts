// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The packed tarball must carry every target of package.json#exports, and nothing of the
 * development tree: `files` is the allowlist, this is its guard.
 *
 *   bun scripts/check-package.ts   packs with `npm pack --dry-run` and checks the listing
 */

import { readFileSync } from "node:fs";

const DEVELOPMENT = /^(tests|scripts|examples|\.github|\.vite-hooks|node_modules)\//;

/** Every target of an exports value, keyed by the export that declares it. */
function targets(value: unknown, key: string): [string, string][] {
  if (typeof value === "string") return [[key, value]];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, nested]) =>
    targets(nested, name.startsWith(".") ? name : key),
  );
}

/** What is wrong with a packed file list for this package.json; empty when nothing is. */
export function packageProblems(pkg: { exports?: unknown }, packed: readonly string[]): string[] {
  const files = new Set(packed);
  const problems: string[] = [];
  for (const [entry, target] of targets(pkg.exports, ".")) {
    if (target.includes("*")) {
      problems.push(`export "${entry}" is a pattern (${target}): this check cannot verify it`);
    } else if (!files.has(target.replace(/^\.\//, ""))) {
      problems.push(`export "${entry}" points at ${target}, which is not packed`);
    }
  }
  for (const file of packed) {
    if (DEVELOPMENT.test(file)) problems.push(`development file packed: ${file}`);
  }
  return problems;
}

if (import.meta.main) {
  const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
    stderr: "inherit",
  });
  if (pack.exitCode !== 0) {
    console.error(`FAIL: npm pack exited with ${pack.exitCode}`);
    process.exit(1);
  }
  const [listing] = JSON.parse(pack.stdout.toString()) as [{ files: { path: string }[] }];
  const packed = listing.files.map((file) => file.path);
  const problems =
    packed.length === 0
      ? ["npm pack listed no file"]
      : packageProblems(JSON.parse(readFileSync("package.json", "utf8")), packed);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Package: ${packed.length} files, every export target packed, no development file.`,
    );
  }
}

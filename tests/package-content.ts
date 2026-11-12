// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Package content: the packed tarball is what consumers of GitHub Packages
 * install, so it must hold what package.json promises and nothing more.
 *
 * 1. Every target of `exports`, at any depth of conditions, is in the tarball;
 *    a missing one is reported by its path and the export that points at it.
 * 2. Development files (tests, scripts, examples, CI, hooks) are reported.
 * 3. An export pattern (`*`) is refused rather than silently left unchecked.
 * 4. A conditional export names ONE module three ways: `bun` the source
 *    `./src/<m>.ts`, `types` its `./dist/<m>.d.ts`, `default` its
 *    `./dist/<m>.js`. A subpath whose conditions disagree, or lack one, would
 *    hand Bun, TypeScript and Node three different modules, and every one of
 *    them is packed, so (1) cannot see it.
 */

import { packageProblems } from "../scripts/check-package.ts";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const exportsMap = {
  ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
  "./server": {
    bun: "./src/server/index.ts",
    types: "./dist/server/index.d.ts",
    default: "./dist/server/index.js",
  },
  "./tsconfig": "./tsconfig.base.json",
  "./package.json": "./package.json",
};
const complete = [
  "package.json",
  "LICENSE",
  "README.md",
  "tsconfig.base.json",
  "src/index.ts",
  "src/server/index.ts",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/server/index.d.ts",
  "dist/server/index.js",
];

// 1. Export targets.
{
  const problems = packageProblems({ exports: exportsMap }, complete);
  check(problems.length === 0, `a complete package has no problem, got: ${problems.join("; ")}`);
}
{
  const problems = packageProblems(
    { exports: exportsMap },
    complete.filter((file) => file !== "dist/server/index.js"),
  );
  check(
    problems.length === 1 &&
      problems[0]!.includes("dist/server/index.js") &&
      problems[0]!.includes('"./server"'),
    `a missing nested export target is reported with its export, got: ${problems.join("; ")}`,
  );
}
{
  const problems = packageProblems(
    { exports: exportsMap },
    complete.filter((file) => file !== "tsconfig.base.json"),
  );
  check(
    problems.length === 1 && problems[0]!.includes("tsconfig.base.json"),
    `a missing string export target is reported, got: ${problems.join("; ")}`,
  );
}
{
  const problems = packageProblems({ exports: "./src/index.ts" }, ["package.json"]);
  check(
    problems.length === 1 && problems[0]!.includes("src/index.ts"),
    `a bare string exports is checked, got: ${problems.join("; ")}`,
  );
}

// 2. Development files.
{
  const problems = packageProblems({ exports: exportsMap }, [
    ...complete,
    "tests/csms-server.ts",
    "scripts/release.ts",
    ".github/workflows/ci.yml",
  ]);
  check(
    problems.length === 3 && problems.every((problem) => problem.startsWith("development file")),
    `development files are reported, got: ${problems.join("; ")}`,
  );
}

// 3. Patterns.
{
  const problems = packageProblems({ exports: { "./*": "./src/*.ts" } }, complete);
  check(
    problems.length === 1 && problems[0]!.includes("pattern"),
    `an export pattern is refused, got: ${problems.join("; ")}`,
  );
}

// 4. One module per conditional export.
{
  const problems = packageProblems(
    {
      exports: {
        ...exportsMap,
        "./steve/forms": {
          bun: "./src/steve/forms.ts",
          types: "./dist/steve/forms.d.ts",
          default: "./dist/steve/html-form.js",
        },
      },
    },
    [...complete, "src/steve/forms.ts", "dist/steve/forms.d.ts", "dist/steve/html-form.js"],
  );
  check(
    problems.length === 1 &&
      problems[0]!.includes('"./steve/forms"') &&
      problems[0]!.includes("dist/steve/html-form.js"),
    `a conditional export naming two modules is reported, got: ${problems.join("; ")}`,
  );
}
{
  const problems = packageProblems(
    {
      exports: {
        ...exportsMap,
        "./citrineos/http": { bun: "./src/citrineos/http.ts", default: "./dist/citrineos/http.js" },
      },
    },
    [...complete, "src/citrineos/http.ts", "dist/citrineos/http.js"],
  );
  check(
    problems.length === 1 &&
      problems[0]!.includes('"./citrineos/http"') &&
      problems[0]!.includes("types"),
    `a conditional export missing a condition is reported, got: ${problems.join("; ")}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Package content: every export target is packed, no development file is.");
}

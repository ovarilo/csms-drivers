// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

// Vite+ drives lint (Oxlint) and format (Oxfmt) only: tests stay plain Bun scripts and nothing is
// bundled. tsc is the only type-check, since it also emits types/.
export default defineConfig({
  fmt: {
    // types/ is tsc output, diffed byte for byte by scripts/types-current.sh: never reformat it.
    // Markdown is left to editors: the macOS and Linux oxfmt binaries disagree on the final newline.
    ignorePatterns: ["types/**", "bun.lock", "**/*.md"],
    semi: true,
    singleQuote: false,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: ["types/**"],
    // Type-aware rules only: tsc (`bun run typecheck`, types-current.sh) is the type-check.
    options: {
      typeAware: true,
    },
  },
  staged: {
    "*.{ts,js,json}": "vp check --fix",
  },
});

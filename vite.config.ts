// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

// Vite+ drives lint (Oxlint) and format (Oxfmt) only: tests stay plain Bun scripts and nothing is
// bundled. tsc is the only type-check, since it also emits dist/.
export default defineConfig({
  fmt: {
    // dist/ is tsc output, diffed byte for byte by scripts/dist-current.sh: never reformat it.
    // Markdown is left to editors: the macOS and Linux oxfmt binaries disagree on the final newline.
    ignorePatterns: ["dist/**", "bun.lock", "**/*.md"],
    semi: true,
    singleQuote: false,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: ["dist/**"],
    // Type-aware rules only: tsc (`bun run typecheck`, dist-current.sh) is the type-check.
    options: {
      typeAware: true,
    },
  },
  staged: {
    "*.{ts,js,json}": "vp check --fix",
  },
});

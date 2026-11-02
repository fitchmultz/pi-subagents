# Code quality

Oxlint checks maintained TypeScript and JavaScript. Oxfmt owns formatting.
Both tools use the committed npm versions and repository configuration.

```sh
npm ci --ignore-scripts
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run typecheck
npm run ci
```

Lint rejects unsafe types, unchecked assertions, floating promises, accidental
mutation, import cycles and ambiguous control flow. Application readonly types
remain checked by TypeScript. `typescript/prefer-readonly-parameter-types` is
disabled: the published backend cannot express the existing native SDK aliases
with package-scoped allowances. The project does not patch the checker or add
production wrappers to satisfy that rule.

Production limits are complexity 10, depth 3, parameters 4, statements 40,
function lines 80 and file lines 500, excluding blank lines and comments.
Tests retain complexity 15, depth 4 and parameters 6. Cohesive test suites have
no size or statement limits.

Formatting uses width 100, two spaces, LF and double quotes. npm owns lockfile
formatting. Build outputs keep their own bytes.
The VS Code Oxc extension uses these same lint and formatting configurations.

`npm run ci` runs lint, formatting, TypeScript, package/install smokes and all
tests. CI separately qualifies the latest official Pi on GitHub-hosted Linux and
the maintained fork on Linux and macOS. There is no custom checker build, probe
suite or self-hosted runner requirement.

CI's lint job also enforces the production byte ceiling before qualification
substitutes the selected host graph. The retired workflow schema generator and
its patching dependency are not part of the new runtime. `npm run check:size`
still reports source and production line counts for visibility; no line count
is mandated. The 1 MiB byte ceiling and all lint limits stay unchanged.

## Adoption record

Repository: `fitchmultz/pi-subagents`. Adopted standard: strict Oxlint/Oxfmt
engineering standard v5.1.2, kept as the repository copy at
`docs/strict-oxlint-oxfmt-standard.md`. Exception records live in
[Quality exceptions](quality-exceptions.md) and follow the standard's Appendix B.

Supported runtime and package manager: Node `>=24.21.0` with npm and the
committed lockfile. Installed tool versions (devDependencies): oxlint 1.90.0,
oxlint-tsgolint 7.0.2005, oxfmt 0.75.0, `@types/node` 24.19.2, typebox 1.4.3.

Configuration and acceptance paths: lint `.oxlintrc.json`, formatting
`.oxfmtrc.json`, compiler `tsconfig.json`. Local acceptance commands are
`npm run lint`, `npm run format:check` and `npm run typecheck`; the aggregate
acceptance command is hosted `npm run ci` (lint, formatting, TypeScript, byte
ceiling, package/install smokes and the complete test suites, plus separate
official-Pi and fork qualification jobs).

Compiler projects and source profiles: one `tsc --noEmit` project covers all
maintained TypeScript and checked-JavaScript (`src`, `scripts`, `test`,
`.github`) with `strict`, `checkJs`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and the full strict flag set. Lint profiles:
production limits (complexity 10, depth 3, parameters 4, statements 40,
function lines 80, file lines 500), test/fixture limits (complexity 15, depth
4, parameters 6, no size limits) and declaration files with size limits off.

Formatter and generator ownership: oxfmt formats all maintained source at
width 100; npm owns lockfile formatting; build outputs keep their own bytes.

Migration status: complete. The toolchain, baseline configuration, strict
TypeScript compiler options, checked-JavaScript coverage and this records
policy landed as PRs #319, #320, #321, #325 and the records PR; the policy
integrity keeper `test/unit/strict-oxlint-policy.test.ts` pins the effective
configuration, the four-entry overrides inventory and the directive rule-name
inventory against drift.

Integrated verification: hosted `npm run ci` on the merge of each part, with
the single-agent-runtime, agent-receipts, pi-intercom-native-replay and
retired-history-archive keepers exercising the native contracts. Locally
verified state for the checked-JavaScript part is recorded in PR #325; the
retired-history-archive suite requires passwordless `sudo` and
`scripts/package-smoke.mjs` requires a short Unix socket directory, so hosted
CI is the authoritative gate for both.

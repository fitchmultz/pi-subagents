# Code quality

Correctness, maintainability and trustworthy enforcement are independent requirements. Oxlint owns
quality; Oxfmt owns formatting. TypeScript, builds, native tests and code review remain separate gates.

## Commands

Use Node 24.21+ and the committed npm lockfile. A clean install deliberately does not depend on npm
lifecycle hooks:

```sh
npm ci --ignore-scripts
npm run quality:setup
npm run quality:scope -- --write # after adding/removing code or changing checkJs; review and commit
npm run lint
npm run lint:agent
npm run lint:fix                # safe fixes only; inspect behavior changes
npm run format
npm run ci
npm run quality:sabotage        # clean integrated revision; full baseline CI then five negative controls
```

Each quality executable supports `-h`/`--help`. Unknown arguments and child failures are errors.
`quality` composes engine setup, generated-schema freshness, scope/configuration/suppression policy,
installed-CLI probes, lint, formatting, root TypeScript 7 checking and effective leaf-project checking.
`ci` adds the build and the existing package/install smokes and complete test suites. CI qualifies
actual official Pi and fork installations separately; equal version strings are not runtime proof.

## Coverage

The scope owner is `scripts/quality-scope.mjs`. Its inventory is Git-maintained code, including new
untracked files not ignored by Git. Build-owned `dist` and `dist.staging*` outputs are excluded;
node_modules and local ignored runtime/scratch directories are not maintained source. Every maintained
TS/JS file belongs to a compiler/type-resolution project. Root and effective leaf projects must retain
`strict` and `noImplicitReturns`; maintained leaf projects may not use `noCheck`.

TypeScript, effective inherited `checkJs: true` JavaScript and leading `@ts-check` files retain semantic
lint. Other JavaScript retains nonsemantic lint, Promise/import/control-flow rules, formatting and
applicable tests, and remains available to checked consumers for type resolution. The final JSON
override contains exact unchecked-JS paths and disables rules classified type-aware by the **installed
Oxlint metadata**, not by namespace. A stale inventory fails policy until regenerated. Tests and helper
roles are independent of language scope. Compiler diagnostics are tested independently of lint.

Normal lint, fixes, agent output, CI and the editor all use this same root configuration. VS Code uses
the Oxc extension and its supported `oxc.path.tsgolint` setting to select the corrected repository
engine. Run `quality:setup` before starting the editor language server; reload it after patch updates.
The canonical TypeScript command remains `npm run typecheck`; `typecheck:leaves` additionally checks
maintained nested projects using their effective settings.

The root `.oxlintrc.json` is the only approved lint configuration. Policy rejects alternative root
and nested auto-discovery names supported by the pinned CLI (`.oxlintrc.json[c]`,
`oxlint.config.ts`, `oxlint.config.mts`), including ignored configurations beside maintained source.
This prevents silent rule weakening in both CLI and editor discovery; CODEOWNERS covers these paths.

## Production and test contracts

Production limits are modified complexity 10, depth 3, parameters 4, statements 40, function lines 80
and file lines 500 (blank lines and comments excluded). Tests, `test/support` and `test/fixtures` retain
complexity 15, depth 4 and parameters 6, while cohesive suites have no size/statement limits. Declaration
files retain API/safety checks with structural metrics exempt. Native tool/RPC boundary modules alone
retain their required external arity; application-owned operations still use ordinary limits.

Application inputs must be readonly-compatible. Native/SDK permissions use actual package/library/file
origins and CLI isolation probes. They do not freeze native objects or certify every reachable value.
There are no blanket Map/Set/Record/Readonly permissions in the root rule. Raw `ReadonlyMap` and
`ReadonlySet` still allow method reassignment; use `Readonly<ReadonlyMap<K, ReadonlyValue>>` and
`Readonly<ReadonlySet<T>>` when the input contract also prohibits method replacement. Mutable native
containers and mutable contained values remain detectable through the patched engine.

`mutationBoundaries` in `scripts/quality-boundaries.mjs` is the compact canonical record of approved
state/lifecycle owners. `quality:scope --write` materializes exact-file overrides, retaining the complete
native base allowance list (Oxlint replaces rule option arrays). These permissions are not available to
pure readers: use readonly views instead. Owner-specific parameter-property permissions name actual
parameters; other parameters and ordinary mutable data remain checked. Change the registry, not copied
JSON blocks. Policy verifies regeneration and probes origin, file and parameter isolation.
Every boundary file and file-qualified readonly origin must exist, and every allowed name must
identify an actual class, interface or type-alias declaration in that origin. The CLI keeper also
copies and exercises the real runner declaration; synthetic isolation shapes alone do not prove that
an owner path is correct.

Only fixed **nongeneric** native result/message aliases can receive local file-qualified permissions;
mutable application type arguments are not waived through broad generic SDK names. Framework-owned
node:test registration uses the actual `@types/node/test.d.ts` declarations `test`/`suite`. Ordinary async
calls, local shadows, copied callable types, other packages/files and unawaited `t.test()` remain errors.
Native Promise/PromiseLike readonly input permission is never safe-Promise permission.

## Suppressions and narrow semantic exceptions

Use native, single-rule `oxlint-disable-next-line` comments with a specific immediately preceding
explanation. The AST-based policy ignores strings, regexes, templates and documentation text; blanket,
ESLint-style, unapproved and unexplained suppressions fail. Unused native directives are errors.

Already-authorized single-site classes are required sequencing, intentional control-character
validation, necessary post-await lifecycle guards and a reproduced plain generic callback-result
readonly limitation. Preserve real callback results and interruption tests; do not invent purity or
fake `Readonly<T>` results. No floating-Promise suppression is permitted.

Additional user-approved exceptions are confined to their actual boundary syntax:

- Noncallable JSONSchema `then` data in the exact handwritten schema/report modules.
- Optional native event-bus unsubscribe `void | (() => void)` in the two retained slash adapters.
- Five explicitly typed selected-host SDK namespace loads in native-session/typebox/tui adapters.
  Their computed native URLs preserve actual Node/Jiti host identity; arbitrary assignments, other
  declarations, wrong namespaces and untyped loads remain forbidden. Remove the exception when loader
  declaration identity is preserved and the native qualification probes pass.

Explicit `undefined` arguments are retained only in demonstrated argument-presence/negative-input test
files via `checkArguments: false`; other unnecessary forms remain checked. `@ts-ignore` and `@ts-nocheck`
are forbidden. Described `@ts-expect-error` belongs only in dedicated `.test-d.ts` compiler-negative cases.
Additional relaxations need an exact diagnostic, real contract, narrow scope and positive/negative proof.
CODEOWNERS routes enforcement changes to the repository owner; branch protection remains repository
administration, not a replacement for these executable checks.

## Engines, formatting and generation

Pinned Oxlint/Oxfmt and TypeScript 7 are npm-owned. The separate pinned TypeScript 6 API alias supplies
AST/config APIs absent from TypeScript 7; it is not the compiler gate. Compiler scripts and probes call
`node_modules/typescript/bin/tsc` explicitly: the API alias also advertises `tsc`, so the shared npm bin
shim cannot identify the intended compiler reliably after every install. The native engine recipe, upstream
pins, patches, cache hashes, supported platforms and clean-install evidence are in
[quality-engine.md](quality-engine.md). Never hand-edit installed dependencies. The installer rebuilds
when any patch hash changes and all invocation surfaces use that same cache.

Oxfmt owns supported maintained files with width 100, two spaces, LF, double quotes and no optional
sorting/JSDoc rewriting. npm owns package-lock formatting; generators own schema bytes and build output.
`generate:schemas` regenerates canonical run-contract validators and `check:schemas` verifies freshness.
Unified Go patches are byte-sensitive; only those artifact paths have Git whitespace-context exceptions.
Do not pack code onto fewer lines, move implementation into fixtures, or change snapshots/assertions to
make metrics pass. Review fixes, formatting idempotence and lint/format convergence.

## Verification and reporting

`test/quality/*.test.mjs` invokes the installed native CLI against disposable projects. Expected rule IDs,
locations, positive boundaries and failure statuses are independent of the checker. Fixtures are strings
materialized outside normal compilation. Tests cover language opt-in, inherited projects, compiler-only
errors, production/test limits, rule options, comment directives, native declarations, safe-call and
mutation-owner isolation, and native-container contents/method ownership.

`quality:sabotage` starts from a clean committed integrated revision, runs baseline **real `npm run ci`**,
then injects a syntactic lint violation, semantic violation, compiler error, formatting error and wrong
existing safe-call declaration path into a disposable detached worktree. It requires the intended error,
retains logs in the OS temporary directory and removes its own worktree without touching other work.
A failing baseline is not successful sabotage proof: finish integrated source cleanup first.

Report configuration-only changes, checker-integrity corrections, formatting, maintainability changes,
fixture repairs and actual runtime bug fixes separately. Include the exact commands/results and any
unperformed integrated/native qualification. Lower diagnostic counts alone do not establish runtime bug
fixes or completion. The complete integrated acceptance workflow must pass with zero errors/warnings.

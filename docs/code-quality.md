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
lint, formatting, root TypeScript 7 checking, effective leaf-project checking and installed-CLI probes.
Static gates run before the expensive native probes so invalid inputs fail promptly; passing acceptance
still requires every probe. `ci` adds the build, package/install smokes and complete test suites.
CI qualifies actual official Pi and fork installations separately; equal version strings are not runtime
proof.

### Acceptance budgets and process ownership

The full acceptance stages are sequential: cold quality (15 minutes), build and install/package
smokes (5), unit tests (5), integration tests (15), then owner settlement (1). The outer CI command
therefore has a 41-minute budget. Compatibility qualification adds editor cloning (5), installation
(5), metadata checks (1), native smoke (5) and settlement (1), for 58 minutes. The host job reserves
120 minutes for that qualification, host/development preparation, production installs and fork/tooling
work. Unit (300000 ms), integration (900000 ms), individual-test and process-cleanup (10 seconds)
limits remain independent; an ancestor timeout must not cut off a permitted child stage.

`scripts/compat-process.mjs` owns commands and private receipt lifetimes. A genuine fork/IPC session
guardian acknowledges cancellation before observation, reserves the command's SID during cleanup and
publishes settlement only after WORK quiesces. Linux uses procfs identities and exact environment
receipts; macOS uses bounded Koffi public-SDK queries for native birth/UID/SID and environment bytes.
Each native query runs in one preemptible same-session child and is reaped on timeout. Streaming output
is decoded across pipe chunks without changing forwarded bytes or caller descriptors.

PID, native birth and UID are revalidated before signalling. Arguments, executable names, role-shaped
metadata and filesystem receipts alone never authorize a signal. Root deletion waits for actual
quiescence and settled guardian lifetimes; observation uncertainty or lost settlement retains the
private roots and propagates `cleanupFailed`, rather than concealing the original command failure.
Nested cleanup defers only current authenticated enclosures whose guardian published its rescue phase
before launching cleanup queries. Connected nested WORK remains signalable, and its original command
owner performs normal cleanup/release. The phase is not quiescence proof: pending lifetimes still need
settlement and actual exit. Even NO-WORK disconnects authenticate the actual native incarnation and
immutable fork metadata before settlement; existing receipts enter rescue phase before that query.
Mismatched metadata retains the live reservation and private roots. Ordinary WORK cannot exempt itself
by copying the guardian directory or baseline hash.

On Linux and macOS, the original pre-WORK native cut is digest-bound to the live guardian. Linux
uses the kernel's actual effective UID, not proc-directory ownership (which can change for non-dumpable
processes). Stable same-UID denied environments are opaque, not signal authority; other native errors
and unstable incarnations remain uncertainties. Unknown opaque work
with neither an exact pre-WORK birth nor a still-reserved foreign SID vetoes success without being
signalled. Exact OWNER entries outside a trustworthy environment boundary also veto success; they are
not argv-based ownership. This is not an adversarial sandbox. An intentional new session with erased
OWNER, a changed UID or an established foreign service boundary requires stronger OS containment.
The keeper isolates its destructive fixtures from inherited receipt placement while retaining enclosing
OWNER tokens, and verifies both ordinary and genuinely nested execution.

Keeper publication registers WORK and nested guardians before assertions. An early fixture failure
still completes the healthy owner's actual stop/release after gates open and command return; a lost
guardian is not settlement, so uncertain receipt roots remain diagnostic evidence. Teardown attempts
all registered fixture reaping, collects failures and reports them once without replacing the original
error; without an unconsumed original failure, cleanup errors fail the row. Darwin fallback observes
the stopped guardian before discovering live authenticated query consumers; protected WORK and exited
children do not grant query signal authority. Receipt-root removal assertions first prove the actual
nonempty root exists, and nested return witnesses bind to that same root. Native query children are
birth/UID-bound and reaped before any manual removal of a proven settled root.

Darwin protected-environment omission depends on the actual host and observer privileges, not an
Apple binary pathname. Local keeper passes do not qualify a remote runner's omission behavior.
Qualification must preserve the protected argv-alignment/empty-argv expectations and independently
establish native OWNER omission; a host exposing that environment requires provisioning, not weaker
expectations, erased OWNER, synthetic bytes or changed cleanup deadlines.

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
File-qualified type aliases must be nongeneric, so an approved fixed native alias cannot silently
become permission for arbitrary mutable application type arguments.

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
- Five explicitly typed selected-host SDK namespace loads in native-session-loader/typebox/tui adapters (the session loader is lazy and accepts an explicitly pinned trusted host).
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

### Responsibility boundaries

The strict cleanup separates responsibilities, not just file lengths:

| Before                                                                                          | Current owner boundary                                                                                                                                                  | Preserved contract                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The detached runner mixed process controls, step execution, status, acceptance and publication. | `RunnerLifecycle` owns cancellation and cleanup; `RunnerMonitor` owns status; `RunnerWorkflow` executes the plan; `completeRunner` publishes finalized evidence.        | Ordered steps, bounded concurrency, sibling evidence, durable completion and process-tree cleanup.                         |
| Foreground execution mixed management commands, preparation, launch and waiting.                | `ForegroundExecutor` prepares one request and selects `ManagementActions` or `InvocationExecution`; the wait owner separately registers, observes and settles receipts. | An accepted launch is not undone by a wait failure; cancellation and supervisor handoff remain distinct.                   |
| History ingestion, querying, watching and IPC shared large implementations.                     | The worker owns admission and background work; source ingestion owns its descriptor/transaction; query modules own paging and selection; IPC validates both directions. | Native journal publication, owner isolation, bounded selected records, cursor freshness and read-only authoritative files. |
| Agents UI forwarded operations through the controller and shared writable task objects.         | The task store owns cache updates; browser and controls expose focused bound ports; conversation components receive readonly observations.                              | Drafts, unread state, paging, native clicks, full metadata and session-generation guards.                                  |
| Parent and child runtimes duplicated final-result adaptation and reload cleanup.                | Shared adapters perform the native result copy once; each runtime owns its reset, subscriptions and shutdown.                                                           | Native usage accounting, persisted notices, reload recovery and joining parent reset before disposal.                      |

The application executor now accepts one named request object, with its callers migrated together.
Native Pi callbacks retain their required SDK signatures. Existing public compatibility exports remain;
new private helpers are not exported merely to move lines or enable tests.

`test/quality/*.test.mjs` invokes the installed native CLI against disposable projects. Expected rule IDs,
locations, positive boundaries and failure statuses are independent of the checker. Fixtures are strings
materialized outside normal compilation. Tests cover language opt-in, inherited projects, compiler-only
errors, production/test limits, rule options, comment directives, native declarations, safe-call and
mutation-owner isolation, and native-container contents/method ownership.

`quality:sabotage` starts from a clean committed integrated revision, installs its own lockfile-resolved
dependencies in a disposable detached worktree, runs baseline **real `npm run ci`**,
then injects a syntactic lint violation, semantic violation, compiler error, formatting error and wrong
existing safe-call declaration path in the isolated installed-CLI probe. Production policy stays intact
for that last control, so static checks cannot preempt the intended allowance-isolation failure.
It requires the intended error, retains logs in the OS temporary directory and removes its own worktree
without touching other work. A failing baseline is not successful sabotage proof: finish integrated
source cleanup first.

Report configuration-only changes, checker-integrity corrections, formatting, maintainability changes,
fixture repairs and actual runtime bug fixes separately. Include the exact commands/results and any
unperformed integrated/native qualification. Lower diagnostic counts alone do not establish runtime bug
fixes or completion. The complete integrated acceptance workflow must pass with zero errors/warnings.

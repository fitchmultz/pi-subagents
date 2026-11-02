# Quality exceptions

Records follow the repository copy of the strict Oxlint/Oxfmt engineering
standard (`docs/strict-oxlint-oxfmt-standard.md`). Every exception cites its
evidence here; the standard's Section 2 defines eligibility and scope.

## QX-001 Unawaited node:test registrations

ID and title: QX-001 — unawaited `node:test` registrations under distinct
local import names.

Rule, option, or threshold; installed tool versions:
`typescript/no-floating-promises` → `allowForKnownSafeCalls`; oxlint 1.90.0,
oxlint-tsgolint 7.0.2005, `@types/node` 24.19.2.

Scope: files, authorized operations, origins, or bounded pattern: test
registrations imported from `node:test` and invoked unawaited, anywhere in
`test/**`. The allowance entry is
`{"from": "package", "package": "node:test", "name": ["nodeTest", "nodeIt", "nodeDescribe"]}`;
the repository imports every registration form under exactly those distinct
local names (`test as nodeTest`, `it as nodeIt`, `describe as nodeDescribe`).

Directive selectors/inventory and optional duplication bounds: none; the
allowance is configuration-owned, so no site directives exist to inventory.

Diagnostic and required contract: `node:test`'s `test()`, `it()`, `describe()`
and `suite()` return `Promise<void>` while the Node test runner owns their
scheduling. Standard Section 6.4 records that awaiting a registration can
alter module evaluation and hook timing, and prohibits mass conversion of
registrations into awaited calls, async suites or Promise collections. The
intended usage — unawaited module-level and suite-body registrations — is
therefore a genuine diagnostic whose prescribed change is inappropriate for
the runner's contract.

Actual compliant alternative and demonstrated quality cost: awaiting all
~425 registration calls (prohibited scheduling change), prefixing each with
`void` (~425 no-op markers that Section 3.3 rejects as lint-only ceremony), or
per-site next-line directives (~425 directives whose bounded inventory would
be unmanageable). Each alternative adds mechanical noise to every test file
without changing what the runner executes.

Chosen adjustment and why its scope is appropriate: the package-origin
safe-call allowance with distinct local names is the narrowest native option.
It admits only calls whose declaration originates from the `node:test`
package under the three enumerated names. The previous repository entry
matched declaration names `test`/`suite` from `@types/node/test.d.ts` and also
admitted unawaited `TestContext.test()` subtests; the package-origin form with
non-default local names closes that boundary while keeping every intended
registration form passing.

Structural comparison or unsafe-type evidence, where applicable: not a
structural or unsafe-type exception.

Verification commands, relevant tests, and results:
`node --test test/unit/lint-node-test-allowance.test.ts` runs the standard's
six controls with the repository configuration: intended unawaited top-level
and suite-body registrations pass for each form used; an unawaited context
subtest (`t.test()`), an unawaited same-named local function, an unawaited
same-named function imported from another module, a floating promise inside a
test body, and an unawaited unrelated promise call each still fail with
`typescript/no-floating-promises` at the exact site. `npm run lint` passes on
the migrated tree (oxlint 1.90.0, macOS arm64 and hosted Linux CI).

Retained protection, lost detection, and established assumptions: wrong-name,
wrong-origin and in-body floating promises remain checked by the rule at
`error` with `ignoreVoid: false` and `checkThenables: true`. Known detection
limit, recorded per Section 6.4: declaration-origin matching cannot see
runtime calling context, so an imported registration invoked inside a running
test would create an unawaited subtest that the allowance also admits. The
repository creates subtests only through awaited `t.test()` context calls
(19 sites; zero registrations appear nested inside test bodies), and new
subtests inside tests must keep using awaited context methods.

Review and revisit trigger: an oxlint or oxlint-tsgolint release that changes
allowance matching, a new `node:test` import form or registration name in the
repository, or a Node test-runner change to registration scheduling. Each
trigger reruns the six controls.

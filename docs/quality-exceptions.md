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

## QX-002 Five-parameter Pi tool executor callback

ID and title: QX-002 — the `intercom` tool's `execute` callback needs five
positional parameters.

Rule, option, or threshold; installed tool versions: `max-params`
(base `max: 4`); oxlint 1.90.0, oxlint-tsgolint 7.0.2005.

Scope: files, authorized operations, origins, or bounded pattern: one
callback, `src/pi-intercom/tool-registration.ts` (`registerIntercomTools`'s
`pi.registerTool` `execute`).

Directive selectors/inventory and optional duplication bounds: one
`// oxlint-disable-next-line max-params` directive at that callback; the
repository's full directive inventory is QX-002 (1) plus QX-003 (3).

Diagnostic and required contract: the Pi SDK's tool executor interface
declares `execute(id, params, signal, update, ctx)` positionally; the
callback must accept the fifth `ctx` parameter to receive the extension
context it forwards to `tools.execute`. Dropping earlier parameters is not
possible because the signature is positional.

Actual compliant alternative and demonstrated quality cost: the previous
file-scoped override raised `max-params` to 5 for the entire file, including
future helpers that could legitimately grow past four parameters without a
platform contract; a rest/destructuring signature is not available for a
positional interface implementation.

Chosen adjustment and why its scope is appropriate: the single next-line
directive marks exactly the callback whose arity the Pi SDK fixes, restoring
the base `max: 4` check for every other signature in the file.

Structural comparison or unsafe-type evidence, where applicable: not a
structural or unsafe-type exception.

Verification commands, relevant tests, and results: `npm run lint` passes
with the directive in place and the file override removed; removing the
directive reproduces the `max-params` error at the callback (oxlint 1.90.0,
macOS arm64).

Retained protection, lost detection, and established assumptions: every
other function in the file and repository remains capped at four parameters;
a future sixth executor parameter from the Pi SDK requires updating the
directive and this record.

Review and revisit trigger: a Pi SDK release changing the tool executor
arity, or the callback moving to another file.

## QX-003 Native event and request objects the handler owns

ID and title: QX-003 — the native execution-cwd owner mutates the
`before_agent_start` prompt draft, the `tool_call` input, and the
execution-cwd request result.

Rule, option, or threshold; installed tool versions: `no-param-reassign`
(base `props: true`, empty ignore lists); oxlint 1.90.0,
oxlint-tsgolint 7.0.2005.

Scope: files, authorized operations, origins, or bounded pattern: three
assignments in `test/fixtures/native-execution-cwd-owner.ts`:
`event.systemPromptOptions.cwd` in `before_agent_start`, `event.input.path`
in `tool_call`, and `request.result` in the `pi-change-working-dir`
execution-cwd event handler.

Directive selectors/inventory and optional duplication bounds: three
`// oxlint-disable-next-line no-param-reassign` directives, one per
assignment, each beneath the comment stating the owning contract; the
repository's full directive inventory is QX-002 (1) plus QX-003 (3).

Diagnostic and required contract: the native extension contract makes these
objects the handler's to mutate — `before_agent_start` publishes a mutable
structured prompt draft the handler edits, `tool_call` permits the registered
directory owner to resolve the read tool's input path, and the
`pi-change-working-dir` event bus protocol requires the owner to fill
`request.result`. The fixture exists to exercise exactly those ownership
paths against real native events.

Actual compliant alternative and demonstrated quality cost: the previous
file-scoped override set `ignorePropertyModificationsFor: ["event",
"request"]`, which would admit any future param mutation anywhere in the
fixture; copying the objects first would break the contracts being tested
(the broker and host observe the same objects).

Chosen adjustment and why its scope is appropriate: per-assignment directives
mark exactly the three ownership mutations the native contracts define,
keeping the rule active for every other parameter in the fixture.

Structural comparison or unsafe-type evidence, where applicable: not a
structural or unsafe-type exception.

Verification commands, relevant tests, and results: `npm run lint` passes
with the directives in place and the file override removed; removing any
directive reproduces the `no-param-reassign` error at that assignment
(oxlint 1.90.0, macOS arm64).

Retained protection, lost detection, and established assumptions: every
other parameter property in the fixture remains protected; a fourth native
ownership path requires a new directive and a record update.

Review and revisit trigger: a Pi SDK change to these event contracts, or the
fixture moving to another file.
